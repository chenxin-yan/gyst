import { BadArgs } from "@gyst/core";
import { Effect, Option, Stream } from "effect";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";

/**
 * Working-tree reads for a trusted local checkout, over `node:fs` because Effect's `FileSystem`
 * has no `lstat` or no-follow open. Every component is `lstat`ed and the leaf is opened with
 * `O_NOFOLLOW`, so an existing link is never followed. This rejects static link escapes and
 * detects ordinary concurrent edits; it is not containment against a malicious process swapping
 * parent directories between the checks and the open (that would need `openat`-style walks).
 */

/** A path as `lstat` saw it; `fingerprint` changes whenever the entry is replaced or written. */
export type WorktreeEntry =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink" | "directory"; readonly fingerprint: string }
  | {
      readonly kind: "file";
      readonly executable: boolean;
      readonly size: number;
      readonly fingerprint: string;
    };

const fingerprintOf = (stats: BigIntStats) =>
  `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

const failure = (message: string, path: string, error?: unknown) =>
  new BadArgs({
    message,
    detail: {
      path,
      ...(error instanceof Error && "code" in error ? { code: String(error.code) } : {}),
    },
  });

export const changedDuringCapture = (path: string) =>
  new BadArgs({
    message:
      "the working tree changed while it was being captured, so nothing was published; retry once edits settle",
    detail: { path },
  });

const absent = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const lstatOf = (full: string, path: string) =>
  Effect.tryPromise({
    try: () => lstat(full, { bigint: true }).then((stats): BigIntStats | undefined => stats),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      absent(error)
        ? Effect.succeed(undefined)
        : Effect.fail(failure("could not inspect a working-tree path", path, error)),
    ),
  );

/** Inspects root-relative `path` (already a validated logical path) without following links. */
export const inspect = Effect.fn("worktree.inspect")(function* (root: string, path: string) {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const parent = segments.slice(0, depth).join("/");
    const stats = yield* lstatOf(join(root, parent), path);
    if (stats === undefined || stats.isFile()) return { kind: "missing" } as const;
    if (stats.isSymbolicLink())
      return yield* failure(
        "a captured path crosses a symbolic link; captures never follow links",
        path,
      );
    if (!stats.isDirectory())
      return yield* failure("a captured path crosses an unsupported file type", path);
  }
  const stats = yield* lstatOf(join(root, path), path);
  if (stats === undefined) return { kind: "missing" } as const;
  const fingerprint = fingerprintOf(stats);
  if (stats.isSymbolicLink()) return { kind: "symlink", fingerprint } as const;
  if (stats.isDirectory()) return { kind: "directory", fingerprint } as const;
  if (!stats.isFile())
    return yield* failure("captures read regular files only, not devices, FIFOs or sockets", path);
  return {
    kind: "file",
    executable: (stats.mode & 0o111n) !== 0n,
    size: Number(stats.size),
    fingerprint,
  } as const;
});

const chunkSize = 64 * 1024;

/**
 * The exact bytes of a regular file `inspect` saw, streamed in chunks. The stream fails with
 * `changedDuringCapture` if the opened file is not that entry, or it changed while being read.
 */
export const read = (
  root: string,
  path: string,
  entry: Extract<WorktreeEntry, { kind: "file" }>,
): Stream.Stream<Uint8Array, BadArgs> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
      if (O_NOFOLLOW === undefined || O_NONBLOCK === undefined)
        return yield* failure("this platform cannot open files without following links", path);
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          // Non-blocking, so a FIFO swapped in after `inspect` cannot hang the capture.
          try: () => open(join(root, path), O_RDONLY | O_NOFOLLOW | O_NONBLOCK),
          catch: (error) =>
            error instanceof Error && "code" in error && error.code === "ELOOP"
              ? changedDuringCapture(path)
              : failure("could not open a working-tree file", path, error),
        }),
        (opened: FileHandle) => Effect.promise(() => opened.close()),
      );
      const current = Effect.tryPromise({
        try: () => handle.stat({ bigint: true }),
        catch: (error) => failure("could not inspect a working-tree file", path, error),
      });
      const unchanged = Effect.gen(function* () {
        const stats = yield* current;
        if (!stats.isFile() || fingerprintOf(stats) !== entry.fingerprint)
          return yield* changedDuringCapture(path);
      });
      yield* unchanged;
      let bytesRead = 0;
      const chunks = Stream.paginate(0, (position: number) =>
        Effect.tryPromise({
          try: () => handle.read(new Uint8Array(chunkSize), 0, chunkSize, position),
          catch: (error) => failure("could not read a working-tree file", path, error),
        }).pipe(
          Effect.map(({ buffer, bytesRead: count }) => {
            bytesRead += count;
            return count === 0
              ? ([[], Option.none()] as const)
              : ([[buffer.subarray(0, count)], Option.some(position + count)] as const);
          }),
        ),
      );
      const complete = Effect.gen(function* () {
        yield* unchanged;
        if (bytesRead !== entry.size) return yield* changedDuringCapture(path);
      });
      return Stream.concat(chunks, Stream.fromEffectDrain(complete));
    }),
  );
