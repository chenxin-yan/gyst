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
  function errorPayload(error: unknown): ErrorPayload {
    try {
      return Schema.decodeUnknownSync(ErrorPayloadSchema)(error);
    } catch {
      return {
        code: "daemon_unreachable",
        message: error instanceof Error ? error.message : "invalid daemon response",
      };
    }
  }

  async function send(request: Request): Promise<unknown> {
    let reply;
    try {
      reply = await requestDaemon(request);
    } catch (error) {
      throw new TuiClientError(errorPayload(error));
    }
    if (!reply.ok)
      throw new TuiClientError(Schema.decodeUnknownSync(ErrorPayloadSchema)(reply.error));
    return reply.value;
  }
  return {
    status: async () =>
      Schema.decodeUnknownSync(StatusPayloadSchema)(
        await send({ command: "status", cwd, args: [] }),
      ),
    diff: async () =>
      Schema.decodeUnknownSync(DiffPayloadSchema)(await send({ command: "diff", cwd, args: [] })),
    action: async (action) =>
      Schema.decodeUnknownSync(StatusPayloadSchema)(
        await send({ command: "tui.action", cwd, args: [], action }),
      ),
    refresh: async () =>
      Schema.decodeUnknownSync(StatusPayloadSchema)(
        await send({ command: "refresh", cwd, args: [] }),
      ),
  };
}
