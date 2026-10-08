import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  BadArgs,
  type Reply,
  ReplySchema,
  type Request,
  type Session,
  type SubscriptionEvent,
  SubscriptionEventSchema,
} from "@gyst/core";
import {
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Socket from "effect/socket/Socket";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, noGitHub, publishingContent } from "./capture-doubles.ts";
import { Git } from "./git.ts";
import { Paths } from "./paths.ts";
import { DaemonInfoSchema, daemonVersion } from "./protocol.ts";
import { DaemonServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { inspectSavedSessions, SessionStore } from "./store.ts";
import { DaemonClient } from "./client.ts";
import { lineReader, writeLine } from "./wire.ts";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;
/** An `open` from here holds the `Sessions` permit until the test releases it, then fails. */
const slowRoot = "/slow";

let dataDir: string;
let socketPath: string;
let statusHeld: Deferred.Deferred<void>;
let statusRelease: Deferred.Deferred<void>;
let progressGate: Deferred.Deferred<void> | undefined;
const files = new Map<string, Session>();

const git = Layer.succeed(Git, {
  repoRoot: (cwd) =>
    cwd === slowRoot
      ? Deferred.succeed(statusHeld, undefined).pipe(
          Effect.andThen(Deferred.await(statusRelease)),
          Effect.andThen(Effect.fail(new BadArgs({ message: "not a repository" }))),
        )
      : Effect.succeed(cwd),
  // Two interim reports, then the manifest: the server must frame them before the reply. With
  // `progressGate` set, the capture waits on it between them.
  capture: (_root, scope, onProgress = () => Effect.void) =>
    Effect.suspend(() => {
      const gate = progressGate;
      return onProgress({ phase: "capture", done: 0, total: 1, bytes: 0 }).pipe(
        Effect.andThen(gate ? Deferred.await(gate) : Effect.void),
        Effect.andThen(onProgress({ phase: "diff", done: 1, total: 1, bytes: 4 })),
        Effect.as(manifestOf(patch, scope)),
      );
    }),
  capturePullRequest: () => Effect.die("no PR captures in this test"),
  pullRequestRange: () => Effect.die("no PR ranges in this test"),
});
const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  save: (session) => Effect.sync(() => void files.set(session.id, session)),
  remove: (id) => Effect.sync(() => void files.delete(id)),
  loadDeleteReceipts: Effect.succeed([]),
  saveDeleteReceipts: () => Effect.void,
});
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const paths = Layer.sync(Paths, () => ({
  dataDir,
  socketPath,
  pidPath: join(dataDir, "daemon.pid"),
  deleteReceiptsPath: join(dataDir, "delete-receipts"),
  sessionFile: (id: string) => join(dataDir, `${id}.json`),
}));
const serverLayerOver = (platform: Layer.Layer<Layer.Success<typeof NodeServices.layer>>) =>
  DaemonServer.layer.pipe(
    Layer.provide(
      Sessions.layer.pipe(
        Layer.provide(Layer.mergeAll(git, noGitHub, store, crypto, publishingContent())),
      ),
    ),
    Layer.provide(paths),
    Layer.provide(platform),
  );
