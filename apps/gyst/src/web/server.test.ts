import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vite-plus/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { type BrowserRequest, DaemonUnreachable, NoSession, type Request } from "@gyst/core";
import { Clock, Effect, Exit, Scope } from "effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { DaemonClient } from "../daemon/client.ts";
import { bootstrapLifetimeMillis, type Launch, makeLaunch } from "./auth.ts";
import { browserApp, installedWebUiDir, loadWebAssets, type WebAssets } from "./server.ts";
import { indexHtml, type RawResponse, secret, send, webUiFixture } from "./test-http.ts";

const t0 = 1_000_000;
let now = t0;
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
};

/** What the fake daemon received; the bridge must forward decoded browser input unchanged. */
let forwarded: Request[] = [];
const daemon = DaemonClient.of({
  request: (request) => {
    forwarded.push(request);
    if (request.command === "status" && request.session === "down")
      return Effect.fail(new DaemonUnreachable({ message: "daemon did not become reachable" }));
    if (request.command === "status")
      return Effect.fail(new NoSession({ message: `no session with id ${request.session}` }));
    return Effect.succeed({ sessions: [] });
  },
});

let fixture: Awaited<ReturnType<typeof webUiFixture>>;
let assets: WebAssets;
beforeAll(async () => {
  fixture = await webUiFixture();
  assets = await Effect.runPromise(loadWebAssets(fixture.dir));
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

/** Serves one launch on an ephemeral loopback port for the current test. */
async function serve(launch: Launch = makeLaunch(t0)) {
  const scope = Effect.runSync(Scope.make());
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const server = createServer();
  await Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port: 0 });
      yield* http.serve(
        browserApp(launch, assets).pipe(
          Effect.provideService(DaemonClient, daemon),
          Effect.provideService(Clock.Clock, clock),
        ),
      );
    }).pipe(Scope.provide(scope)),
  );
  const { port } = server.address() as AddressInfo;
  const host = `${launch.hostname}:${port}`;
  const origin = ["origin", `http://${host}`] as const;
  const bootstrap = (token = launch.bootstrap, extra: Array<readonly [string, string]> = []) =>
    send(port, {
      method: "POST",
      target: "/bootstrap",
      headers: [["host", host], origin, ["authorization", `Bearer ${token}`], ...extra],
    });
  const operation = (body: unknown, cookie = `gyst_auth=${launch.cookie}`) =>
    send(port, {
      method: "POST",
      target: "/api/operation",
      headers: [["host", host], origin, ["cookie", cookie], ["content-type", "application/json"]],
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (target: string, method = "GET") =>
    send(port, { method, target, headers: [["host", host]] });
  return { launch, port, host, origin, bootstrap, operation, get };
}

// Secrets never go into assertion messages, so a failing run cannot print them.
const hasSecret = (response: RawResponse, launch: Launch) =>
  [launch.bootstrap, launch.cookie].some((value) =>
    [response.body, ...response.headers.map(([, header]) => header)].some((text) =>
      text.includes(value),
    ),
  );

beforeAll(() => {
  forwarded = [];
});

describe("makeLaunch", () => {
  it("mints a fresh random .localhost name and independent 256-bit secrets per launch", () => {
    const [a, b] = [makeLaunch(t0), makeLaunch(t0)];
    for (const launch of [a, b]) {
      expect(launch.hostname).toMatch(/^g-[0-9a-f]{32}\.localhost$/);
      expect(Buffer.from(launch.bootstrap, "base64url")).toHaveLength(32);
      expect(Buffer.from(launch.cookie, "base64url")).toHaveLength(32);
      expect(launch.bootstrapExpiresAt).toBe(t0 + 10 * 60_000);
    }
    const values = [a.hostname, b.hostname, a.bootstrap, b.bootstrap, a.cookie, b.cookie];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("loadWebAssets", () => {
  it("fails explicitly when the installed SPA is absent", async () => {
    const exit = await Effect.runPromiseExit(loadWebAssets(`${fixture.root}/absent`));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("internal_error");
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
      "/assets/..%2f..%2fsecret.txt",
      "/assets/%2e%2e%5csecret.txt",
      "/api",
      "/api/nope",
      "/api%2Foperation",
      "/bootstrap/x",
    ]) {
      const response = await get(target);
      expect([target, response.status]).toEqual([target, 404]);
      expect(response.body).toBe("");
    }
    expect((await get("/%E0%A4%A")).status).toBe(400);
  });

  it("never reads outside the packaged files, whatever the path encoding", async () => {
    const { get } = await serve();
    for (const target of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "//secret.txt",
    ]) {
      const response = await get(target);
      expect(response.body.includes(secret)).toBe(false);
      expect([200, 404]).toContain(response.status);
    }
  });

  it("rejects methods outside each route's contract", async () => {
    const { get } = await serve();
    expect(await get("/", "POST")).toMatchObject({ status: 405 });
    expect((await get("/assets/app.js", "PUT")).header("allow")).toBe("GET, HEAD");
    expect((await get("/api/operation")).header("allow")).toBe("POST");
    expect((await get("/bootstrap")).status).toBe(405);
    expect((await get("/api/operation", "OPTIONS")).status).toBe(405);
  });
});

describe("browserApp authority", () => {
  it("accepts only this launch's hostname with a valid port, which may differ for SSH", async () => {
    const { launch, port } = await serve();
    const hostOnly = (headers: Array<readonly [string, string]>) =>
      send(port, { target: "/", headers }).then((response) => response.status);
    expect(await hostOnly([["host", `${launch.hostname}:48809`]])).toBe(200);
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      launch.hostname,
      `${launch.hostname}:0`,
      `${launch.hostname}:065535`,
      `${launch.hostname}:65536`,
      `${launch.hostname}:80x`,
      `user@${launch.hostname}:${port}`,
      `${makeLaunch(t0).hostname}:${port}`,
      `evil.${launch.hostname}:${port}`,
      `${launch.hostname}.evil:${port}`,
    ])
      expect([host.replace(launch.hostname, "<launch>"), await hostOnly([["host", host]])]).toEqual(
        [host.replace(launch.hostname, "<launch>"), 403],
      );
    const valid = ["host", `${launch.hostname}:${port}`] as const;
    expect(await hostOnly([valid, valid])).toBe(403);
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"])
      expect([name, await hostOnly([valid, [name, "attacker.example"]])]).toEqual([name, 403]);
  });

  it("rejects absolute-form request targets", async () => {
    const { port, host } = await serve();
    const response = await send(port, { target: `http://${host}/`, headers: [["host", host]] });
    expect(response.status).toBe(400);
  });

  it("requires a POST Origin serialized exactly as the request Host", async () => {
    const { launch, port, host } = await serve();
    const withOrigin = (origins: string[], requestHost = host) =>
      send(port, {
        method: "POST",
        target: "/bootstrap",
        headers: [
          ["host", requestHost],
          ...origins.map((origin) => ["origin", origin] as const),
          ["authorization", `Bearer ${launch.bootstrap}`],
        ],
      });
    for (const origins of [
      [],
      ["null"],
      [`https://${host}`],
      [`http://${host}/`],
      [`http://${launch.hostname}`],
      [`http://127.0.0.1:${port}`],
      [`http://${host}`, `http://${host}`],
    ])
      expect((await withOrigin(origins)).status).toBe(403);
    // Behind an SSH forward the browser-visible port, not the listener's, is the origin's port.
    const forwardedHost = `${launch.hostname}:48809`;
    expect((await withOrigin([`http://${host}`], forwardedHost)).status).toBe(403);
    expect((await withOrigin([`http://${forwardedHost}`], forwardedHost)).status).toBe(204);
  });
});

