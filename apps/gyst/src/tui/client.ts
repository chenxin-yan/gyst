import {
  DiffPayloadSchema,
  ErrorPayloadSchema,
  StatusPayloadSchema,
  type DiffPayload,
  type ErrorPayload,
  type HumanAction,
  type Request,
  type StatusPayload,
} from "@gyst/core";
import { Schema } from "effect";
import { requestDaemon } from "../daemon/client.ts";

export interface TuiClient {
  status(): Promise<StatusPayload>;
  diff(): Promise<DiffPayload>;
  action(action: HumanAction): Promise<StatusPayload>;
  refresh(): Promise<StatusPayload>;
}

export class TuiClientError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.message);
  }
}

export function daemonTuiClient(cwd = process.cwd()): TuiClient {
  function parseErrorPayload(error: unknown): ErrorPayload {
    try {
      return Schema.decodeUnknownSync(ErrorPayloadSchema)(error);
    } catch {
      return {
        code: "daemon_unreachable",
        message: error instanceof Error ? error.message : "invalid daemon response",
      };
    }
  }

  async function send<Payload>(
    request: Request,
    payloadSchema: Schema.Schema<Payload>,
  ): Promise<Payload> {
    let reply;
    try {
      reply = await requestDaemon(request);
    } catch (error) {
      throw new TuiClientError(parseErrorPayload(error));
    }
    if (!reply.ok)
      throw new TuiClientError(Schema.decodeUnknownSync(ErrorPayloadSchema)(reply.error));
    return Schema.decodeUnknownSync(payloadSchema)(reply.value);
  }
  return {
    status: () => send({ command: "status", cwd, args: [] }, StatusPayloadSchema),
    diff: () => send({ command: "diff", cwd, args: [] }, DiffPayloadSchema),
    action: (action) => send({ command: "tui.action", cwd, args: [], action }, StatusPayloadSchema),
    refresh: () => send({ command: "refresh", cwd, args: [] }, StatusPayloadSchema),
  };
}
