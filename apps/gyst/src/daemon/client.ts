import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type CaptureProgress,
  CodePayloadSchema,
  type DaemonError,
  DaemonUnreachable,
  DeletePayloadSchema,
  DiffPayloadSchema,
  ExportPayloadSchema,
  ExportPreviewPayloadSchema,
  FilesPayloadSchema,
  ListPayloadSchema,
  OpenPayloadSchema,
  RefreshPayloadSchema,
  StatusPayloadSchema,
  ThreadsPayloadSchema,
  SourceCheckPayloadSchema,
  StackPayloadSchema,
  ReplySchema,
  type Request,
} from "@gyst/core";
import { Context, Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Socket from "effect/socket/Socket";
import { compare } from "semver";
import { Paths } from "./paths.ts";
import {
  DaemonInfoSchema,
  DaemonMessageSchema,
  daemonVersion,
  ProgressLineSchema,
  RestartReplySchema,
} from "./protocol.ts";
import { inspectSavedSessions } from "./store.ts";
import { daemonAbsent, lineReader, writeLine } from "./wire.ts";

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(DaemonMessageSchema));
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(ReplySchema));
const decodeProgress = Schema.decodeUnknownOption(ProgressLineSchema, {
  onExcessProperty: "error",
});

/** A line's JSON value, or `undefined` for a line that is not JSON. */
const jsonOf = (line: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(line) };
  } catch {
    return undefined;
  }
};
/** The reply is a JSON object with `ok`; every other line shape is interim. */
const isReplyLine = (line: { readonly value: unknown } | undefined) =>
  typeof line?.value === "object" &&
  line.value !== null &&
  !Array.isArray(line.value) &&
  "ok" in line.value;

// Five seconds: a cold source-mode start on a loaded machine takes well over one.
const startupPolls = Schedule.max([Schedule.spaced("20 millis"), Schedule.recurs(250)]);

/**
 * A hang-up after connecting does not prove whether the daemon read the frame; resending a
 * handshake is safe by protocol instead: `daemon.info` is read-only, and the daemon admits
 * `daemon.restart` only for its own instance, a newer version and unchanged saved reviews, then
 * drains, so a repeat is refused.
 */
const handshakeHungUp = (error: { readonly _tag: string }) =>
  Socket.isSocketError(error) && error.reason._tag !== "SocketOpenError";

export class DaemonClient extends Context.Service<
  DaemonClient,
  {
    /**
     * `onProgress` hears the capture progress an `open` or `refresh` reports before its reply.
     * Interim lines it does not understand are skipped; only the reply line decides the result.
     */
    request(
      request: Request,
      onProgress?: (progress: CaptureProgress) => Effect.Effect<void>,
    ): Effect.Effect<unknown, DaemonError>;
  }