describe("browserApp bootstrap", () => {
  it("sets the host-only launch cookie idempotently, rejecting other credentials", async () => {
    now = t0;
    const { launch, bootstrap } = await serve();
    const first = await bootstrap();
    expect(first.status).toBe(204);
    const cookie = first.header("set-cookie")!;
    expect(cookie === `gyst_auth=${launch.cookie}; Path=/; HttpOnly; SameSite=Strict`).toBe(true);
    expect(cookie).not.toMatch(/domain|secure|max-age|expires/i);
    expect(first.header("cache-control")).toBe("no-store");
    // Replay (another tab, a retried exchange) yields the same cookie rather than rotating it.
    expect((await bootstrap()).header("set-cookie") === cookie).toBe(true);

    for (const response of [
      await bootstrap("wrong"),
      await bootstrap(""),
      await bootstrap(launch.cookie),
      await bootstrap(makeLaunch(t0).bootstrap),
    ]) {
      expect(response.status).toBe(401);
      expect(response.header("set-cookie")).toBeUndefined();
      expect(hasSecret(response, launch)).toBe(false);
    }
    const { port, host, origin } = await serve(launch);
    const basic = await send(port, {
      method: "POST",
      target: "/bootstrap",
      headers: [["host", host], origin, ["authorization", `Basic ${launch.bootstrap}`]],
    });
    const twice = await send(port, {
      method: "POST",
      target: "/bootstrap",
      headers: [
        ["host", host],
        origin,
        ["authorization", `Bearer ${launch.bootstrap}`],
        ["authorization", `Bearer ${launch.bootstrap}`],
      ],
    });
    const none = await send(port, {
      method: "POST",
      target: "/bootstrap",
      headers: [["host", host], origin],
    });
    expect([basic.status, twice.status, none.status]).toEqual([401, 401, 401]);
  });

  it("expires ten minutes after launch however often it was exchanged, while the cookie lasts", async () => {
    now = t0;
    const { bootstrap, operation } = await serve();
    now = t0 + bootstrapLifetimeMillis - 1;
    expect((await bootstrap()).status).toBe(204);
    now = t0 + bootstrapLifetimeMillis;
    const expired = await bootstrap();
    expect([expired.status, expired.header("set-cookie")]).toEqual([401, undefined]);
    now = t0 + 10 * bootstrapLifetimeMillis;
    expect((await operation({ command: "list" })).status).toBe(200);
    now = t0;
  });
});

