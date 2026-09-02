import {
  ClosePayloadSchema,
  DiffPayloadSchema,
  ErrorPayloadSchema,
  StatusPayloadSchema,
  type ErrorPayload,
  type Request,
} from "@gyst/core";
import { Schema } from "effect";
import { requestDaemon } from "../daemon/client.ts";

export async function runSessionCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || !["create", "status", "diff", "apply", "refresh", "close"].includes(command)) {
    throw { code: "bad_args", message: `unknown session command: ${command ?? ""}` } satisfies ErrorPayload;
  }
  const request: Request = {
    command: command as Request["command"],
    cwd: process.cwd(),
    args,
    ...((command === "apply" || ((command === "create" || command === "refresh") && args.includes("--stdin")))
      ? { stdin: await Bun.stdin.text() }
      : {}),
  };
  const reply = await requestDaemon(request);
  if (!reply.ok) throw Schema.decodeUnknownSync(ErrorPayloadSchema)(reply.error);
  const value = request.command === "diff"
    ? Schema.decodeUnknownSync(DiffPayloadSchema)(reply.value)
    : request.command === "close"
      ? Schema.decodeUnknownSync(ClosePayloadSchema)(reply.value)
      : Schema.decodeUnknownSync(StatusPayloadSchema)(reply.value);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
