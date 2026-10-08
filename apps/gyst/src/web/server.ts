import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  BadArgs,
  type BrowserRequest,
  BrowserRequestSchema,
  type DaemonError,
  DaemonUnreachable,
  InternalError,
  ReplySchema,
  type SubscribeRequest,
  SubscribeRequestSchema,
  type SubscriptionEvent,
  SubscriptionEventSchema,
} from "@gyst/core";
import { ByteSize, Config, Context, Effect, Exit, Schema, Scope, Stream } from "effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { webPaths } from "@gyst/core/web";

/** The packaged SPA (`dist/web-ui`) beside the bundled `bin/gyst.js`; never the cwd or checkout. */
export const installedWebUiDir = fileURLToPath(new URL("../dist/web-ui", import.meta.url));

/** Where the daemon reads the SPA it serves: the packaged one, unless a test supplies its own. */
export const WebUiDir = Context.Reference<string>("gyst/web/WebUiDir", {
  defaultValue: () => installedWebUiDir,
});

/** The first port the viewer tries ("gyst" on a phone keypad); `GYST_PORT` moves the range. */
export const defaultViewerPort = 4978;
/** How many consecutive ports the viewer tries, from the first. */
export const viewerPortCount = 10;
/** Read when the daemon starts; an invalid value fails each open, which names the problem. */
export const firstViewerPort = Config.Port("GYST_PORT").pipe(
  Config.withDefault(defaultViewerPort),
  Effect.mapError(
    (error) =>
      new DaemonUnreachable({
        message: "GYST_PORT must be a port number from 1 to 65535",
        detail: error.message,
      }),
  ),
);

/** A session's viewer link; `localhost`, which browsers and SSH forwards resolve to loopback. */
export const viewerLink = (port: number, sessionId: string) =>
  `http://localhost:${port}/session/${encodeURIComponent(sessionId)}`;

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

/**
 * The packaged SPA, or when it is missing a shell that says so: the daemon still serves the CLI and
 * the browser operations, and a link opened meanwhile explains itself.
 */
export const webAssetsOrNotice = (dir: string) =>
  loadWebAssets(dir).pipe(
    Effect.catch((error) =>
      Effect.succeed<WebAssets>(
        new Map([
          [
            "/index.html",
            {
              body: new TextEncoder().encode(`<!doctype html><p>${error.message}.</p>\n`),
              contentType: contentTypes[".html"]!,
            },
          ],
        ]),
      ),
    ),
  );

// Bounds a hostile body, not a review: a Viewed request names its hunk ids explicitly (~19 bytes
// each in JSON), so 16 MiB admits roughly 800,000 hunks in one atomic write.
const maxOperationBytes = ByteSize.mebibytes(16);
const decodeOperation = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowserRequestSchema), {
  onExcessProperty: "error",
});
const encodeReply = Schema.encodeSync(ReplySchema);
const decodeSubscribe = Schema.decodeUnknownEffect(Schema.fromJsonString(SubscribeRequestSchema), {
  onExcessProperty: "error",
});
const encodeEvent = Schema.encodeSync(SubscriptionEventSchema);
const eventFrame = (event: SubscriptionEvent) => `data: ${JSON.stringify(encodeEvent(event))}\n\n`;

// The viewer loads only its own scripts and talks only to the daemon; nothing an agent wrote can
// make the page fetch, however a renderer handles it. Styles stay inline-capable because Mermaid's
// SVG carries its theme in a <style>, and the diff renderer styles its shadow roots with <style>
// elements; images are only the `data:` favicon.
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data:",
  "connect-src 'self'",
].join("; ");

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": contentSecurityPolicy,
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

/**
 * `Host` must be a loopback name, on any valid port: behind an SSH forward the browser-visible port
 * is the forward's, not the daemon's. Any other name, including one an attacker's DNS resolves to
 * 127.0.0.1, is refused, which stops DNS rebinding.
 */
export const isLoopbackHost = (host: string | undefined): host is string => {
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/.exec(host ?? "");
  return match !== null && Number(match[1] ?? 80) <= 65_535;
};

/** A browser POST's serialized `Origin` must be exactly this request's already-validated `Host`. */
export const isSameOrigin = (host: string, origin: string | undefined) =>
  origin === `http://${host}`;

/** What the browser's operations and subscriptions reach: the daemon's own review operations. */
export type ViewerOperations = {
  readonly operation: (request: BrowserRequest) => Effect.Effect<unknown, DaemonError>;
  /** `ready` first, then committed changes; the stream ends when the subscription does. */
  readonly subscribe: (request: SubscribeRequest) => Stream.Stream<SubscriptionEvent, DaemonError>;
};

const readBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  return yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxOperationBytes),
    Effect.option,
  );
});

const operation = (operations: ViewerOperations) =>
  Effect.gen(function* () {
    const text = yield* readBody;
    if (text._tag === "None")
      return reply(400, { ok: false, error: new BadArgs({ message: "unreadable request body" }) });
    const input = yield* decodeOperation(text.value).pipe(Effect.option);
    if (input._tag === "None")
      return reply(400, {
        ok: false,
        error: new BadArgs({ message: "expected one browser operation as JSON" }),
      });
    return yield* operations.operation(input.value).pipe(
      Effect.map((value) => reply(200, { ok: true, value })),
      Effect.catch((error: DaemonError) =>
        Effect.succeed(
          reply(error._tag === "daemon_unreachable" ? 503 : 200, { ok: false, error }),
        ),
      ),
    );
  });

/**
 * One session's subscription as SSE frames until it ends. A refusal or failure becomes one final
 * `failed` frame, since the status is already sent. The client closing interrupts this and closes
 * the subscription, and the browser resubscribes on any end.
 */
const events = (operations: ViewerOperations) =>
  Effect.gen(function* () {
    const text = yield* readBody;
    if (text._tag === "None")
      return reply(400, { ok: false, error: new BadArgs({ message: "unreadable request body" }) });
    const input = yield* decodeSubscribe(text.value).pipe(Effect.option);
    if (input._tag === "None")
      return reply(400, {
        ok: false,
        error: new BadArgs({ message: "expected one session subscription as JSON" }),
      });
    return HttpServerResponse.stream(
      operations.subscribe(input.value).pipe(
        Stream.catch((error) => Stream.succeed({ kind: "failed", error } as const)),
        Stream.map(eventFrame),
        Stream.encodeText,
      ),
      { contentType: "text/event-stream", headers: securityHeaders },
    );
  });

/**
 * The daemon's HTTP surface. Every request needs a loopback `Host` and no forwarding headers;
 * POSTs also need a matching `Origin`. Operations are strict `BrowserRequest`s answered with the
 * daemon's `Reply`; events stream one session's committed changes. Everything else is the packaged
 * SPA: exact files, then the shell for client routes, while `/api` and `/assets` misses stay real
 * errors.
 */
export const browserApp = (assets: WebAssets, operations: ViewerOperations) =>
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
    if (!isLoopbackHost(host) || names.some(isForwarding)) return status(403);
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

    if (path === webPaths.operation || path === webPaths.events) {
      if (request.method !== "POST") return status(405, { allow: "POST" });
      if (!isSameOrigin(host, single("origin"))) return status(403);
      return yield* path === webPaths.events ? events(operations) : operation(operations);
    }
    if (under(decoded, "/api")) return status(404);
    if (request.method !== "GET" && request.method !== "HEAD")
      return status(405, { allow: "GET, HEAD" });
    const file = assets.get(path);
    if (file !== undefined) return asset(file);
    if (under(decoded, "/assets")) return status(404);
    return asset(assets.get("/index.html")!);
  });

/**
 * Serves `app` on 127.0.0.1 at the first free port from `first` through the next nine, within the
 * caller's scope, and returns that port. Closing the scope drops every open connection first, so a
 * browser's open event stream cannot hold the daemon's exit.
 */
export const serveViewer = <E, R>(
  first: number,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const last = Math.min(first + viewerPortCount - 1, 65_535);
    const scope = yield* Effect.scope;
    for (let port = first; port <= last; port++) {
      const attempt = yield* Scope.fork(scope);
      const server = createServer();
      const bound = yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port }).pipe(
        Effect.tap((http) => http.serve(app)),
        Scope.provide(attempt),
        Effect.as(true),
        // Taken, or otherwise unusable: the next port may still be free.
        Effect.catchTag("ServeError", () => Effect.as(Scope.close(attempt, Exit.void), false)),
      );
      if (!bound) continue;
      // Registered after the server's own close, so it runs first.
      yield* Scope.addFinalizer(
        attempt,
        Effect.sync(() => server.closeAllConnections()),
      );
      return (server.address() as AddressInfo).port;
    }
    return yield* new DaemonUnreachable({
      message: `no free port for the gyst viewer on 127.0.0.1:${first}-${last}; free one, or set GYST_PORT to start elsewhere`,
    });
  });
