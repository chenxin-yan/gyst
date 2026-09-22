import { BunSocket, BunSocketServer } from "@effect/platform-bun";
import {
  BadArgs,
  DaemonError,
  type Reply,
  ReplySchema,
  type Request,
  RequestSchema,
} from "@gyst/core";
import {
  Context,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Ref,
  Schedule,
  Schema,
} from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import type * as SocketServer from "effect/unstable/socket/SocketServer";
import { Paths } from "./paths.ts";
import { Sessions } from "./sessions.ts";
import { daemonAbsent, readLine, writeLine } from "./wire.ts";

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema));
const encodeReply = Schema.encodeSync(Schema.fromJsonString(ReplySchema));

const isAlreadyExists = (error: PlatformError.PlatformError | Socket.SocketError) =>
  error._tag === "PlatformError" && error.reason._tag === "AlreadyExists";

// SIGINT is crust's: `execute()` aborts the invocation signal and `handler()` interrupts the fiber.
const signalled = Effect.callback<void>((resume) => {
  const stop = () => resume(Effect.void);
  process.once("SIGTERM", stop);
  return Effect.sync(() => {
    process.off("SIGTERM", stop);
  });
});

export class DaemonServer extends Context.Service<
  DaemonServer,
  {
    /** Serves until idle, a signal, or losing the socket path to a newer daemon; silent when one is already live. */
    readonly run: Effect.Effect<
      void,
      SocketServer.SocketServerError | Socket.SocketError | PlatformError.PlatformError
    >;
  }
>()("gyst/daemon/DaemonServer") {
  static readonly layer = Layer.effect(
    DaemonServer,
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const paths = yield* Paths;
      const fs = yield* FileSystem.FileSystem;
      const pid = String(process.pid);

      // Any other connect failure (EACCES, ...) is unknown territory: propagate, never reclaim.
      const daemonAnswers = BunSocket.makeNet({ path: paths.socketPath }).pipe(
        Effect.flatMap((socket) => socket.reader),
        Effect.as(true),
        Effect.scoped,
        Effect.catchIf(daemonAbsent, () => Effect.succeed(false)),
      );

      /**
       * The daemon listens on a private name and publishes it with `link`, an atomic
       * create-if-absent: the first starter owns `daemon.sock`, later ones connect to it and
       * exit. A dead owner leaves a stale file; it is removed only if its inode is unchanged
       * since the probe, so a rival's fresh publish is never removed. Node unlinks the *bound*
       * name on `server.close()`, which is the private one, so an exiting loser (or a daemon
       * that lost the path) never removes the winner's socket. Unix only: sockets accept hard
       * links on Linux and macOS.
       */
      const acquireSocket = Effect.gen(function* () {
        const privatePath = `${paths.socketPath}.${pid}`;
        yield* fs.remove(privatePath, { force: true });
        const server = yield* BunSocketServer.make({ path: privatePath });
        const ino = (yield* fs.stat(privatePath)).ino;
        const publishedIno = fs.stat(paths.socketPath).pipe(
          Effect.map((info) => info.ino),
          Effect.orElseSucceed(() => Option.none<number>()),
        );
        const ownsSocket = Effect.map(publishedIno, (published) => Equal.equals(published, ino));
        const reclaimStale = Effect.gen(function* () {
          const stale = yield* publishedIno;
          if (yield* daemonAnswers) return false;
          if (Equal.equals(yield* publishedIno, stale))
            yield* fs.remove(paths.socketPath, { force: true });
          return true;
        });
        // The acquisition is the link alone: its release is registered only if the whole acquisition
        // succeeds, so nothing fallible may follow the link inside it.
        const published = yield* Effect.acquireRelease(
          fs.link(privatePath, paths.socketPath).pipe(
            Effect.retry({
              while: (error) => (isAlreadyExists(error) ? reclaimStale : Effect.succeed(false)),
            }),
            Effect.as(true),
            Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
          ),
          (owned) =>
            owned
              ? Effect.when(fs.remove(paths.socketPath, { force: true }), ownsSocket).pipe(
                  Effect.ignore,
                )
              : Effect.void,
        );
        // Only the shared name remains, so a SIGKILL leaves one stale file and nothing else.
        if (published) yield* fs.remove(privatePath);
        return published ? Option.some({ server, ownsSocket }) : Option.none();
      });

      const pidLine = `${pid}\n`;
      const ownsPidFile = fs.readFileString(paths.pidPath).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((content) => content === pidLine),
      );
      const writePidFile = fs.writeFileString(paths.pidPath, pidLine, { mode: 0o600 });
      const acquirePidFile = Effect.acquireRelease(writePidFile, () =>
        Effect.when(fs.remove(paths.pidPath, { force: true }), ownsPidFile).pipe(Effect.ignore),
      );

      const handlers: Record<
        Request["command"],
        (request: Request) => Effect.Effect<unknown, DaemonError>
      > = { ...sessions, "tui.action": (request) => sessions.tuiAction(request) };
      // Accepted connections that have not replied yet; idle shutdown must not interrupt them.
      const active = yield* Ref.make(0);
      const handleConnection = Effect.fnUntraced(
        function* (socket: Socket.Socket) {
          yield* Effect.acquireRelease(
            Ref.update(active, (n) => n + 1),
            () => Ref.update(active, (n) => n - 1),
          );
          const line = yield* readLine(yield* Socket.readerBytes(socket));
          const reply: Reply = yield* decodeRequest(line).pipe(
            Effect.mapError(
              (error) => new BadArgs({ message: "invalid daemon request", detail: error.message }),
            ),
            Effect.flatMap((request) => handlers[request.command](request)),
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catchIf(Schema.is(DaemonError), (error) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          yield* writeLine(socket, encodeReply(reply));
        },
        Effect.scoped,
        Effect.catchTag("SocketError", () => Effect.void),
      );

      // Debounce: a create racing the final close keeps the daemon alive. `isEmpty` queues behind
      // in-flight commands, so a connection accepted meanwhile has counted itself by the time
      // `active` is read; that order matters.
      const untilIdle = sessions.idle.pipe(
        Effect.andThen(Effect.sleep("20 millis")),
        Effect.andThen(sessions.isEmpty),
        Effect.flatMap((empty) => Effect.map(Ref.get(active), (n) => empty && n === 0)),
        Effect.repeat({ until: (idle) => idle }),
      );
      // Lost the path to a concurrent starter: exit. Kept it: make sure `daemon.pid` names us.
      const untilOrphaned = Effect.fnUntraced(
        function* (ownsSocket: Effect.Effect<boolean>) {
          const owns = yield* ownsSocket;
          if (owns && !(yield* ownsPidFile)) yield* writePidFile;
          return owns;
        },
        Effect.repeat({ while: (owns) => owns, schedule: Schedule.spaced("1 second") }),
      );

      const run = Effect.gen(function* () {
        const acquired = yield* acquireSocket;
        if (Option.isNone(acquired)) return;
        const { server, ownsSocket } = acquired.value;
        yield* acquirePidFile;
        // Only the socket owner reads the store: a rival may have changed it since we started.
        yield* sessions.load;
        yield* Effect.raceAllFirst([
          server.run(handleConnection),
          untilIdle,
          untilOrphaned(ownsSocket),
          signalled,
        ]);
      }).pipe(Effect.scoped, Effect.withSpan("DaemonServer.run"));

      return DaemonServer.of({ run });
    }),
  );
}
