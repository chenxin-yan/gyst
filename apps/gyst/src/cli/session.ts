import {
  ClosePayloadSchema,
  DiffPayloadSchema,
  ErrorPayloadSchema,
  ReplySchema,
  StatusPayloadSchema,
  type ErrorPayload,
  type Reply,
  type Request,
} from "@gyst/core";
import { Schema } from "effect";
import { socketPath } from "../daemon/server.ts";

function exchange(request: Request): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const decoder = new TextDecoder();
    void Bun.connect<{ request: Request }>({
      unix: socketPath(),
      data: { request },
      socket: {
        open(socket) { socket.write(`${JSON.stringify(socket.data.request)}\n`); },
        data(_socket, bytes) {
          buffer += decoder.decode(bytes, { stream: true });
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            try { resolve(Schema.decodeUnknownSync(ReplySchema)(JSON.parse(buffer.slice(0, newline)))); }
            catch (error) { reject(error); }
          }
        },
        error(_socket, error) { reject(error); },
        close() { if (!buffer) reject(new Error("daemon closed without a response")); },
      },
    }).catch(reject);
  });
}

async function requestDaemon(request: Request): Promise<Reply> {
  try { return await exchange(request); } catch {}
  try {
    Bun.spawn([process.execPath, "daemon", "run"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
      env: process.env,
    }).unref();
  } catch (error) {
    throw { code: "daemon_unreachable", message: "could not start daemon", detail: String(error) } satisfies ErrorPayload;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(20);
    try { return await exchange(request); } catch {}
  }
  throw { code: "daemon_unreachable", message: "daemon did not become reachable" } satisfies ErrorPayload;
}

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