const serverLayer = serverLayerOver(NodeServices.layer);

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySchema));
const exchange = Effect.fn("exchange")(function* (message: unknown) {
  const socket = yield* NodeSocket.makeNet({ path: socketPath });
  const next = lineReader(yield* Socket.readerBytes(socket));
  yield* writeLine(socket, JSON.stringify(message));
  // Interim progress lines come first; the reply is the line with `ok`.
  let line = yield* next;
  while (!("ok" in JSON.parse(line))) line = yield* next;
  return decodeReply(line);
}, Effect.scoped);
const send = Effect.fn("send")(function* (request: Request) {
  const hello = yield* exchange({ command: "daemon.info" });
  if (!hello.ok) return hello;
  const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
  return yield* exchange({ ...info, request });
});
const open = (cwd: string) => send({ command: "open", cwd, scope: { kind: "uncommitted" } });
const openedId = (reply: Reply) => {
  if (!reply.ok) throw new Error(`open failed: ${reply.error.message}`);
  return (reply.value as { session: { id: string } }).session.id;
};
const remove = (session: string) => send({ command: "delete", session, requestId: session });
const ok = (reply: Reply) => reply.ok;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-server-"));
  socketPath = join(dataDir, "daemon.sock");
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe("DaemonServer", () => {
  it("keeps an open queued behind the idle check alive during final-session shutdown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        statusHeld = yield* Deferred.make<void>();
        statusRelease = yield* Deferred.make<void>();
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        yield* Effect.retry(send({ command: "list" }), {
          schedule: Schedule.spaced("10 millis"),
          times: 100,
        });

        expect(ok(yield* remove(openedId(yield* open("/first"))))).toBe(true);
        // The final delete opened the idle latch; a slow open now holds the permit, so the idle
        // check queues behind it after its debounce, and the replacement open queues behind that.
        const slow = yield* Effect.forkChild(open(slowRoot));
        yield* Deferred.await(statusHeld);
        yield* Effect.sleep("100 millis");
        const replacement = yield* Effect.forkChild(open("/replacement"));
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(statusRelease, undefined);

        expect(ok(yield* Fiber.join(slow))).toBe(false);
        const id = openedId(yield* Fiber.join(replacement));
        expect(ok(yield* send({ command: "status", session: id }))).toBe(true);
        expect(ok(yield* remove(id))).toBe(true);
        yield* Fiber.join(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("guards restart by identity, version, saved bytes and in-flight requests", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        statusHeld = yield* Deferred.make<void>();
        statusRelease = yield* Deferred.make<void>();
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        const saved = yield* inspectSavedSessions;
        const restart = {
          command: "daemon.restart",
          version: "999.0.0",
          instanceId: info.instanceId,
          fingerprint: saved.fingerprint,
        };
        for (const invalid of [
          { ...restart, instanceId: "another-daemon" },
          { ...restart, version: daemonVersion },
          { ...restart, version: "0.0.0" },
          { ...restart, fingerprint: "changed-after-inspection" },
        ])
          expect(yield* exchange(invalid)).toEqual({ ok: true, value: { restarting: false } });
        expect(
          ok(
            yield* exchange({
              ...info,
              instanceId: "another-daemon",
              request: { command: "open", cwd: "/wrong", scope: { kind: "uncommitted" } },
            }),
          ),
        ).toBe(false);
        expect(files.size).toBe(0);
        const fs = yield* FileSystem.FileSystem;
        const changed = join(dataDir, "changed.json");
        yield* fs.writeFileString(changed, "{}");
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: false } });
        expect(yield* fs.readFileString(changed)).toBe("{}");
        yield* fs.remove(changed);
        const slow = yield* Effect.forkChild(open(slowRoot));
        yield* Deferred.await(statusHeld);
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: false } });
        yield* Deferred.succeed(statusRelease, undefined);
        yield* Fiber.join(slow);
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: true } });
        yield* Fiber.join(running);
      }).pipe(
        Effect.provide(serverLayer),
        Effect.provide(paths),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect((await readdir(dataDir)).filter((name) => name.startsWith("daemon.sock"))).toEqual([]);
  }, 10_000);

  it("rejects argv, removed operations, directory selection and missing intent before any use case runs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        for (const request of [
          { command: "create", cwd: "/argv", revisions: [], patch },
          { command: "close", session: "x" },
          { command: "open", cwd: "/argv", scope: { kind: "uncommitted" }, args: ["--stat"] },
          { command: "open", cwd: "/argv", scope: { kind: "range", range: "a..b", pathspecs: [] } },
          { command: "status", cwd: "/argv" },
          { command: "status", session: "x", args: ["--session", "x"] },
          { command: "apply", session: "x", batch: "{}", file: "a.txt" },
          { command: "refresh", session: "x", patch },
          { command: "delete", session: "x" },
          { command: "apply", session: "x" },
        ]) {
          const reply = yield* exchange({ ...info, request });
          expect(reply.ok ? reply : reply.error).toMatchObject({
            _tag: "bad_args",
            message: "invalid daemon request; update the CLI if its protocol is older",
          });
        }
        expect(files.size).toBe(0);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("writes capture progress lines before the reply, which clients with or without a handler decode", async () => {
    const progress = [
      { phase: "capture", done: 0, total: 1, bytes: 0 },
      { phase: "diff", done: 1, total: 1, bytes: 4 },
    ];
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);

        // On the wire: one JSON line per report, in order, then the one Reply line.
        const lines = yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({ path: socketPath });
            const next = lineReader(yield* Socket.readerBytes(socket));
            yield* writeLine(
              socket,
              JSON.stringify({
                ...info,
                request: { command: "open", cwd: "/progress-raw", scope: { kind: "uncommitted" } },
              }),
            );
            return [yield* next, yield* next, yield* next];
          }),
        );
        expect(lines.slice(0, 2).map((line) => JSON.parse(line))).toEqual(
          progress.map((event) => ({ progress: event })),
        );
        expect(decodeReply(lines[2]!).ok).toBe(true);

        const client = yield* DaemonClient;
        const heard: unknown[] = [];
        const opened = (yield* client.request(
          { command: "open", cwd: "/progress-client", scope: { kind: "uncommitted" } },
          (event) => Effect.sync(() => void heard.push(event)),
        )) as { session: { id: string } };
        expect(heard).toEqual(progress);
        // Without a handler the interim lines are skipped and the reply still decodes.
        const refreshed = (yield* client.request({
          command: "refresh",
          session: opened.session.id,
        })) as { session: { id: string } };
        expect(refreshed.session.id).toBe(opened.session.id);
        // A reuse captures nothing, so it reports nothing.
        heard.length = 0;
        yield* client.request(
          { command: "open", cwd: "/progress-client", scope: { kind: "uncommitted" } },
          (event) => Effect.sync(() => void heard.push(event)),
        );
        expect(heard).toEqual([]);
        yield* Fiber.interrupt(running);
      }).pipe(
        Effect.provide(
          Layer.merge(
            serverLayer,
            DaemonClient.layer.pipe(Layer.provide(paths), Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
    );
  }, 10_000);

  it("finishes and publishes a capture whose client disconnected between progress reports", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        const gate = yield* Deferred.make<void>();
        progressGate = gate;
        // Read the first report, then hang up while the capture is held.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({ path: socketPath });
            const next = lineReader(yield* Socket.readerBytes(socket));
            yield* writeLine(
              socket,
              JSON.stringify({
                ...info,
                request: { command: "open", cwd: "/disconnected", scope: { kind: "uncommitted" } },
              }),
            );
            expect(JSON.parse(yield* next)).toHaveProperty("progress");
          }),
        );
        progressGate = undefined;
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(gate, undefined);
        const published = () =>
          [...files.values()].some((session) => session.repoRoot === "/disconnected");
        yield* Effect.sync(published).pipe(
          Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("2 seconds"),
        );
        // The source lock was released: the next capture runs and reports to its own client.
        const reply = yield* open("/after-disconnect").pipe(Effect.timeout("2 seconds"));
        expect(reply.ok).toBe(true);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("lets a client skip interim lines it does not understand and still decode the reply", async () => {
    const fakeSocket = join(dataDir, "interim.sock");
    const peer = createServer((socket) => {
      let buffered = "";
      socket.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        if (!buffered.includes("\n")) return;
        const message = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
        const lines =
          message.command === "daemon.info"
            ? [{ ok: true, value: { version: daemonVersion, instanceId: "interim" } }]
            : [
                { future: "a line kind this client predates" },
                null,
                "a future string line",
                ["an", "array"],
                { progress: { phase: "a later phase", done: 1 } },
                { progress: { phase: "capture", done: 1, total: 2, bytes: 3 } },
                { ok: true, value: { sessions: [] } },
              ];
        const framed = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
        socket.end(message.command === "daemon.info" ? framed : `not json {\n${framed}`);
      });
    });
    await new Promise<void>((resolve) => peer.listen(fakeSocket, resolve));
    try {
      const heard: unknown[] = [];
      const reply = await Effect.runPromise(
        DaemonClient.use((client) =>
          client.request({ command: "list" }, (event) => Effect.sync(() => void heard.push(event))),
        ).pipe(
          Effect.provide(
            DaemonClient.layer.pipe(
              Layer.provide(
                Layer.succeed(Paths, {
                  dataDir,
                  socketPath: fakeSocket,
                  pidPath: join(dataDir, "interim.pid"),
                  deleteReceiptsPath: join(dataDir, "interim-receipts"),
                  sessionFile: (id: string) => join(dataDir, `interim-${id}.json`),
                }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
      expect(reply).toEqual({ sessions: [] });
      expect(heard).toEqual([{ phase: "capture", done: 1, total: 2, bytes: 3 }]);
    } finally {
      await new Promise((resolve) => peer.close(resolve));
    }
  });

  it("releases the published socket when startup fails after the link", async () => {
    // A failing unlink of the private name must not leave `daemon.sock` behind: the release for the
    // shared name has to be registered before anything else fallible runs.
    const failedOnce = { done: false };
    const brokenRemove = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.make({
          ...fs,
          remove: (path, options) =>
            path === `${socketPath}.${process.pid}` && options === undefined && !failedOnce.done
              ? Effect.sync(() => void (failedOnce.done = true)).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.badArgument({
                        module: "test",
                        method: "remove",
                        description: "injected",
                      }),
                    ),
                  ),
                )
              : fs.remove(path, options),
        }),
      ),
    );
    const exit = await Effect.runPromiseExit(
      DaemonServer.use((server) => server.run).pipe(
        Effect.provide(serverLayerOver(Layer.provideMerge(brokenRemove, NodeServices.layer))),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect((await readdir(dataDir)).filter((name) => name.startsWith("daemon.sock"))).toEqual([]);
  });
});

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SubscriptionEventSchema), {
  onExcessProperty: "error",
});
type Info = typeof DaemonInfoSchema.Type;
/** Starts the daemon and returns its fiber and identity once it answers. */
const started = Effect.gen(function* () {
  const server = yield* DaemonServer;
  const running = yield* Effect.forkChild(server.run);
  const hello = yield* exchange({ command: "daemon.info" }).pipe(
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
  );
  if (!hello.ok) throw new Error("handshake failed");
  return { running, info: Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value) };
});
/** A raw subscription over the socket; each pull is the next decoded frame. */
const subscribeRaw = Effect.fn("subscribeRaw")(function* (message: unknown) {
  const socket = yield* NodeSocket.makeNet({ path: socketPath });
  const next = lineReader(yield* Socket.readerBytes(socket));
  yield* writeLine(socket, JSON.stringify(message));
  return Effect.map(next, decodeEvent);
});
const subscribe = (info: Info, session: string) =>
  subscribeRaw({ ...info, subscribe: { session } });
