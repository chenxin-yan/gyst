import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  type BrowserRequest,
  DaemonUnreachable,
  NoSession,
  type SubscribeRequest,
  type SubscriptionEvent,
} from "@gyst/core";
import { Effect, Exit, Queue, Schedule, Scope, Stream } from "effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import {
  browserApp,
  installedWebUiDir,
  isLoopbackHost,
  loadWebAssets,
  type ViewerOperations,
  type WebAssets,
  webAssetsOrNotice,
} from "./server.ts";
import { indexHtml, openStream, secret, send, webUiFixture } from "../../tests/http.ts";

const snapshotId = "0".repeat(64);

/** What the fake daemon operations received; the adapter must pass decoded browser input unchanged. */
let forwarded: BrowserRequest[] = [];
const operations: ViewerOperations = {
  operation: (request) => {
    forwarded.push(request);
    if (request.command === "status" && request.session === "down")
      return Effect.fail(new DaemonUnreachable({ message: "daemon did not become reachable" }));
    if (request.command === "status")
      return Effect.fail(new NoSession({ message: `no session with id ${request.session}` }));
    return Effect.succeed({ sessions: [] });
  },
  subscribe: (request) => {
    subscribed.push(request);
    const ready: SubscriptionEvent = { kind: "ready", daemon: "d1", ...version(0) };
    if (request.session === "gone")
      return Stream.fail(new NoSession({ message: `no session with id ${request.session}` }));
    if (request.session === "down")
      return Stream.fail(new DaemonUnreachable({ message: "daemon did not become reachable" }));
    if (request.session === "broken")
      return Stream.concat(
        Stream.succeed(ready),
        Stream.fail(new DaemonUnreachable({ message: "daemon subscription failed" })),
      );
    if (request.session === "held")
      return Stream.concat(Stream.succeed(ready), Stream.never).pipe(
        Stream.ensuring(Effect.sync(() => void released++)),
      );
    if (request.session === "flooded")
      return Stream.unwrap(
        Effect.gen(function* () {
          const changes = yield* Queue.sliding<SubscriptionEvent>(1);
          const subscription = { changes, taken: 0 };
          flooded = subscription;
          return Stream.concat(
            Stream.succeed(ready),
            Stream.fromQueue(changes).pipe(
              Stream.tap(() => Effect.sync(() => subscription.taken++)),
            ),
          ).pipe(Stream.ensuring(Effect.sync(() => void released++)));
        }),
      );
    return Stream.make(...liveEvents);
  },
};
/** The open "flooded" subscription: the daemon's newest-only queue and how many changes left it. */
let flooded: { readonly changes: Queue.Queue<SubscriptionEvent>; taken: number } | undefined;
/** What the fake daemon was asked to subscribe to, and how many subscriptions it closed. */
let subscribed: SubscribeRequest[] = [];
let released = 0;
const version = (revision: number) => ({
  sessionId: "s1",
  snapshotId,
  revision,
  conversations: "v1",
});
const liveEvents: SubscriptionEvent[] = [
  { kind: "ready", daemon: "d1", ...version(0) },
  { kind: "changed", ...version(1) },
  {
    kind: "changed",
    sessionId: "s1",
    snapshotId: "1".repeat(64),
    revision: 2,
    conversations: "v1",
  },
  { kind: "deleted", sessionId: "s1" },
];

