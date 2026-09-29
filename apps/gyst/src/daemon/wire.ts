import type { NonEmptyReadonlyArray } from "effect/Array";
import { Effect, Predicate } from "effect";
import * as Socket from "effect/socket/Socket";

/** ENOENT: no socket file; ECONNREFUSED: a file nobody listens on. Anything else is not "nobody there". */
export const daemonAbsent = (error: { readonly _tag: string }) =>
  Socket.isSocketError(error) &&
  error.reason._tag === "SocketOpenError" &&
  Predicate.hasProperty(error.reason.cause, "code") &&
  (error.reason.cause.code === "ENOENT" || error.reason.cause.code === "ECONNREFUSED");

/**
 * Successive newline-terminated frames of one connection; bytes decode in stream mode so a split
 * UTF-8 sequence survives, and bytes after one frame are kept for the next.
 */
export const lineReader = (
  pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
) => {
  const decoder = new TextDecoder();
  let pending = "";
  return Effect.gen(function* () {
    let searched = 0;
    while (true) {
      const newline = pending.indexOf("\n", searched);
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }
      searched = pending.length;
      for (const chunk of yield* pull) pending += decoder.decode(chunk, { stream: true });
    }
  }).pipe(Effect.withSpan("wire.lineReader"));
};

/** The first frame of a connection that carries one request. */
export const readLine = (
  pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
) => lineReader(pull);

export const writeLine = Effect.fn("wire.writeLine")(function* (
  socket: Socket.Socket,
  line: string,
) {
  const writer = yield* socket.writer;
  yield* writer.write(`${line}\n`);
});
