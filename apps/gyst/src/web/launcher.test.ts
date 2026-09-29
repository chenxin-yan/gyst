import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { Session } from "@gyst/core";
import { Crypto, Effect, Fiber, Layer, Schedule } from "effect";
import * as Socket from "effect/socket/Socket";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../daemon/client.ts";
import { Git } from "../daemon/git.ts";
import { Paths } from "../daemon/paths.ts";
import { DaemonServer } from "../daemon/server.ts";
import { Sessions } from "../daemon/sessions.ts";
import { SessionStore } from "../daemon/store.ts";
import { readLine, writeLine } from "../daemon/wire.ts";
import { browserOpener, serveViewer, type ViewerOpen } from "./launcher.ts";
import { indexHtml, send, webUiFixture } from "./test-http.ts";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;

let dataDir: string;
let fixture: Awaited<ReturnType<typeof webUiFixture>>;
const files = new Map<string, Session>();
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-launcher-"));
  fixture = await webUiFixture();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(fixture.root, { recursive: true, force: true });
});

// The real daemon (Sessions, socket server) and the real DaemonClient, over a private socket;
// only Git capture and the session files are in memory.
const paths = Layer.sync(Paths, () => ({
  dataDir,
  socketPath: join(dataDir, "daemon.sock"),
  pidPath: join(dataDir, "daemon.pid"),
  deleteReceiptsPath: join(dataDir, "delete-receipts"),
  sessionFile: (id: string) => join(dataDir, `${id}.json`),
}));
const git = Layer.succeed(Git, {
  repoRoot: (cwd) => Effect.succeed(cwd),
  capture: () => Effect.succeed(patch),
});
const receipts: Array<{ requestId: string; sessionId: string }> = [];
const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  save: (session) => Effect.sync(() => void files.set(session.id, session)),
  remove: (id) => Effect.sync(() => void files.delete(id)),
  loadDeleteReceipts: Effect.sync(() => receipts),
  saveDeleteReceipts: (next) => Effect.sync(() => void receipts.splice(0, Infinity, ...next)),
});
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const layer = Layer.mergeAll(
  DaemonServer.layer.pipe(
    Layer.provide(Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, store, crypto)))),
  ),
  DaemonClient.layer,
).pipe(Layer.provide(paths), Layer.provideMerge(NodeServices.layer));

/** A raw socket probe, so the client never has to spawn a daemon while this one starts. */
const daemonAnswers = Effect.gen(function* () {
  const socket = yield* NodeSocket.makeNet({ path: join(dataDir, "daemon.sock") });
  const pull = yield* Socket.readerBytes(socket);
  yield* writeLine(socket, JSON.stringify({ command: "daemon.info" }));
  return yield* readLine(pull);
}).pipe(Effect.scoped);

const viewerUrl = /^(http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+))(\/session\/[^#\s]+)#(\S+)$/m;

/** Starts a viewer and reads its printed private URL (kept out of assertion messages). */
const startViewer = (open: ViewerOpen, opener?: string) =>
  Effect.gen(function* () {
    const printed: string[] = [];
    const fiber = yield* Effect.forkChild(
      serveViewer(open, { webUiDir: fixture.dir, opener, stdout: (text) => printed.push(text) }),
    );
    yield* Effect.sync(() => printed.length > 0).pipe(
      Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
      Effect.timeout("5 seconds"),
    );
    const match = viewerUrl.exec(printed[0]!);
    const port = Number(match?.[3]);
    const host = `${match?.[2]}:${port}`;
    const headers = [["host", host]] as Array<readonly [string, string]>;
    const origin = ["origin", match?.[1] ?? ""] as const;
    let cookie = "";
    const bootstrap = (token = match?.[5] ?? "") =>
      Effect.promise(() =>
        send(port, {
          method: "POST",
          target: "/bootstrap",
          headers: [...headers, origin, ["authorization", `Bearer ${token}`]],
        }),
      ).pipe(
        Effect.tap((response) =>
          Effect.sync(() => void (cookie ||= response.header("set-cookie")?.split(";")[0] ?? "")),
        ),
      );
    const operation = (body: unknown, withCookie = () => cookie) =>
      Effect.promise(() =>
        send(port, {
          method: "POST",
          target: "/api/operation",
          headers: [...headers, origin, ["cookie", withCookie()]],
          body: JSON.stringify(body),
        }),
      ).pipe(
        Effect.map((response) => ({
          status: response.status,
          reply: JSON.parse(response.body || "null"),
        })),
      );
    return {
      fiber,
      printed,
      match,
      port,
      host,
      sessionPath: match?.[4],
      cookie: () => cookie,
      bootstrap,
      operation,
      get: (target: string) => Effect.promise(() => send(port, { target, headers })),
    };
  });

const refused = (port: number, address = "127.0.0.1") =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: address });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });

describe("browserOpener", () => {
  it("opens only for an interactive local desktop, else the operator gets the URL", () => {
    expect(browserOpener("darwin", {}, true)).toBe("open");
    expect(browserOpener("linux", { DISPLAY: ":0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", { WAYLAND_DISPLAY: "wayland-0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", {}, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":0" }, false)).toBeUndefined();
    expect(browserOpener("darwin", { SSH_CONNECTION: "1 2 3 4" }, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":10", SSH_TTY: "/dev/pts/1" }, true)).toBeUndefined();
    expect(browserOpener("win32", {}, true)).toBeUndefined();
  });
});

describe("serveViewer", () => {
  it("serves launches through the real daemon client; stopping one leaves the daemon and others", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });

        // Without the packaged SPA the launch fails before touching the daemon.
        const missing = yield* serveViewer(
          { command: "open", cwd: "/repo-a", scope: { kind: "uncommitted" } },
          { webUiDir: join(fixture.root, "absent"), opener: undefined, stdout: () => {} },
        ).pipe(Effect.flip);
        expect(missing._tag).toBe("internal_error");
        expect(files.size).toBe(0);

        const a = yield* startViewer({
          command: "open",
          cwd: "/repo-a",
          scope: { kind: "uncommitted" },
        });
        const b = yield* startViewer({
          command: "open",
          cwd: "/repo-b",
          scope: { kind: "range", range: "main...feature" },
        });
        const [idA = "", idB = ""] = [...files.values()].map((session) => session.id);
        expect(a.match !== null && b.match !== null).toBe(true);
        expect(a.sessionPath).toBe(`/session/${idA}`);
        expect(b.sessionPath).toBe(`/session/${idB}`);
        expect(a.printed[0]).toContain("Press Ctrl-C to stop the viewer.");
        // Loopback IPv4 only.
        expect(yield* Effect.promise(() => refused(a.port, "::1"))).toBe(true);

        const shell = yield* a.get(a.sessionPath!);
        expect([shell.status, shell.body]).toEqual([200, indexHtml]);
        expect((yield* a.operation({ command: "list" })).status).toBe(401);
        expect((yield* a.bootstrap()).status).toBe(204);
        expect((yield* b.bootstrap()).status).toBe(204);
        expect(a.cookie() !== b.cookie()).toBe(true);

        const listed = yield* a.operation({ command: "list" });
        expect(listed.status).toBe(200);
        expect(
          listed.reply.value.sessions.map((session: { id: string }) => session.id).toSorted(),
        ).toEqual([idA, idB].toSorted());
        const reopened = yield* a.operation({ command: "open", session: idA });
        expect(reopened.reply).toMatchObject({
          ok: true,
          value: { created: false, session: { id: idA } },
        });
        const diff = yield* a.operation({ command: "diff", session: idA });
        expect(
          diff.reply.value.hunks.map((hunk: { patch: string }) => hunk.patch).join(""),
        ).toContain("+two");
        const deleted = yield* a.operation({ command: "delete", session: idA, requestId: "r1" });
        expect(deleted.reply).toEqual({ ok: true, value: { deleted: true, sessionId: idA } });
        expect(
          (yield* a.operation({ command: "delete", session: idA, requestId: "r1" })).reply,
        ).toEqual(deleted.reply);
        expect((yield* a.operation({ command: "status", session: idA })).reply).toMatchObject({
          ok: false,
          error: { code: "no_session" },
        });

        // Cross-launch: A's credentials mean nothing to B.
        expect((yield* b.bootstrap(a.match?.[5])).status).toBe(401);
        expect((yield* b.operation({ command: "list" }, a.cookie)).status).toBe(401);

        // Ctrl-C on A ends A's HTTP lifetime only.
        yield* Fiber.interrupt(a.fiber);
        expect(yield* Effect.promise(() => refused(a.port))).toBe(true);
        expect(daemon.pollUnsafe()).toBeUndefined();
        const afterA = yield* b.operation({ command: "list" });
        expect(afterA.reply.value.sessions.map((session: { id: string }) => session.id)).toEqual([
          idB,
        ]);
        const client = yield* DaemonClient;
        expect(yield* client.request({ command: "status", session: idB })).toMatchObject({
          session: { id: idB },
        });

        yield* Fiber.interrupt(b.fiber);
        expect(yield* Effect.promise(() => refused(b.port))).toBe(true);
        expect(files.size).toBe(1);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 20_000);

  it("reports a successful opener without printing the private URL, and falls back when it fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });
        const open: ViewerOpen = {
          command: "open",
          cwd: "/repo-c",
          scope: { kind: "uncommitted" },
        };

        const opened = yield* startViewer(open, "true");
        expect(opened.printed[0]).toMatch(/^Opened session \S+ in your browser\. Press Ctrl-C/);
        expect(opened.printed.join("").includes("#")).toBe(false);
        yield* Fiber.interrupt(opened.fiber);

        const fallback = yield* startViewer(open, "false");
        expect(fallback.match !== null).toBe(true);
        yield* Fiber.interrupt(fallback.fiber);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 20_000);
});