let fixture: Awaited<ReturnType<typeof webUiFixture>>;
let assets: WebAssets;
beforeAll(async () => {
  fixture = await webUiFixture();
  assets = await Effect.runPromise(loadWebAssets(fixture.dir));
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

/** Serves the viewer on an ephemeral loopback port for the current test, as the link names it. */
async function serve() {
  const scope = Effect.runSync(Scope.make());
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const server = createServer();
  await Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port: 0 });
      yield* http.serve(browserApp(assets, operations));
    }).pipe(Scope.provide(scope)),
  );
  const { port } = server.address() as AddressInfo;
  const host = `localhost:${port}`;
  const origin = ["origin", `http://${host}`] as const;
  const operation = (body: unknown) =>
    send(port, {
      method: "POST",
      target: "/api/operation",
      headers: [["host", host], origin, ["content-type", "application/json"]],
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (target: string, method = "GET") =>
    send(port, { method, target, headers: [["host", host]] });
  const allowed = [["host", host], origin] as const;
  const events = (session: string) =>
    openStream(port, { target: `/api/events?session=${session}`, headers: allowed });
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return { port, host, origin, allowed, operation, get, events, close };
}

beforeAll(() => {
  forwarded = [];
});

describe("loadWebAssets", () => {
  it("fails explicitly when the installed SPA is absent", async () => {
    const exit = await Effect.runPromiseExit(loadWebAssets(`${fixture.root}/absent`));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("internal_error");
  });

  it("stands in a shell that names the missing SPA, so the daemon still serves", async () => {
    const notice = await Effect.runPromise(webAssetsOrNotice(`${fixture.root}/absent`));
    expect([...notice.keys()]).toEqual(["/index.html"]);
    expect(new TextDecoder().decode(notice.get("/index.html")!.body)).toContain(
      "the gyst web UI is not installed; reinstall @gyst/cli",
    );
    expect(await Effect.runPromise(webAssetsOrNotice(fixture.dir))).toEqual(assets);
  });

  it("keeps regular packaged files only, never symlinks", () => {
    expect([...assets.keys()].sort()).toEqual([
      "/assets/app.css",
      "/assets/app.js",
      "/favicon.svg",
      "/index.html",
    ]);
  });

  it("resolves the installed SPA beside the bundled bin, not the cwd", () => {
    expect(installedWebUiDir).toBe(new URL("../dist/web-ui", import.meta.url).pathname);
    expect(installedWebUiDir.startsWith(process.cwd() + "/dist/web-ui")).toBe(false);
  });
});

describe("browserApp static routes", () => {
  it("serves the shell for root, deep and unknown client routes with safe headers", async () => {
    const { get } = await serve();
    for (const target of ["/", "/session/abc", "/no/such/route?x=1"]) {
      const response = await get(target);
      expect(response.status).toBe(200);
      expect(response.body).toBe(indexHtml);
      expect(response.header("content-type")).toBe("text/html; charset=utf-8");
      expect(response.header("x-content-type-options")).toBe("nosniff");
      expect(response.header("referrer-policy")).toBe("no-referrer");
      expect(response.header("cache-control")).toBe("no-store");
      expect(response.header("content-security-policy")).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'",
      );
      expect(response.header("access-control-allow-origin")).toBeUndefined();
      expect(response.header("set-cookie")).toBeUndefined();
    }
    const head = await get("/session/abc", "HEAD");
    expect([head.status, head.body]).toEqual([200, ""]);
  });

  it("serves packaged files with their MIME types", async () => {
    const { get } = await serve();
    expect((await get("/assets/app.js")).header("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect((await get("/assets/app.css")).header("content-type")).toBe("text/css; charset=utf-8");
    expect((await get("/favicon.svg")).header("content-type")).toBe("image/svg+xml");
  });

  it("answers reserved-namespace misses with real errors, never the shell", async () => {
    const { get } = await serve();
    for (const target of [
      "/assets/missing.js",
      "/assets/link.txt",
      "/api",
      "/api/nope",
      "/%61pi/operation",
    ]) {
      const response = await get(target);
      expect([target, response.status]).toEqual([target, 404]);
      expect(response.body).toBe("");
    }
    expect((await get("/%E0%A4%A")).status).toBe(400);
  });

  it("rejects raw targets with dot segments, encoded or back slashes, or no single leading slash", async () => {
    const { get } = await serve();
    for (const target of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/assets/../missing.js",
      "/./index.html",
      "/%2e%2e/%2e%2e/secret.txt",
      "/session/%2E",
      "/..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/api%2Foperation",
      "/assets/%2e%2e%5csecret.txt",
      "/assets\\app.js",
      "//secret.txt",
      "//[",
    ]) {
      const response = await get(target);
      expect([target, response.status, response.body]).toEqual([target, 400, ""]);
      expect(response.body.includes(secret)).toBe(false);
    }
    // Only the path is checked: a query may carry anything, and deep routes stay client routes.
    for (const target of ["/session/abc?next=/../x%2f", "/session/a.b/c..d"])
      expect([target, (await get(target)).body]).toEqual([target, indexHtml]);
    expect((await get("/assets/app.js?v=1")).body).toBe("console.log(1)");
  });

  it("rejects methods outside each route's contract", async () => {
    const { get } = await serve();
    expect(await get("/", "POST")).toMatchObject({ status: 405 });
    expect((await get("/assets/app.js", "PUT")).header("allow")).toBe("GET, HEAD");
    expect((await get("/api/operation")).header("allow")).toBe("POST");
    expect((await get("/api/operation", "OPTIONS")).status).toBe(405);
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback names on any valid port and nothing else", () => {
    for (const host of [
      "localhost",
      "localhost:4978",
      "localhost:48809",
      "127.0.0.1:4987",
      "[::1]:4978",
      "localhost:65535",
    ])
      expect([host, isLoopbackHost(host)]).toEqual([host, true]);
    for (const host of [
      undefined,
      "",
      "localhost:0",
      "localhost:065535",
      "localhost:65536",
      "localhost:80x",
      "localhost:",
      "LOCALHOST:4978",
      "user@localhost:4978",
      "g-0123.localhost:4978",
      "localhost.attacker.example:4978",
      "attacker.example:4978",
      "127.0.0.2:4978",
      "0.0.0.0:4978",
      "[::ffff:127.0.0.1]:4978",
      "192.168.1.5:4978",
    ])
      expect([host, isLoopbackHost(host)]).toEqual([host, false]);
  });
});

describe("browserApp authority", () => {
  it("accepts only a loopback Host, on any port so an SSH forward's local port works", async () => {
    const { port } = await serve();
    const hostOnly = (headers: Array<readonly [string, string]>) =>
      send(port, { target: "/", headers }).then((response) => response.status);
    for (const host of [`localhost:${port}`, "localhost:48809", `127.0.0.1:${port}`])
      expect([host, await hostOnly([["host", host]])]).toEqual([host, 200]);
    // A DNS-rebinding page names its own host, which resolves to loopback but is not loopback's.
    for (const host of [`attacker.example:${port}`, `localhost.attacker.example:${port}`])
      expect([host, await hostOnly([["host", host]])]).toEqual([host, 403]);
    const valid = ["host", `localhost:${port}`] as const;
    expect(await hostOnly([valid, valid])).toBe(403);
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"])
      expect([name, await hostOnly([valid, [name, "attacker.example"]])]).toEqual([name, 403]);
  });

  it("rejects absolute-form request targets", async () => {
    const { port, host } = await serve();
    const response = await send(port, { target: `http://${host}/`, headers: [["host", host]] });
    expect(response.status).toBe(400);
  });

  it("requires a mutation's Origin serialized exactly as the request Host", async () => {
    forwarded = [];
    const { port, host } = await serve();
    const withOrigin = (origins: string[], requestHost = host) =>
      send(port, {
        method: "POST",
        target: "/api/operation",
        headers: [
          ["host", requestHost],
          ...origins.map((origin) => ["origin", origin] as const),
          ["content-type", "application/json"],
        ],
        body: JSON.stringify({ command: "list" }),
      });
    for (const origins of [
      [],
      ["null"],
      ["http://attacker.example"],
      [`https://${host}`],
      [`http://${host}/`],
      [`http://127.0.0.1:${port}`],
      [`http://${host}`, `http://${host}`],
    ])
      expect([origins, (await withOrigin(origins)).status]).toEqual([origins, 403]);
    expect(forwarded).toEqual([]);
    // Behind an SSH forward the browser-visible port, not the listener's, is the origin's port.
    const forwardedHost = "localhost:48809";
    expect((await withOrigin([`http://${host}`], forwardedHost)).status).toBe(403);
    expect((await withOrigin([`http://${forwardedHost}`], forwardedHost)).status).toBe(200);
  });
});

describe("browserApp operations", () => {
  it("passes strict browser operations unchanged and returns the canonical Reply", async () => {
    forwarded = [];
    const { operation } = await serve();
    const requests: BrowserRequest[] = [
      { command: "list" },
      { command: "open", session: "s1" },
      { command: "diff", session: "s1", file: "a.txt" },
      { command: "files", session: "s1", snapshotId, after: "src/a.ts" },
      { command: "code", session: "s1", snapshotId, file: "src/a.ts", side: "old", startLine: 3 },
      { command: "code", session: "s1", snapshotId, file: "src/a.ts", side: "new", offset: 7 },
      { command: "delete", session: "s1", requestId: "r1" },
      { command: "refresh", session: "s1", snapshotId, requestId: "r1" },
      { command: "conversations", session: "s1" },
      { command: "messages", session: "s1", thread: "t1" },
      {
        command: "draft",
        session: "s1",
        requestId: "r2",
        target: { kind: "note", note: "n1" },
        wording: "The note.",
      },
      {
        command: "send",
        session: "s1",
        requestId: "r3",
        draft: "d1",
        markdown: "Why?",
        kind: "change",
      },
      {
        command: "resolve",
        session: "s1",
        requestId: "r4",
        thread: "t1",
        seen: "v1",
        resolved: true,
      },
    ];
    for (const request of requests) {
      const response = await operation(request);
      expect(response.status).toBe(200);
      expect(response.header("content-type")).toBe("application/json");
      expect(JSON.parse(response.body)).toEqual({ ok: true, value: { sessions: [] } });
    }
    expect(forwarded).toEqual(requests);

    const missing = await operation({ command: "status", session: "gone" });
    expect([missing.status, JSON.parse(missing.body)]).toEqual([
      200,
      { ok: false, error: { code: "no_session", message: "no session with id gone" } },
    ]);
    const down = await operation({ command: "status", session: "down" });
    expect([down.status, JSON.parse(down.body)]).toEqual([
      503,
      {
        ok: false,
        error: { code: "daemon_unreachable", message: "daemon did not become reachable" },
      },
    ]);
  });

  it("rejects malformed, agent and CLI operations with bad_args before the daemon", async () => {
    forwarded = [];
    const { operation } = await serve();
    for (const body of [
      "",
      "{",
      "[]",
      JSON.stringify({ command: "open", cwd: "/", scope: { kind: "uncommitted" } }),
      JSON.stringify({ command: "list", cwd: "/" }),
      JSON.stringify({ command: "status", session: "s1", role: "human" }),
      JSON.stringify({ command: "diff", session: "s1", args: ["--output=/tmp/x"] }),
      JSON.stringify({ command: "open", session: "s1", executable: "/bin/sh" }),
      JSON.stringify({ command: "apply", session: "s1", batch: "{}" }),
      JSON.stringify({ command: "refresh", session: "s1" }),
      JSON.stringify({ command: "delete", session: "s1" }),
      // The agent's retrieval and replies never come from a browser, nor does an author role.
      JSON.stringify({ command: "threads", session: "s1", mode: "pending", requestId: "r1" }),
      JSON.stringify({
        command: "send",
        session: "s1",
        requestId: "r1",
        draft: "d1",
        markdown: "Hi.",
        kind: "question",
        author: "agent",
      }),
      // Captured reads name a logical path in an exact snapshot: no host path, blob or checkout.
      JSON.stringify({
        command: "code",
        session: "s1",
        snapshotId,
        file: "/etc/passwd",
        side: "new",
      }),
      JSON.stringify({
        command: "code",
        session: "s1",
        snapshotId,
        file: "a/../../b",
        side: "new",
      }),
      JSON.stringify({
        command: "code",
        session: "s1",
        snapshotId,
        file: "a",
        side: "new",
        blob: "b",
      }),
      JSON.stringify({ command: "code", session: "s1", snapshotId, file: "a", side: "live" }),
      JSON.stringify({ command: "code", session: "s1", file: "a", side: "new" }),
      JSON.stringify({
        command: "code",
        session: "s1",
        snapshotId,
        file: "a",
        side: "new",
        cwd: "/",
      }),
      JSON.stringify({ command: "files", session: "s1", snapshotId: "../snapshots/x" }),
      JSON.stringify({ command: "files", session: "s1", snapshotId, after: "/abs" }),
    ]) {
      const response = await operation(body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    expect(forwarded).toEqual([]);
  });
});

describe("browserApp operation size", () => {
  it("passes a Viewed request naming thousands of hunks, well over 64 KiB", async () => {
    forwarded = [];
    const { operation } = await serve();
    const request: BrowserRequest = {
      command: "viewed",
      session: "s1",
      snapshotId,
      revision: 1,
      requestId: "r1",
      hunkIds: Array.from({ length: 4_000 }, (_, index) => index.toString(16).padStart(16, "0")),
      viewed: true,
    };
    expect(JSON.stringify(request).length).toBeGreaterThan(64 * 1024);
    const response = await operation(request);
    expect([response.status, JSON.parse(response.body)]).toEqual([
      200,
      { ok: true, value: { sessions: [] } },
    ]);
    expect(forwarded).toEqual([request]);
  });

  it("rejects a body over 16 MiB as unreadable before decoding or the daemon", async () => {
    forwarded = [];
    const { operation } = await serve();
    // Over the size limit the server answers without reading the rest, so the client may see a
    // reset or a bare close instead of the 400; either way nothing reaches the daemon. A body read
    // in full would instead fail decoding with a different 400.
    const oversized = await operation(" ".repeat(16 * 1024 * 1024 + 1)).then(
      (response) =>
        response.status ? [response.status, JSON.parse(response.body) as unknown] : "closed",
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect([
      "ECONNRESET",
      "EPIPE",
      "closed",
      [400, { ok: false, error: { code: "bad_args", message: "unreadable request body" } }],
    ]).toContainEqual(oversized);
    expect(forwarded).toEqual([]);
  });
});

describe("browserApp events", () => {
  /** The frames of a stream that the server ends, decoded. */
  const collect = async (stream: Awaited<ReturnType<typeof openStream>>) => {
    const frames: unknown[] = [];
    for await (const frame of stream.frames()) frames.push(JSON.parse(frame));
    return frames;
  };

  it("applies the operation route's Host, Origin and forwarding rules before the daemon", async () => {
    subscribed = [];
    const { port, host, origin, allowed } = await serve();
    const attempt = async (headers: ReadonlyArray<readonly [string, string]>) => {
      const stream = await openStream(port, { target: "/api/events?session=s1", headers });
      stream.close();
      return stream.status;
    };

    const post = await send(port, { method: "POST", target: "/api/events", headers: allowed });
    expect([post.status, post.header("allow")]).toEqual([405, "GET"]);
    expect(await attempt([["host", `attacker.example:${port}`], origin])).toBe(403);
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-for"])
      expect([name, await attempt([...allowed, [name, "attacker.example"]])]).toEqual([name, 403]);
    for (const origins of [[], ["null"], ["http://attacker.example"], [`https://${host}`]])
      expect(
        await attempt([["host", host], ...origins.map((value) => ["origin", value] as const)]),
      ).toBe(403);
    expect(subscribed).toEqual([]);

    // Behind an SSH forward the browser-visible port differs from the listener's.
    const sshHost = "localhost:48809";
    const forwarded = await openStream(port, {
      target: "/api/events?session=s1",
      headers: [
        ["host", sshHost],
        ["origin", `http://${sshHost}`],
      ],
    });
    expect(forwarded.status).toBe(101);
    expect(await collect(forwarded)).toEqual(liveEvents);
    expect(subscribed).toEqual([{ session: "s1" }]);
  });

  it("rejects a malformed or non-subscription query with bad_args, and a plain GET, before the daemon", async () => {
    subscribed = [];
    const { port, allowed } = await serve();
    for (const query of ["", "?", "?sessions=s1", "?session=s1&daemon=d0", "?x=1"]) {
      const stream = await openStream(port, { target: `/api/events${query}`, headers: allowed });
      expect([query, stream.status]).toEqual([query, 400]);
    }
    const response = await send(port, { target: "/api/events?x=1", headers: allowed });
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: { code: "bad_args", message: "expected one session subscription" },
    });
    const plain = await send(port, { target: "/api/events?session=s1", headers: allowed });
    expect([plain.status, plain.header("upgrade")]).toEqual([426, "websocket"]);
    expect(subscribed).toEqual([]);
  });

  it("refuses a handshake the WebSocket server would reject and still closes the viewer", async () => {
    subscribed = [];
    const handshake: ReadonlyArray<readonly [string, string]> = [
      ["connection", "upgrade"],
      ["upgrade", "websocket"],
      ["sec-websocket-version", "13"],
      ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
    ];
    const without = (name: string) => handshake.filter(([header]) => header !== name);
    for (const headers of [
      [...without("sec-websocket-key"), ["sec-websocket-key", "invalid"]],
      without("sec-websocket-key"),
      [...without("sec-websocket-version"), ["sec-websocket-version", "12"]],
      [...without("upgrade"), ["upgrade", "h2c"]],
      [...handshake, ["sec-websocket-protocol", "a,a"]],
    ] satisfies ReadonlyArray<readonly [string, string]>[]) {
      const { port, allowed, close } = await serve();
      const refused = await send(port, {
        target: "/api/events?session=s1",
        headers: [...allowed, ...headers],
      });
      expect([headers, refused.status]).toEqual([headers, 400]);
      const closed = await Promise.race([
        close().then(() => "closed"),
        new Promise((resolve) => setTimeout(resolve, 3000, "pending")),
      ]);
      expect([headers, closed]).toEqual([headers, "closed"]);
    }
    expect(subscribed).toEqual([]);
  });

  it("sends the subscription's events verbatim and in order, one message each", async () => {
    subscribed = [];
    const { events } = await serve();
    const stream = await events("s1");
    expect(stream.status).toBe(101);
    expect(stream.header("upgrade")).toBe("websocket");
    expect(stream.header("access-control-allow-origin")).toBeUndefined();
    expect(stream.header("set-cookie")).toBeUndefined();
    const raw: string[] = [];
    for await (const frame of stream.frames()) raw.push(frame);
    expect(raw.map((frame) => JSON.parse(frame))).toEqual(liveEvents);
    expect(subscribed).toEqual([{ session: "s1" }]);
  });

  it("ends a refused or broken subscription with exactly one failed frame", async () => {
    const { events } = await serve();
    expect(await collect(await events("gone"))).toEqual([
      { kind: "failed", error: { code: "no_session", message: "no session with id gone" } },
    ]);
    expect(await collect(await events("down"))).toEqual([
      {
        kind: "failed",
        error: { code: "daemon_unreachable", message: "daemon did not become reachable" },
      },
    ]);
    expect(await collect(await events("broken"))).toEqual([
      liveEvents[0],
      {
        kind: "failed",
        error: { code: "daemon_unreachable", message: "daemon subscription failed" },
      },
    ]);
  });

  it("closes the subscription when the browser hangs up", async () => {
    released = 0;
    const { events } = await serve();
    const stream = await events("held");
    const frames = stream.frames();
    expect(JSON.parse((await frames.next()).value!)).toEqual(liveEvents[0]);
    expect(released).toBe(0);
    stream.close();
    await Effect.runPromise(
      Effect.sync(() => released).pipe(
        Effect.repeat({ until: (count) => count === 1, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(released).toBe(1);
  });

  /** A "flooded" stream fed far more than the kernel's loopback buffers hold while nothing is read. */
  const flood = async () => {
    flooded = undefined;
    released = 0;
    const { events } = await serve();
    const stream = await events("flooded");
    onTestFinished(() => stream.close());
    await vi.waitFor(() => expect(flooded).toBeDefined());
    const context = "c".repeat(32 * 1024);
    const offered = 1500;
    for (let revision = 1; revision <= offered; revision++) {
      Queue.offerUnsafe(flooded!.changes, { kind: "changed", ...version(revision), context });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // What left the queue is all the daemon buffers for this reader.
    expect(flooded!.taken).toBeLessThan(offered / 3);
    return { stream, latest: { kind: "changed", ...version(offered), context }, offered };
  };

  it("holds a reader that stops reading to its newest change, which it reads on resuming", async () => {
    const { stream, latest, offered } = await flood();
    const read: { revision: number }[] = [];
    for await (const frame of stream.frames()) {
      read.push(JSON.parse(frame));
      if (read.at(-1)!.revision === offered) break;
    }
    expect(read.length).toBeLessThan(offered / 3);
    expect(read.at(-1)).toEqual(latest);
  }, 30_000);

  it("closes a stalled reader's subscription when it hangs up", async () => {
    const { stream } = await flood();
    expect(released).toBe(0);
    stream.close();
    await vi.waitFor(() => expect(released).toBe(1));
  }, 30_000);
});

describe("browserApp navigation", () => {
  it("refuses a browser-supplied add-on, executable or PATH with bad_args before the daemon", async () => {
    forwarded = [];
    const { operation } = await serve();
    const target = { session: "s1", snapshotId, side: "new", file: "src/a.ts" } as const;
    const position = { line: 2, character: 4 };
    const addon = { kind: "available", entry: "/bin/sh", version: "1.0.0" };
    for (const body of [
      { command: "definition", ...target, position, addon },
      { command: "references", ...target, position, entry: "/bin/sh" },
      { command: "identifiers", ...target, line: 1, addon: { kind: "missing" } },
      { command: "navigation", session: "s1", snapshotId, addon },
      { command: "navigation", session: "s1", snapshotId, recheck: true, entry: "/bin/sh" },
      { command: "navigation", session: "s1", snapshotId, path: "/tmp" },
      { command: "open", session: "s1", path: "/tmp" },
    ]) {
      const response = await operation(body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    expect(forwarded).toEqual([]);
  });
});