describe("browserApp operations", () => {
  it("authenticates before the body and never reaches the daemon without the launch cookie", async () => {
    forwarded = [];
    const { launch, operation } = await serve();
    for (const cookie of [
      "",
      "gyst_auth=",
      "gyst_auth=wrong",
      `gyst_auth=${launch.bootstrap}`,
      `other=${launch.cookie}`,
      `gyst_auth=${makeLaunch(t0).cookie}`,
    ])
      expect((await operation({ command: "list" }, cookie)).status).toBe(401);
    expect(forwarded).toEqual([]);
    // A planted same-name cookie cannot shadow the real one.
    const planted = await operation(
      { command: "list" },
      `gyst_auth=planted; gyst_auth=${launch.cookie}`,
    );
    expect(planted.status).toBe(200);
  });

  it("forwards strict browser operations unchanged and returns the canonical Reply", async () => {
    forwarded = [];
    const { operation } = await serve();
    const requests: BrowserRequest[] = [
      { command: "list" },
      { command: "open", session: "s1" },
      { command: "diff", session: "s1", file: "a.txt" },
      { command: "delete", session: "s1", requestId: "r1" },
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

  it("rejects malformed and non-browser operations with bad_args before the daemon", async () => {
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
    ]) {
      const response = await operation(body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    // Over the size limit the server answers without reading the rest, so the client may see a
    // reset instead of the 400; either way nothing reaches the daemon.
    const oversized = await operation({ command: "list", padding: "x".repeat(70_000) }).then(
      (response) => response.status,
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect([400, "ECONNRESET", "EPIPE"]).toContain(oversized);
    expect(forwarded).toEqual([]);
  });
});

describe("cross-launch isolation", () => {
  it("rejects one launch's hostname, bootstrap and cookie at another", async () => {
    const a = await serve();
    const b = await serve();
    expect((await a.bootstrap()).status).toBe(204);
    // A's hostname aimed at B's port: B only answers its own hostname.
    const aHostAtB = await send(b.port, {
      target: "/",
      headers: [["host", `${a.launch.hostname}:${b.port}`]],
    });
    expect(aHostAtB.status).toBe(403);
    expect((await b.bootstrap(a.launch.bootstrap)).status).toBe(401);
    expect((await b.operation({ command: "list" }, `gyst_auth=${a.launch.cookie}`)).status).toBe(
      401,
    );
    expect((await a.operation({ command: "list" })).status).toBe(200);
  });
});