/** The daemon ended the connection: the next read sees a clean close. */
const ended = (next: Effect.Effect<SubscriptionEvent, Socket.SocketError>) =>
  next.pipe(
    Effect.flip,
    Effect.map((error) => error.reason._tag),
    Effect.timeout("2 seconds"),
  );
const versionOf = (id: string) => {
  const session = files.get(id)!;
  return { sessionId: id, snapshotId: session.snapshotId, revision: session.revision };
};
/** Toggles Viewed on the session's first hunk against its saved revision. */
const toggle = (info: Info, id: string, n: number) => {
  const session = files.get(id)!;
  return exchange({
    ...info,
    request: {
      command: "viewed",
      session: id,
      snapshotId: session.snapshotId,
      revision: session.revision,
      requestId: `${id}-${n}`,
      hunkIds: [session.hunks[0]!.id],
      viewed: n % 2 === 0,
    },
  });
};

describe("DaemonServer subscriptions", () => {
  // Each test's daemon loads `files`; earlier tests leave sessions there.
  beforeEach(() => files.clear());

  it("streams ready, each committed change, then deleted and EOF", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const id = openedId(yield* open("/subscribed"));
        const next = yield* subscribe(info, id);
        expect(yield* next).toEqual({ kind: "ready", daemon: info.instanceId, ...versionOf(id) });
        expect(ok(yield* toggle(info, id, 0))).toBe(true);
        expect(yield* next).toEqual({ kind: "changed", ...versionOf(id) });
        expect(ok(yield* toggle(info, id, 1))).toBe(true);
        expect(yield* next).toEqual({ kind: "changed", ...versionOf(id) });
        expect(ok(yield* remove(id))).toBe(true);
        expect(yield* next).toEqual({ kind: "deleted", sessionId: id });
        expect(yield* ended(next)).toBe("SocketCloseError");
        // Nothing else holds the daemon: the final delete still lets it exit idle.
        yield* Fiber.join(running).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.scoped, Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("refuses an unknown session or a stale identity with one failed frame", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const id = openedId(yield* open("/refused"));
        const before = files.get(id);
        const unknown = yield* subscribe(info, "missing");
        expect(yield* unknown).toMatchObject({ kind: "failed", error: { _tag: "no_session" } });
        expect(yield* ended(unknown)).toBe("SocketCloseError");
        for (const stale of [
          { ...info, instanceId: "another-daemon" },
          { ...info, version: "0.0.0" },
        ]) {
          const next = yield* subscribeRaw({ ...stale, subscribe: { session: id } });
          expect(yield* next).toMatchObject({
            kind: "failed",
            error: { _tag: "daemon_unreachable", message: expect.stringContaining("identity") },
          });
          expect(yield* ended(next)).toBe("SocketCloseError");
        }
        // An excess field is a bad request, answered like any other, not a subscription.
        const reply = yield* exchange({ ...info, subscribe: { session: id, extra: true } });
        expect(reply.ok ? reply : reply.error).toMatchObject({ _tag: "bad_args" });
        expect(files.get(id)).toBe(before);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.scoped, Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("never misses a mutation that races the subscription", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const id = openedId(yield* open("/race"));
        const seen = { inReady: 0, asChange: 0 };
        for (let n = 0; n < 20; n++) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const [next, mutated] = yield* Effect.all(
                [
                  Effect.sleep(`${n % 4} millis`).pipe(Effect.andThen(subscribe(info, id))),
                  toggle(info, id, n),
                ],
                { concurrency: "unbounded" },
              );
              expect(ok(mutated)).toBe(true);
              const final = versionOf(id).revision;
              const ready = yield* next;
              if (ready.kind !== "ready") throw new Error(`expected ready, got ${ready.kind}`);
              if (ready.revision === final) return void seen.inReady++;
              expect(yield* next.pipe(Effect.timeout("2 seconds"))).toEqual({
                kind: "changed",
                ...versionOf(id),
              });
              seen.asChange++;
            }),
          );
        }
        expect(seen.inReady + seen.asChange).toBe(20);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 20_000);

  it("drops a subscriber that stops reading, which resubscribes at the final revision", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const id = openedId(yield* open("/overflow"));
        // Never read: the daemon's writes back up until one takes longer than a second.
        const stalled = createConnection(socketPath);
        stalled.on("error", () => {});
        yield* Effect.promise(() => once(stalled, "connect"));
        stalled.write(`${JSON.stringify({ ...info, subscribe: { session: id } })}\n`);
        const deadline = Date.now() + 15_000;
        let n = 0;
        while (!stalled.destroyed && Date.now() < deadline) {
          expect(ok(yield* toggle(info, id, n++))).toBe(true);
          // The daemon reads and ignores these; once it has dropped the connection, writing fails.
          if (n % 50 === 0) stalled.write(" ");
        }
        expect(stalled.destroyed).toBe(true);
        const next = yield* subscribe(info, id);
        expect(yield* next).toEqual({ kind: "ready", daemon: info.instanceId, ...versionOf(id) });
        expect(versionOf(id).revision).toBe(n);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.scoped, Effect.provide(serverLayer)),
    );
  }, 30_000);

  it("admits a newer daemon's restart with a subscription open, which then ends", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          const id = openedId(yield* open("/restart"));
          expect(ok(yield* toggle(info, id, 0))).toBe(true);
          const next = yield* subscribe(info, id);
          expect(yield* next).toMatchObject({ kind: "ready", revision: versionOf(id).revision });
          const saved = yield* inspectSavedSessions;
          expect(
            yield* exchange({
              command: "daemon.restart",
              version: "999.0.0",
              instanceId: info.instanceId,
              fingerprint: saved.fingerprint,
            }),
          ).toEqual({ ok: true, value: { restarting: true } });
          expect(yield* ended(next)).toBe("SocketCloseError");
          yield* Fiber.join(running).pipe(Effect.timeout("2 seconds"));
          return { info, id };
        }).pipe(Effect.scoped, Effect.provide(serverLayer));
        // The next daemon is a new generation over the same committed state.
        yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          expect(info.instanceId).not.toBe(first.info.instanceId);
          const next = yield* subscribe(info, first.id);
          expect(yield* next).toEqual({
            kind: "ready",
            daemon: info.instanceId,
            ...versionOf(first.id),
          });
          expect(versionOf(first.id).revision).toBe(1);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.scoped, Effect.provide(serverLayer));
      }).pipe(Effect.provide(paths), Effect.provide(NodeServices.layer)),
    );
  }, 10_000);
});

