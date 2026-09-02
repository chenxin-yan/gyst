import {
  ReplySchema,
  type ErrorPayload,
  type Reply,
  type Request,
} from "@gyst/core";
import { Schema } from "effect";
import { socketPath } from "./server.ts";

class ExchangeError extends Error {
  constructor(cause: unknown, readonly requestSent: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function exchange(request: Request): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let requestSent = false;
    const decoder = new TextDecoder();
    const fail = (error: unknown) => reject(new ExchangeError(error, requestSent));
    void Bun.connect<{ request: Request }>({
      unix: socketPath(),
      data: { request },
      socket: {
        open(socket) {
          requestSent = true;
          socket.write(`${JSON.stringify(socket.data.request)}\n`);
        },
        data(_socket, bytes) {
          buffer += decoder.decode(bytes, { stream: true });
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          try { resolve(Schema.decodeUnknownSync(ReplySchema)(JSON.parse(buffer.slice(0, newline)))); }
          catch (error) { fail(error); }
        },
        error(_socket, error) { fail(error); },
        close() { if (!buffer.includes("\n")) fail(new Error("daemon closed without a complete response")); },
      },
    }).catch(fail);
  });
}

function unreachable(message: string, detail?: unknown): ErrorPayload {
  return { code: "daemon_unreachable", message, ...(detail === undefined ? {} : { detail: String(detail) }) };
}

export async function requestDaemon(request: Request): Promise<Reply> {
  try { return await exchange(request); }
  catch (error) {
    if (!(error instanceof ExchangeError) || error.requestSent) throw unreachable("daemon response was lost; request was not retried", error);
  }
  try {
    Bun.spawn([process.execPath, "daemon", "run"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
      env: process.env,
    }).unref();
  } catch (error) {
    throw unreachable("could not start daemon", error);
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(20);
    try { return await exchange(request); }
    catch (error) {
      if (!(error instanceof ExchangeError) || error.requestSent) throw unreachable("daemon response was lost; request was not retried", error);
    }
  }
  throw unreachable("daemon did not become reachable");
}
