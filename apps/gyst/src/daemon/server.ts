import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  BadArgs,
  type CaptureProgress,
  DaemonError,
  DaemonUnreachable,
  type Reply,
  ReplySchema,
  type Request,
  type SubscriptionEvent,
  SubscriptionEventSchema,
} from "@gyst/core";
import {
  Context,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Latch,
  Option,
  type PlatformError,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
} from "effect";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";
import { compare } from "semver";
import { Navigation } from "./navigation.ts";
import { Paths } from "./paths.ts";
import { DaemonMessageSchema, daemonVersion, ProgressLineSchema } from "./protocol.ts";
import { Sessions } from "./sessions.ts";
import { inspectSavedSessions } from "./store.ts";
import { daemonAbsent, readLine } from "./wire.ts";

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonMessageSchema), {
  onExcessProperty: "error",
});
const encodeReply = Schema.encodeSync(Schema.fromJsonString(ReplySchema));
const encodeProgress = Schema.encodeSync(Schema.fromJsonString(ProgressLineSchema));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SubscriptionEventSchema));
type DaemonMessage = typeof DaemonMessageSchema.Type;

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
      const navigation = yield* Navigation;
      const paths = yield* Paths;
      const fs = yield* FileSystem.FileSystem;
      const pid = String(process.pid);

      // Any other connect failure (EACCES, ...) is unknown territory: propagate, never reclaim.
      const daemonAnswers = NodeSocket.makeNet({ path: paths.socketPath }).pipe(
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
        const server = yield* NodeSocketServer.make({ path: privatePath });
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

      const dispatch = (
        request: Request,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void>,
      ): Effect.Effect<unknown, DaemonError> => {
        switch (request.command) {
          case "open":
            return sessions.open(request, onProgress);
          case "list":
            return sessions.list;
          case "status":
            return sessions.status(request);
          case "check":
            return sessions.check(request);
          case "stack":
            return sessions.stack(request);
          case "layer":
            return sessions.layer(request, onProgress);
          case "diff":
            return sessions.diff(request);
          case "files":
            return sessions.files(request);
          case "code":
            return sessions.code(request);
          case "apply":
            return sessions.apply(request);
          case "viewed":
            return sessions.viewed(request);
          // A replaced or deleted snapshot's analysis stops with it, before the reply.
          case "refresh":
            return sessions
              .refresh(request, onProgress)
              .pipe(Effect.tap(({ session }) => navigation.retire(session.id, session.snapshotId)));
          case "delete":
            return sessions
              .delete(request)
              .pipe(Effect.tap(({ sessionId }) => navigation.retire(sessionId)));
          case "definition":
            return navigation.definition(request);
          case "references":
            return navigation.references(request);
          case "identifiers":
            return navigation.identifiers(request);
          case "navigation":
            return navigation.status(request);
        }
      };
      // Accepted connections that have not replied yet; idle shutdown must not interrupt them.
      const active = yield* Ref.make(0);
      const restart = yield* Latch.make(false);
      const instanceId = crypto.randomUUID();
      let draining = false;
      const identityChanged = () =>
        new DaemonUnreachable({
          message:
            "daemon identity changed or upgrade is in progress; no review command was executed",
        });

      /**
       * Streams one session's committed changes: `ready`, then each change, until `deleted`, the
       * client hanging up, or the daemon exiting. A frame the client does not take within a second
       * overflows the subscription: the connection is dropped rather than left silently stale, so
       * the subscriber knows to resynchronize.
       */
      const serveSubscription = Effect.fn("DaemonServer.subscription")(function* (
        message: Extract<DaemonMessage, { readonly subscribe: unknown }>,
        pull: Effect.Effect<unknown, Socket.SocketError>,
        writer: Socket.Writer,
      ) {
        const send = (event: SubscriptionEvent) =>
          writer.write(`${encodeEvent(event)}\n`).pipe(Effect.timeout("1 second"));
        const forward = Effect.gen(function* () {
          if (draining || message.version !== daemonVersion || message.instanceId !== instanceId)
            return yield* send({ kind: "failed", error: identityChanged() });
          const subscribed = yield* Effect.result(sessions.subscribe(message.subscribe));
          if (Result.isFailure(subscribed))
            return yield* send({ kind: "failed", error: subscribed.failure });
          const { version, events } = subscribed.success;
          yield* send({ kind: "ready", daemon: instanceId, ...version });
          while (true) {
            const change = yield* Queue.take(events);
            yield* send(change);
            if (change.kind === "deleted") return;
          }
        });
        // A hang-up ends the subscription now, not at the next change.
        yield* Effect.raceFirst(forward, Effect.forever(pull)).pipe(
          // Destroy rather than end: a stalled reader would hold a graceful close open forever.
          Effect.catchTag("TimeoutError", () => writer.write(new Socket.CloseEvent())),
        );
      });

      const handleConnection = Effect.fnUntraced(
        function* (socket: Socket.Socket) {
          // A subscription gives its count back once classified, so it never holds off a restart
          // or idle exit; the daemon exiting closes it instead.
          let counted = false;
          const uncount = Effect.suspend(() => {
            if (!counted) return Effect.void;
            counted = false;
            return Ref.update(active, (n) => n - 1);
          });
          yield* Effect.acquireRelease(
            Ref.update(active, (n) => n + 1).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  counted = true;
                }),
              ),
            ),
            () => uncount,
          );
          const pull = yield* Socket.readerBytes(socket);
          const line = yield* readLine(pull);
          const writer = yield* socket.writer;
          const writeLine = (text: string) => writer.write(`${text}\n`);
          // Interim progress lines precede the reply, and never hold a capture up: after a client
          // stops reading or hangs up (the Node writer then awaits a drain that never comes), the
          // first write that fails or takes a second ends reporting on this connection.
          let reporting = true;
          const onProgress = (progress: CaptureProgress) =>
            reporting
              ? writeLine(encodeProgress({ progress })).pipe(
                  Effect.timeout("1 second"),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      reporting = false;
                    }),
                  ),
                )
              : Effect.void;
          let restartAfterReply = false;
          const decoded = yield* decodeRequest(line).pipe(
            Effect.mapError(
              (error) =>
                new BadArgs({
                  message: "invalid daemon request; update the CLI if its protocol is older",
                  detail: error.message,
                }),
            ),
            Effect.result,
          );
          if (Result.isFailure(decoded))
            return yield* writeLine(encodeReply({ ok: false, error: decoded.failure }));
          const message = decoded.success;
          if ("subscribe" in message) {
            yield* uncount;
            return yield* serveSubscription(message, pull, writer);
          }
          const reply: Reply = yield* Effect.gen(function* () {
            if ("command" in message && message.command === "daemon.info")
              return { version: daemonVersion, instanceId };
            if ("command" in message) {
              if (message.instanceId !== instanceId || compare(message.version, daemonVersion) <= 0)
                return { restarting: false };
              // Admission and draining change together; no request can slip between them.
              const admitted = yield* Ref.modify(active, (count) => {
                const ready = count === 1 && !draining;
                if (ready) draining = true;
                return [ready, count];
              });
              if (!admitted) return { restarting: false };
              const saved = yield* inspectSavedSessions.pipe(
                Effect.provideService(Paths, paths),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.mapError(
                  () =>
                    new DaemonUnreachable({
                      message: "could not verify saved reviews; daemon restart refused",
                    }),
                ),
                Effect.onError(() =>
                  Effect.sync(() => {
                    draining = false;
                  }),
                ),
              );
              if (saved.fingerprint !== message.fingerprint) {
                draining = false;
                return { restarting: false };
              }
              restartAfterReply = true;
              return { restarting: true };
            }
            if (draining || message.version !== daemonVersion || message.instanceId !== instanceId)
              return yield* Effect.fail(identityChanged());
            return yield* dispatch(message.request, onProgress);
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catchIf(Schema.is(DaemonError), (error) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          yield* writeLine(encodeReply(reply)).pipe(
            Effect.ensuring(restartAfterReply ? restart.open : Effect.void),
          );
        },
        Effect.scoped,
        Effect.catchTag("SocketError", () => Effect.void),
      );

      // Debounce: an open racing the final delete keeps the daemon alive. `isEmpty` queues behind
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
          restart.await,
          signalled,
        ]);
      }).pipe(Effect.scoped, Effect.withSpan("DaemonServer.run"));

      return DaemonServer.of({ run });
    }),
  );
}
