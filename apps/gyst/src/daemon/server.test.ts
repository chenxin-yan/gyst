import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { BadArgs, type Reply, ReplySchema, type Request, type Session } from "@gyst/core";
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
} from "effect";
import * as Socket from "effect/socket/Socket";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, publishingContent } from "./capture-doubles.ts";
import { Git } from "./git.ts";
import { Paths } from "./paths.ts";
import { DaemonInfoSchema, daemonVersion } from "./protocol.ts";
import { DaemonServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { inspectSavedSessions, SessionStore } from "./store.ts";
import { readLine, writeLine } from "./wire.ts";

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
const files = new Map<string, Session>();

const git = Layer.succeed(Git, {
  repoRoot: (cwd) =>
    cwd === slowRoot
      ? Deferred.succeed(statusHeld, undefined).pipe(
          Effect.andThen(Deferred.await(statusRelease)),
          Effect.andThen(Effect.fail(new BadArgs({ message: "not a repository" }))),
        )
      : Effect.succeed(cwd),
  capture: (_root, scope) => Effect.succeed(manifestOf(patch, scope)),
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
      Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, store, crypto, publishingContent()))),
    ),
    Layer.provide(paths),
    Layer.provide(platform),
  );
const serverLayer = serverLayerOver(NodeServices.layer);

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySchema));
const exchange = Effect.fn("exchange")(function* (message: unknown) {
  const socket = yield* NodeSocket.makeNet({ path: socketPath });
  const pull = yield* Socket.readerBytes(socket);
  yield* writeLine(socket, JSON.stringify(message));
  return decodeReply(yield* readLine(pull));
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