describe("DaemonClient.subscribe over the daemon socket", () => {
  beforeEach(() => files.clear());
  const clientLayer = DaemonClient.layer.pipe(
    Layer.provide(paths),
    Layer.provide(NodeServices.layer),
  );

  it("yields ready then changes, fails for an unknown session, and closes when the consumer stops", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const client = yield* DaemonClient;
        const id = openedId(yield* open("/client"));
        expect(
          yield* client.subscribe({ session: "missing" }).pipe(Stream.runCollect, Effect.flip),
        ).toMatchObject({ _tag: "no_session" });

        const heard: SubscriptionEvent[] = [];
        const consumer = yield* Effect.forkChild(
          Stream.runForEach(client.subscribe({ session: id }), (event) =>
            Effect.sync(() => void heard.push(event)),
          ),
        );
        const heardCount = (count: number) =>
          Effect.sync(() => heard.length).pipe(
            Effect.repeat({ until: (n) => n >= count, schedule: Schedule.spaced("5 millis") }),
            Effect.timeout("2 seconds"),
          );
        yield* heardCount(1);
        expect(ok(yield* toggle(info, id, 0))).toBe(true);
        yield* heardCount(2);
        expect(heard).toEqual([
          { kind: "ready", daemon: info.instanceId, ...versionOf(id), revision: 0 },
          { kind: "changed", ...versionOf(id) },
        ]);
        yield* Fiber.interrupt(consumer);
        expect(ok(yield* toggle(info, id, 1))).toBe(true);
        const again = yield* client
          .subscribe({ session: id })
          .pipe(Stream.take(1), Stream.runCollect);
        expect(again).toEqual([{ kind: "ready", daemon: info.instanceId, ...versionOf(id) }]);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(Layer.merge(serverLayer, clientLayer))),
    );
  }, 10_000);

  it("ends when the daemon exits, and resubscribing reaches the next daemon at the same revision", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DaemonClient;
        const first = yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          const id = openedId(yield* open("/client-restart"));
          expect(ok(yield* toggle(info, id, 0))).toBe(true);
          const heard: SubscriptionEvent[] = [];
          const consumer = yield* Effect.forkChild(
            Stream.runForEach(client.subscribe({ session: id }), (event) =>
              Effect.sync(() => void heard.push(event)),
            ),
          );
          yield* Effect.sync(() => heard.length).pipe(
            Effect.repeat({ until: (n) => n >= 1, schedule: Schedule.spaced("5 millis") }),
            Effect.timeout("2 seconds"),
          );
          yield* Fiber.interrupt(running);
          // A daemon exit is a clean end of the stream, not a failure.
          yield* Fiber.join(consumer).pipe(Effect.timeout("2 seconds"));
          expect(heard).toEqual([{ kind: "ready", daemon: info.instanceId, ...versionOf(id) }]);
          return { info, id };
        }).pipe(Effect.provide(serverLayer));
        yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          expect(info.instanceId).not.toBe(first.info.instanceId);
          const again = yield* client
            .subscribe({ session: first.id })
            .pipe(Stream.take(1), Stream.runCollect);
          expect(again).toEqual([
            { kind: "ready", daemon: info.instanceId, ...versionOf(first.id), revision: 1 },
          ]);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(serverLayer));
      }).pipe(Effect.provide(clientLayer)),
    );
  }, 10_000);
});
