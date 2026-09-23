import { BunSocket } from "@effect/platform-bun";
import {
  type DaemonError,
  DaemonUnreachable,
  ClosePayloadSchema,
  DiffPayloadSchema,
  StatusPayloadSchema,
  ReplySchema,
  type Request,
  RequestSchema,
} from "@gyst/core";
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Socket from "effect/unstable/socket/Socket";
import { Paths } from "./paths.ts";
import { daemonAbsent, readLine, writeLine } from "./wire.ts";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RequestSchema));
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(ReplySchema));

// Five seconds: a cold source-mode start on a loaded machine takes well over one.
const startupPolls = Schedule.max([Schedule.spaced("20 millis"), Schedule.recurs(250)]);

export class DaemonClient extends Context.Service<
  DaemonClient,
  {
    request(request: Request): Effect.Effect<unknown, DaemonError>;
  }
>()("gyst/daemon/DaemonClient") {
  static readonly layer = Layer.effect(
    DaemonClient,
    Effect.gen(function* () {
      const paths = yield* Paths;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // The reader dials, so it is acquired before anything is written.
      const exchange = Effect.fn("DaemonClient.exchange")(function* (line: string) {
        const socket = yield* BunSocket.makeNet({ path: paths.socketPath });
        const pull = yield* Socket.readerBytes(socket);
        yield* writeLine(socket, line);
        return yield* readLine(pull);
      }, Effect.scoped);

      const spawnDaemon = Effect.gen(function* () {
        // Compiled binaries embed the entrypoint; under `bun src/index.tsx` it must be passed.
        const entry = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
        const handle = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [...entry, "daemon", "run"], {
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* handle.unref;
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (error) =>
            new DaemonUnreachable({ message: "could not start daemon", detail: error.message }),
        ),
      );

      const request = Effect.fn("DaemonClient.request")(function* (input: Request) {
        const line = encodeRequest(input);
        const replyLine = yield* exchange(line).pipe(
          Effect.catchIf(daemonAbsent, () =>
            spawnDaemon.pipe(
              Effect.andThen(
                exchange(line).pipe(Effect.retry({ while: daemonAbsent, schedule: startupPolls })),
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
        const reply = yield* decodeReply(replyLine).pipe(
          Effect.mapError(
            (error) =>
              new DaemonUnreachable({ message: "invalid daemon reply", detail: error.message }),
          ),
        );
        if (!reply.ok) return yield* reply.error;
        const payload =
          input.command === "diff"
            ? DiffPayloadSchema
            : input.command === "close"
              ? ClosePayloadSchema
              : StatusPayloadSchema;
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
