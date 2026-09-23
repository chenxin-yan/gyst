import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunServices, BunSocket } from "@effect/platform-bun";
import { type Reply, ReplySchema, type Request, type Session } from "@gyst/core";
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
import * as Socket from "effect/unstable/socket/Socket";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "./git.ts";
import { Paths } from "./paths.ts";
import { DaemonServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { SessionStore } from "./store.ts";
import { readLine, writeLine } from "./wire.ts";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;
/** A `status` from here holds the `Sessions` permit until the test releases it. */
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
          Effect.as(cwd),
        )
      : Effect.succeed(cwd),
  patch: () => Effect.succeed(patch),
});
const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => ({ sessions: [...files.values()], incompatible: [] })),
  save: (session) => Effect.sync(() => void files.set(session.id, session)),
  remove: (id) => Effect.sync(() => void files.delete(id)),
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
  sessionFile: (id: string) => join(dataDir, `${id}.json`),
}));
const serverLayerOver = (platform: Layer.Layer<Layer.Success<typeof BunServices.layer>>) =>
  DaemonServer.layer.pipe(
    Layer.provide(Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, store, crypto)))),
    Layer.provide(paths),
    Layer.provide(platform),
  );
const serverLayer = serverLayerOver(BunServices.layer);

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySchema));
const send = Effect.fn("send")(function* (command: Request["command"], cwd: string) {
  const socket = yield* BunSocket.makeNet({ path: socketPath });
  const pull = yield* Socket.readerBytes(socket);
  yield* writeLine(socket, JSON.stringify({ command, cwd, args: [] } satisfies Request));
  return decodeReply(yield* readLine(pull));
}, Effect.scoped);
const ok = (reply: Reply) => reply.ok;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-server-"));
  socketPath = join(dataDir, "daemon.sock");
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe("DaemonServer", () => {
  it("keeps a create queued behind the idle check alive during final-session shutdown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        statusHeld = yield* Deferred.make<void>();
        statusRelease = yield* Deferred.make<void>();
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        yield* Effect.retry(send("status", "/none"), {
          schedule: Schedule.spaced("10 millis"),
          times: 100,
        });

        expect(ok(yield* send("create", "/first"))).toBe(true);
        expect(ok(yield* send("close", "/first"))).toBe(true);
        // The final close opened the idle latch; a slow status now holds the permit, so the idle
        // check queues behind it after its debounce, and the replacement create queues behind that.
        const status = yield* Effect.forkChild(send("status", slowRoot));
        yield* Deferred.await(statusHeld);
        yield* Effect.sleep("100 millis");
        const create = yield* Effect.forkChild(send("create", "/replacement"));
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(statusRelease, undefined);

        expect(ok(yield* Fiber.join(status))).toBe(false);
        expect(ok(yield* Fiber.join(create))).toBe(true);
        expect(ok(yield* send("status", "/replacement"))).toBe(true);
        expect(ok(yield* send("close", "/replacement"))).toBe(true);
        yield* Fiber.join(running);
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
        Effect.provide(serverLayerOver(Layer.provideMerge(brokenRemove, BunServices.layer))),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect((await readdir(dataDir)).filter((name) => name.startsWith("daemon.sock"))).toEqual([]);
  });
});
