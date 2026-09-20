import type { NonEmptyReadonlyArray } from "effect/Array";
import { Effect, Predicate } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

/** ENOENT: no socket file; ECONNREFUSED: a file nobody listens on. Anything else is not "nobody there". */
export const daemonAbsent = (error: { readonly _tag: string }) =>
  Socket.isSocketError(error) &&
  error.reason._tag === "SocketOpenError" &&
  Predicate.hasProperty(error.reason.cause, "code") &&
  (error.reason.cause.code === "ENOENT" || error.reason.cause.code === "ECONNREFUSED");

/** One newline-terminated frame per connection; bytes decode in stream mode so a split UTF-8 sequence survives. */
export const readLine = Effect.fn("wire.readLine")(function* (
  pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
) {
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    for (const chunk of yield* pull) {
      pending += decoder.decode(chunk, { stream: true });
      const newline = pending.indexOf("\n");
      if (newline >= 0) return pending.slice(0, newline);
    }
  }
});

export const writeLine = Effect.fn("wire.writeLine")(function* (
  socket: Socket.Socket,
  line: string,
) {
  const writer = yield* socket.writer;
  yield* writer.write(`${line}\n`);
});