>()("gyst/daemon/DaemonClient") {
  static readonly layer = Layer.effect(
    DaemonClient,
    Effect.gen(function* () {
      const paths = yield* Paths;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // The reader dials, so it is acquired before anything is written. Without `onInterim` the
      // first line is the reply (control messages); with it, lines are read until one is a reply,
      // and every JSON value before it goes to `onInterim` (other lines are skipped).
      const exchange = Effect.fn("DaemonClient.exchange")(function* (
        line: string,
        onInterim?: (value: unknown) => Effect.Effect<void>,
      ) {
        const socket = yield* NodeSocket.makeNet({ path: paths.socketPath });
        const next = lineReader(yield* Socket.readerBytes(socket));
        yield* writeLine(socket, line);
        while (true) {
          const received = yield* next;
          if (!onInterim) return received;
          const json = jsonOf(received);
          if (isReplyLine(json)) return received;
          if (json) yield* onInterim(json.value);
        }
      }, Effect.scoped);

      const spawnDaemon = Effect.gen(function* () {
        // The running entry (Node resolves it to an absolute path) serves `daemon run` too.
        const entry = process.argv[1];
        if (entry === undefined)
          return yield* new DaemonUnreachable({
            message: "could not start daemon",
            detail: "no entry script to relaunch",
          });
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [entry, "daemon", "run"], {
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* handle.unref;
      }).pipe(
        Effect.scoped,
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new DaemonUnreachable({ message: "could not start daemon", detail: error.message }),
          ),
        ),
      );

      const controlExchange = (line: string) =>
        exchange(line).pipe(
          Effect.timeout("2 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new DaemonUnreachable({
                message: "daemon compatibility check timed out; no review command was sent",
              }),
            ),
          ),
        );
      const connect = (line: string) =>
        controlExchange(line).pipe(
          // An old daemon exiting after an accepted restart can hang up before or after reading the frame.
          Effect.retry({ while: handshakeHungUp, schedule: startupPolls }),
          Effect.catchIf(daemonAbsent, () =>
            spawnDaemon.pipe(
              Effect.andThen(
                controlExchange(line).pipe(
                  Effect.retry({ while: daemonAbsent, schedule: startupPolls }),
                ),
              ),
              Effect.catchIf(daemonAbsent, () =>
                Effect.fail(new DaemonUnreachable({ message: "daemon did not become reachable" })),
              ),
            ),
          ),
          Effect.catchTag("SocketError", (error) =>
            Effect.fail(
              new DaemonUnreachable({ message: "daemon request failed", detail: error.message }),
            ),
          ),
        );

      const compatibilityError = (message: string) =>
        new DaemonUnreachable({
          message: `daemon compatibility check failed: ${message}`,
          detail: "No review command was sent; saved review files were not changed.",
        });
      const negotiate = Effect.gen(function* () {
        const line = yield* connect(encodeMessage({ command: "daemon.info" }));
        const reply = yield* decodeReply(line).pipe(
          Effect.mapError(() =>
            compatibilityError("Invalid compatibility reply; no review command was sent."),
          ),
        );
        if (!reply.ok)
          return yield* Effect.fail(
            compatibilityError(
              "This daemon does not support automatic recovery. Stop the old TUI and inspect saved-session compatibility before manually restarting it.",
            ),
          );
        const info = yield* Schema.decodeUnknownEffect(DaemonInfoSchema, {
          onExcessProperty: "error",
        })(reply.value).pipe(
          Effect.mapError(() =>
            compatibilityError(
              "This daemon has no valid compatibility handshake. No review command was sent; a legacy daemon needs manual recovery.",
            ),
          ),
        );
        if (info.version === daemonVersion) return info;
        if (compare(info.version, daemonVersion) >= 0)
          return yield* Effect.fail(
            compatibilityError(
              `The running daemon (${info.version}) is newer than this CLI (${daemonVersion}). Update this CLI; automatic downgrade is refused.`,
            ),
          );
        const saved = yield* inspectSavedSessions.pipe(
          Effect.provideService(Paths, paths),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError(() =>
            compatibilityError("Could not inspect saved reviews; automatic restart was refused."),
          ),
        );
        if (saved.incompatible.length > 0)
          return yield* Effect.fail(
            compatibilityError(
              `${saved.incompatible.length} saved review file(s) are incompatible with ${daemonVersion}. Keep using the old version or explicitly recreate those reviews; no files were changed.`,
            ),
          );
        const restart = yield* connect(
          encodeMessage({
            command: "daemon.restart",
            version: daemonVersion,
            instanceId: info.instanceId,
            fingerprint: saved.fingerprint,
          }),
        ).pipe(Effect.flatMap(decodeReply));
        if (!restart.ok) return yield* restart.error;
        yield* Schema.decodeUnknownEffect(RestartReplySchema, { onExcessProperty: "error" })(
          restart.value,
        );
        // Busy, changed state, or an accepted shutdown: negotiate again before any mutation.
        return yield* Effect.fail("restart_pending" as const);
      }).pipe(
        Effect.retry({ while: (error) => error === "restart_pending", schedule: startupPolls }),
        Effect.catchIf(
          (error) => error === "restart_pending",
          () =>
            Effect.fail(
              new DaemonUnreachable({
                message: "daemon upgrade is busy; retry after active review commands finish",
              }),
            ),
        ),
        Effect.catchTag("SchemaError", (error) => Effect.fail(compatibilityError(error.message))),
      );

      const request = Effect.fn("DaemonClient.request")(function* (
        input: Request,
        onProgress?: (progress: CaptureProgress) => Effect.Effect<void>,
      ) {
        const info = yield* negotiate;
        // Never retry a review command after sending it: a lost reply may hide a committed mutation.
        const replyLine = yield* exchange(
          encodeMessage({
            version: daemonVersion,
            instanceId: info.instanceId,
            request: input,
          }),
          (value) =>
            Option.match(onProgress ? decodeProgress(value) : Option.none(), {
              onNone: () => Effect.void,
              onSome: ({ progress }) => onProgress!(progress),
            }),
        ).pipe(
          Effect.catchTag("SocketError", (error) =>
            Effect.fail(
              new DaemonUnreachable({
                message:
                  "daemon connection failed after sending the command; inspect status before retrying a mutation",
                detail: error.message,
              }),
            ),
          ),
        );
        const reply = yield* decodeReply(replyLine).pipe(
          Effect.mapError(
            (error) =>
              new DaemonUnreachable({ message: "invalid daemon reply", detail: error.message }),
          ),
        );
        if (!reply.ok) return yield* reply.error;
        const payload = {
          open: OpenPayloadSchema,
          list: ListPayloadSchema,
          status: StatusPayloadSchema,
          check: SourceCheckPayloadSchema,
          stack: StackPayloadSchema,
          diff: DiffPayloadSchema,
          files: FilesPayloadSchema,
          code: CodePayloadSchema,
          preview: ExportPreviewPayloadSchema,
          export: ExportPayloadSchema,
          apply: StatusPayloadSchema,
          refresh: RefreshPayloadSchema,
          delete: DeletePayloadSchema,
          threads: ThreadsPayloadSchema,
        }[input.command];
        return yield* Schema.decodeUnknownEffect(payload, { onExcessProperty: "error" })(
          reply.value,
        ).pipe(
          Effect.mapError(
            (error) =>
              new DaemonUnreachable({
                message: "invalid daemon reply",
                detail: error.message,
              }),
          ),
        );
      });

      return DaemonClient.of({ request });
    }),
  );
}
