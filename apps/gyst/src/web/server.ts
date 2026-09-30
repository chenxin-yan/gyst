import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  BadArgs,
  BrowserRequestSchema,
  type DaemonError,
  InternalError,
  ReplySchema,
} from "@gyst/core";
import { ByteSize, Clock, Effect, Schema } from "effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../daemon/client.ts";
import {
  authCookie,
  hasAuthCookie,
  isBootstrap,
  isLaunchHost,
  isSameOrigin,
  type Launch,
} from "./auth.ts";
import { webPaths } from "@gyst/core/web";

/** The packaged SPA (`dist/web-ui`) beside the bundled `bin/gyst.js`; never the cwd or checkout. */
export const installedWebUiDir = fileURLToPath(new URL("../dist/web-ui", import.meta.url));

type WebAsset = { readonly body: Uint8Array; readonly contentType: string };
/** Packaged files by exact URL path; nothing else on disk is reachable from a request. */
export type WebAssets = ReadonlyMap<string, WebAsset>;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Reads every regular file of the packaged SPA into memory once, so requests map only to this
 * fixed set: symlinks, traversal and encoded separators have nothing to resolve against.
 * ponytail: whole bundle in memory; stream from disk if the SPA grows past a few MB.
 */
export const loadWebAssets = (dir: string) =>
  Effect.tryPromise({
    try: async (): Promise<WebAssets> => {
      const assets = new Map<string, WebAsset>();
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = join(entry.parentPath, entry.name);
        assets.set(`/${relative(dir, file).split(sep).join("/")}`, {
          body: await readFile(file),
          contentType: contentTypes[extname(file)] ?? "application/octet-stream",
        });
      }
      if (!assets.has("/index.html")) throw new Error(`${join(dir, "index.html")} is missing`);
      return assets;
    },
    catch: (cause) =>
      new InternalError({
        message: "the gyst web UI is not installed; reinstall @gyst/cli",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

// Browser operations are a few hundred bytes; anything larger is not one.
const maxOperationBytes = ByteSize.kilobytes(64);
const decodeOperation = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserRequestSchema), {
  onExcessProperty: "error",
});
const encodeReply = Schema.encodeSync(ReplySchema);

const securityHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const status = (code: number, headers: Record<string, string> = {}) =>
  HttpServerResponse.empty({ status: code, headers: { ...securityHeaders, ...headers } });
const asset = ({ body, contentType }: WebAsset) =>
  HttpServerResponse.uint8Array(body, { contentType, headers: securityHeaders });
const reply = (code: number, body: typeof ReplySchema.Type) =>
  HttpServerResponse.text(JSON.stringify(encodeReply(body)), {
    status: code,
    contentType: "application/json",
    headers: securityHeaders,
  });

const isForwarding = (name: string) => name === "forwarded" || name.startsWith("x-forwarded-");
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

const operation = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const text = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxOperationBytes),
    Effect.option,
  );
  if (text._tag === "None")
    return reply(400, { ok: false, error: new BadArgs({ message: "unreadable request body" }) });
  const input = yield* decodeOperation(text.value).pipe(Effect.option);
  if (input._tag === "None")
    return reply(400, {
      ok: false,
      error: new BadArgs({ message: "expected one browser operation as JSON" }),
    });
  const client = yield* DaemonClient;
  return yield* client.request(input.value).pipe(
    Effect.map((value) => reply(200, { ok: true, value })),
    Effect.catch((error: DaemonError) =>
      Effect.succeed(reply(error._tag === "daemon_unreachable" ? 503 : 200, { ok: false, error })),
    ),
  );
});

/**
 * One launch's HTTP surface. Every request needs this launch's exact `Host`; POSTs also need a
 * matching `Origin`. The bootstrap exchanges the fragment secret for the host-only auth cookie,
 * and operations are strict `BrowserRequest`s forwarded unchanged to the daemon, whose `Reply` is
 * returned as is. Everything else is the packaged SPA: exact files, then the shell for client
 * routes, while `/api`, `/bootstrap` and `/assets` misses stay real errors.
 */
export const browserApp = (launch: Launch, assets: WebAssets) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const raw = NodeHttpServerRequest.toIncomingMessage(request).rawHeaders;
    const names = raw.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    /** The value of a header sent exactly once; a missing or repeated header is undefined. */
    const single = (name: string) => {
      const indexes = names.flatMap((header, index) => (header === name ? [index] : []));
      return indexes.length === 1 ? raw[indexes[0]! * 2 + 1] : undefined;
    };

    const host = single("host");
    if (!isLaunchHost(launch, host) || names.some(isForwarding)) return status(403);
    // The raw target is checked, not a URL-normalized one: normalization would silently resolve
    // dot segments and backslashes. Only origin-form paths without them are routed.
    const path = request.url.split("?", 1)[0]!;
    if (!path.startsWith("/") || path.startsWith("//") || /\\|%2f|%5c/i.test(path))
      return status(400);
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return status(400);
    }
    if (decoded.split("/").some((segment) => segment === "." || segment === ".."))
      return status(400);

    if (path === webPaths.bootstrap || path === webPaths.operation) {
      if (request.method !== "POST") return status(405, { allow: "POST" });
      if (!isSameOrigin(host, single("origin"))) return status(403);
      if (path === webPaths.bootstrap)
        return isBootstrap(launch, single("authorization"), yield* Clock.currentTimeMillis)
          ? status(204, { "set-cookie": authCookie(launch) })
          : status(401);
      // Authenticate before reading the body.
      if (!hasAuthCookie(launch, request.headers.cookie)) return status(401);
      return yield* operation;
    }
    if (under(decoded, "/api") || under(decoded, "/bootstrap")) return status(404);
    if (request.method !== "GET" && request.method !== "HEAD")
      return status(405, { allow: "GET, HEAD" });
    const file = assets.get(path);
    if (file !== undefined) return asset(file);
    if (under(decoded, "/assets")) return status(404);
    return asset(assets.get("/index.html")!);
  });
