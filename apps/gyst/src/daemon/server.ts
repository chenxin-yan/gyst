import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  BadArgs,
  type BrowserRequest,
  type CaptureProgress,
  DaemonError,
  DaemonUnreachable,
  type Reply,
  ReplySchema,
  type Request,
  type SubscriptionEvent,
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
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";
import { compare } from "semver";
import {
  browserApp,
  firstViewerPort,
  serveViewer,
  type ViewerOperations,
  viewerLink,
  webAssetsOrNotice,
  WebUiDir,
} from "../web/server.ts";
import { Navigation } from "./navigation.ts";
import { makeNavigationAddons } from "./navigation-addon.ts";
import { Paths } from "./paths.ts";
import { DaemonMessageSchema, daemonVersion, ProgressLineSchema } from "./protocol.ts";
import { type Opened, Sessions } from "./sessions.ts";
import { inspectSavedSessions, writeAtomically } from "./store.ts";
import { daemonAbsent, readLine } from "./wire.ts";

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonMessageSchema), {
  onExcessProperty: "error",
});
const encodeReply = Schema.encodeSync(Schema.fromJsonString(ReplySchema));
const encodeProgress = Schema.encodeSync(Schema.fromJsonString(ProgressLineSchema));

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
    /**
     * Serves the socket and the viewer until idle, a signal, or losing the socket path to a newer
     * daemon; silent when one is already live.
     */
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
      const webUiDir = yield* WebUiDir;
      const firstPort = yield* Effect.result(firstViewerPort);
      const addons = yield* makeNavigationAddons(daemonVersion);
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

      /**
       * The viewer's port once it is bound, binding it first if it is not: `run` binds at startup,
       * and an open retries a bind that failed then, so the daemon keeps one port for its life.
       */
      let viewerPort: Effect.Effect<number, DaemonUnreachable> = Effect.die(
        "the daemon is not running",
      );
      const withLink = (opened: Opened) =>
        Effect.map(viewerPort, (port) => ({
          ...opened,
          link: viewerLink(port, opened.session.id),
        }));

      /**
       * The review operations, one use case each, whichever adapter decoded them: the socket
       * carries the CLI's, the HTTP adapter the browser's.
       */
      const dispatch = (
        request: Request | BrowserRequest,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void>,
      ): Effect.Effect<unknown, DaemonError> => {
        switch (request.command) {
          // The viewer is bound first, so an open that could not be shown creates nothing.
          case "open":
            return viewerPort.pipe(
              Effect.andThen(sessions.open(request, onProgress)),
              Effect.tap(({ session }) =>
                "path" in request && request.path !== undefined
                  ? addons.record(session.id, request.path)
                  : Effect.void,
              ),
              Effect.flatMap(withLink),
            );
          case "list":
            return sessions.list;
          case "status":
            return sessions.status(request);
          case "check":
            return sessions.check(request);
          case "stack":
            return sessions.stack(request);
          case "layer":
            return viewerPort.pipe(
              Effect.andThen(sessions.layer(request, onProgress)),
              Effect.tap(({ session }) => addons.inherit(request.session, session.id)),
              Effect.flatMap(withLink),
            );
          case "diff":
            return sessions.diff(request);
          case "files":
            return sessions.files(request);
          case "commits":
            return sessions.commits(request);
          case "code":
            return sessions.code(request);
          case "apply":
            return sessions.apply(request);
          case "viewed":
            return sessions.viewed(request);
          case "conversations":
            return sessions.conversations(request);
          case "messages":
            return sessions.messages(request);
          case "draft":
          case "send":
          case "edit":
          case "retract":
          case "resolve":
          case "discard":
            return sessions.converse(request);
          case "threads":
            return sessions.threads(request);
          // A replaced or deleted snapshot's analysis stops with it, before the reply.
          case "refresh":
            return sessions
              .refresh(request, onProgress)
              .pipe(
                Effect.tap(({ sessionId, snapshotId, replaced }) =>
                  replaced ? navigation.retire(sessionId, snapshotId) : Effect.void,
                ),
              );
          case "delete":
            return sessions
              .delete(request)
              .pipe(
                Effect.tap(({ sessionId }) =>
                  Effect.andThen(navigation.retire(sessionId), addons.forget(sessionId)),
                ),
              );
          case "definition":
            return Effect.flatMap(addons.current(request.session), (addon) =>
              navigation.definition({ ...request, addon }),
            );
          case "references":
            return Effect.flatMap(addons.current(request.session), (addon) =>
              navigation.references({ ...request, addon }),
            );
          case "identifiers":
            return Effect.flatMap(addons.current(request.session), (addon) =>
              navigation.identifiers({ ...request, addon }),
            );
          case "navigation": {
            const { recheck, ...readiness } = request;
            return Effect.flatMap(
              recheck ? addons.recheck(request.session) : addons.current(request.session),
              (addon) => navigation.status({ ...readiness, addon }),
            );
          }
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

      // An HTTP operation counts as active like a socket request, so neither a restart nor idle
      // exit lands in the middle of it. An event stream does not: the daemon exiting ends it.
      const viewerOperations: ViewerOperations = {
        operation: (request) =>
          Effect.acquireUseRelease(
            Ref.update(active, (n) => n + 1),
            () =>
              draining ? Effect.fail(identityChanged()) : dispatch(request, () => Effect.void),
            () => Ref.update(active, (n) => n - 1),
          ),
        subscribe: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (draining) return yield* identityChanged();
              const { version, events } = yield* sessions.subscribe(request);
              return Stream.concat(
                Stream.succeed<SubscriptionEvent>({
                  kind: "ready",
                  daemon: instanceId,
                  ...version,
                }),
                Stream.fromQueue(events).pipe(Stream.takeUntil(({ kind }) => kind === "deleted")),
              );
            }),
          ),
      };

      const handleConnection = Effect.fnUntraced(
        function* (socket: Socket.Socket) {
          yield* Effect.acquireRelease(
            Ref.update(active, (n) => n + 1),
            () => Ref.update(active, (n) => n - 1),
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
      // Lost the path to a concurrent starter: exit. Kept it: make sure `daemon.pid` and the
      // viewer port preference name us.
      const untilOrphaned = Effect.fnUntraced(
        function* (ownsSocket: Effect.Effect<boolean>, ownViewerPort: Effect.Effect<void>) {
          const owns = yield* ownsSocket;
          if (owns && !(yield* ownsPidFile)) yield* writePidFile;
          if (owns) yield* ownViewerPort;
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
        yield* addons.load(new Set((yield* sessions.list).sessions.map(({ id }) => id)));
        // Bound after the socket, so a daemon that lost the socket never holds a port, and closed
        // before it, so the next daemon finds the port free again. Open tabs and SSH forwards name
        // the last daemon's port, so the next one takes it first, even once a lower one is free.
        const scope = yield* Effect.scope;
        let bound: number | undefined;
        const binding = Semaphore.withPermit(yield* Semaphore.make(1));
        const lastPort = fs.readFileString(paths.viewerPortPath).pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => undefined),
        );
        // Only a preference: without it the next daemon scans the range from the start. A starter
        // that loses the socket may record its own port first, so the owner keeps restoring ours.
        const ownViewerPort = Effect.suspend(() => {
          if (bound === undefined) return Effect.void;
          const portLine = `${bound}\n`;
          return fs.readFileString(paths.viewerPortPath).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((content) =>
              content === portLine
                ? Effect.void
                : writeAtomically(paths.viewerPortPath, portLine).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                  ),
            ),
            Effect.ignore,
          );
        });
        viewerPort = binding(
          Effect.suspend(() =>
            bound !== undefined
              ? Effect.succeed(bound)
              : Effect.all([
                  Effect.fromResult(firstPort),
                  webAssetsOrNotice(webUiDir),
                  lastPort,
                ]).pipe(
                  Effect.flatMap(([first, assets, last]) =>
                    serveViewer(first, browserApp(assets, viewerOperations), last),
                  ),
                  Scope.provide(scope),
                  Effect.tap((port) => Effect.sync(() => void (bound = port))),
                  Effect.tap(() => Effect.when(ownViewerPort, ownsSocket)),
                ),
          ),
        );
        yield* Effect.ignore(viewerPort);
        yield* Effect.raceAllFirst([
          server.run(handleConnection),
          untilIdle,
          untilOrphaned(ownsSocket, ownViewerPort),
          restart.await,
          signalled,
        ]);
      }).pipe(Effect.scoped, Effect.withSpan("DaemonServer.run"));

      return DaemonServer.of({ run });
    }),
  );
}
