import {
  DaemonError,
  type DiffPayload,
  DiffPayloadSchema,
  type ErrorPayload,
  ErrorPayloadSchema,
  type HumanAction,
  type Request,
  type SourceCheckPayload,
  SourceCheckPayloadSchema,
  type StatusPayload,
  StatusPayloadSchema,
} from "@gyst/core";
import { Effect, type ManagedRuntime, Schema } from "effect";
import { DaemonClient } from "../daemon/client.ts";

export interface TuiClient {
  status(): Promise<StatusPayload>;
  check(): Promise<SourceCheckPayload>;
  diff(): Promise<DiffPayload>;
  action(action: HumanAction): Promise<StatusPayload>;
  refresh(): Promise<StatusPayload>;
}

/** Carries the wire shape: the App tells "no session yet" from real failures by `payload.code`. */
export class TuiClientError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.message);
  }
}

const encodeError = Schema.encodeSync(ErrorPayloadSchema);

export function daemonTuiClient(
  runtime: ManagedRuntime.ManagedRuntime<DaemonClient, unknown>,
  cwd = process.cwd(),
): TuiClient {
  const send = <Payload>(request: Request, payload: Schema.Codec<Payload, unknown>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* DaemonClient;
        return yield* Schema.decodeUnknownEffect(payload)(yield* client.request(request));
      }).pipe(
        Effect.mapError(
          (error) =>
            new TuiClientError(
              Schema.is(DaemonError)(error)
                ? encodeError(error)
                : { code: "daemon_unreachable", message: error.message },
            ),
        ),
      ),
    );
  return {
    check: () => send({ command: "check", cwd, args: [] }, SourceCheckPayloadSchema),
    status: () => send({ command: "status", cwd, args: [] }, StatusPayloadSchema),
    diff: () => send({ command: "diff", cwd, args: [] }, DiffPayloadSchema),
    action: (action) => send({ command: "tui.action", cwd, args: [], action }, StatusPayloadSchema),
    refresh: () => send({ command: "refresh", cwd, args: [] }, StatusPayloadSchema),
  };
}
