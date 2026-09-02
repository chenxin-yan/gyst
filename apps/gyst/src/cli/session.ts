import {
  ClosePayloadSchema,
  DiffPayloadSchema,
  ErrorPayloadSchema,
  RequestSchema,
  StatusPayloadSchema,
  type ErrorPayload,
  type Request,
} from "@gyst/core";
import { Schema } from "effect";
import { requestDaemon } from "../daemon/client.ts";

const isSessionCommand = Schema.is(RequestSchema.fields.command);

export async function runSessionCli(argv: string[], readStdin = false): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || !isSessionCommand(command)) {
    throw {
      code: "bad_args",
      message: `unknown session command: ${command ?? ""}`,
    } satisfies ErrorPayload;
  }
  const request: Request = {
    command,
    cwd: process.cwd(),
    args,
    ...(readStdin ? { stdin: await Bun.stdin.text() } : {}),
  };
  const reply = await requestDaemon(request);
  if (!reply.ok) throw Schema.decodeUnknownSync(ErrorPayloadSchema)(reply.error);
  const value =
    request.command === "diff"
      ? Schema.decodeUnknownSync(DiffPayloadSchema)(reply.value)
      : request.command === "close"
        ? Schema.decodeUnknownSync(ClosePayloadSchema)(reply.value)
        : Schema.decodeUnknownSync(StatusPayloadSchema)(reply.value);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
