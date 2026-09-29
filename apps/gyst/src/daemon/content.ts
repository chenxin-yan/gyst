import {
  BadArgs,
  BlobIdSchema,
  type ByteRange,
  ByteRangeSchema,
  canonicalManifestJson,
  InternalError,
  pageBytes,
  type SnapshotManifest,
  SnapshotIdSchema,
  SnapshotManifestSchema,
  snapshotIdOf,
} from "@gyst/core";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  type PlatformError,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { createHash } from "node:crypto";
import { Paths } from "./paths.ts";

type Failure = BadArgs | InternalError | PlatformError.PlatformError;

const invalid =
  <S extends Schema.Top>(schema: S, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new BadArgs({ message, detail: error.message })),
    );
const decodeBlobId = invalid(BlobIdSchema, "invalid captured content id");
const decodeSnapshotId = invalid(SnapshotIdSchema, "invalid snapshot id");
const decodeRange = invalid(ByteRangeSchema, "invalid byte range");
const decodeManifest = invalid(SnapshotManifestSchema, "invalid snapshot manifest");
const decodeStoredManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SnapshotManifestSchema),
  {
    onExcessProperty: "error",
  },
);

const lf = 10;
const insideCharacter = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * One `code` page of a text blob of `size` bytes (see `CodePayloadSchema`), scanned from the start
 * so its line numbers are counted, never trusted. Holds at most one page plus one chunk and stops
 * reading once the page and the requested bounds are settled. Out-of-bounds lines, an offset past
 * the end or inside a UTF-8 character fail as `BadArgs`.
 * ponytail: rescans from byte 0 for every page; keep a per-blob line index if huge files page slowly.
 */
export const codePage = Effect.fnUntraced(function* <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  size: number,
  request: {
    readonly startLine?: number | undefined;
    readonly offset?: number | undefined;
    readonly endLine?: number | undefined;
  },
) {
  const { startLine = 1, endLine } = request;
  if (request.offset !== undefined && request.offset > size)
    return yield* new BadArgs({
      message: "offset is past the end of the captured content",
      detail: { offset: request.offset, size },
    });
  // Absolute byte offsets. `lfs` counts every LF before `position`.
  let start = request.offset ?? (startLine === 1 ? 0 : undefined);
  let linesBefore = start === 0 ? 0 : undefined;
  let endLineStart = endLine === 1 ? 0 : undefined;
  let endLineEnd: number | undefined;
  let lastLineEnd: number | undefined;
  let position = 0;
  let lfs = 0;
  let lastByte: number | undefined;
  const kept: Uint8Array[] = [];
  let keptEnd = start ?? 0;

  const push = (chunk: Uint8Array) => {
    const base = position;
    for (let index = chunk.indexOf(lf); index !== -1; index = chunk.indexOf(lf, index + 1)) {
      const at = base + index;
      if (start !== undefined && linesBefore === undefined && at >= start) linesBefore = lfs;
      lfs++;
      if (start === undefined && lfs === startLine - 1) {
        start = keptEnd = at + 1;
        linesBefore = lfs;
      }
      if (lfs === (endLine ?? 0) - 1) endLineStart = at + 1;
      if (lfs === endLine) endLineEnd = at + 1;
      if (start !== undefined && at >= start && at < start + pageBytes) lastLineEnd = at + 1;
    }
    position = base + chunk.byteLength;
    lastByte = chunk.at(-1) ?? lastByte;
    if (start !== undefined && linesBefore === undefined && position >= start) linesBefore = lfs;
    if (start !== undefined) {
      // One byte past the page shows whether a split there would cut a character.
      const from = Math.max(start, base);
      const to = Math.min(position, start + pageBytes + 1);
      if (to > from) {
        kept.push(chunk.slice(from - base, to - base));
        keptEnd = to;
      }
    }
    const pageSettled =
      start !== undefined &&
      linesBefore !== undefined &&
      (keptEnd >= start + pageBytes + 1 || (endLineEnd !== undefined && keptEnd >= endLineEnd));
    return !(pageSettled && (endLine === undefined || endLineStart !== undefined));
  };
  yield* Stream.runForEachWhile(bytes, (chunk) => Effect.sync(() => push(chunk)));

  // Reaching here without a start means the whole content was scanned.
  if (start === undefined || (request.offset === undefined && start >= size))
    return yield* new BadArgs({
      message: "startLine is past the last line of the captured content",
      detail: { startLine, lines: lfs + (lastByte === undefined || lastByte === lf ? 0 : 1) },
    });
  const page = new Uint8Array(keptEnd - start);
  let filled = 0;
  for (const chunk of kept) {
    page.set(chunk, filled);
    filled += chunk.byteLength;
  }
  if (insideCharacter(page[0]))
    return yield* new BadArgs({
      message: "offset is inside a UTF-8 character",
      detail: { offset: start },
    });
  const line = linesBefore! + 1;
  if (endLine !== undefined && endLine < line)
    return yield* new BadArgs({
      message: "endLine is before the page start",
      detail: { endLine, line },
    });
  if (endLine !== undefined && (endLineStart === undefined || endLineStart >= size))
    return yield* new BadArgs({
      message: "endLine is past the last line of the captured content",
      detail: { endLine },
    });

  const rangeEnd = endLineEnd ?? size;
  let end = rangeEnd;
  if (rangeEnd - start > pageBytes) {
    end = lastLineEnd ?? start + pageBytes;
    while (insideCharacter(page[end - start])) end--;
  }
  const body = page.subarray(0, end - start);
  const text = yield* Effect.try({
    // `ignoreBOM` keeps a leading U+FEFF: it is captured content, not decoding metadata.
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
    catch: () => new InternalError({ message: "captured content is not valid UTF-8 text" }),
  });
  let pageLfs = 0;
  for (let index = body.indexOf(lf); index !== -1; index = body.indexOf(lf, index + 1)) pageLfs++;
  return {
    start: { line, offset: start },
    text,
    next: end < rangeEnd ? { line: line + pageLfs, offset: end } : null,
  };
});

const missingAs =
  (message: string, detail: string) =>
  <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
    Effect.mapError(effect, (error) =>
      error.reason._tag === "NotFound" ? new BadArgs({ message, detail }) : error,
    );

/**
 * Immutable captured content, separate from mutable `SessionStore` state. Under `dataDir/content/`:
 * `blobs/<sha256>` holds exact file bytes, `snapshots/<snapshotId>.json` canonical manifests and
 * `staging/` each write's own temporary directory. Nothing here deletes committed objects.
 */
export class CapturedContent extends Context.Service<
  CapturedContent,
  {
    /** Streams bytes to staging with backpressure, then commits them under their SHA-256. */
    putBlob<E>(
      bytes: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<{ readonly blob: string; readonly size: number }, E | Failure>;
    /** At most `range.length` bytes of a committed blob; see `ByteRangeSchema` for end semantics. */
    readBlob(blob: string, range: ByteRange): Stream.Stream<Uint8Array, Failure>;
    /**
     * A private 0600 copy of a committed blob, for a tool that reads files (the diff engine).
     * It lives in this service's staging and is removed when the caller's scope closes.
     */
    materialize(blob: string): Effect.Effect<string, Failure, Scope.Scope>;
    /** Commits a manifest whose every text side names a committed blob of the stated size. */
    putManifest(manifest: SnapshotManifest): Effect.Effect<string, Failure>;
    loadManifest(snapshotId: string): Effect.Effect<SnapshotManifest, Failure>;
  }
>()("gyst/daemon/CapturedContent") {
  static readonly layer = Layer.effect(
    CapturedContent,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join((yield* Paths).dataDir, "content");
      // ponytail: flat directories; fan out by digest prefix if listing them ever matters.
      const blobs = path.join(root, "blobs");
      const snapshots = path.join(root, "snapshots");
      const staging = path.join(root, "staging");
      for (const directory of [blobs, snapshots, staging])
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const blobFile = (blob: string) => path.join(blobs, blob);
      const manifestFile = (id: string) => path.join(snapshots, `${id}.json`);

      // A hard link publishes the complete staged file atomically and never replaces an existing
      // object, so committed content and its open readers are untouched. An existing object of the
      // same name has the same digest; its size is still checked to surface a damaged store.
      const commit = Effect.fnUntraced(function* (staged: string, target: string, size: number) {
        const linked = yield* fs.link(staged, target).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (!linked && Number((yield* fs.stat(target)).size) !== size)
          return yield* new InternalError({
            message: "captured content is corrupt",
            detail: path.basename(target),
          });
      });

      // Each write owns a scoped 0700 directory whose removal is registered before the private
      // file inside it is created, so success, failure (including failing to create that file) or
      // interruption leaves no staging. Not `makeTempFileScoped`: in Effect 4.0.0-rc.117 it creates
      // the directory, then the file, and registers cleanup only after both succeed, so a failed
      // file creation (EMFILE, ENOSPC, inode exhaustion) leaks the directory.
      const stage = fs
        .makeTempDirectoryScoped({ directory: staging })
        .pipe(Effect.map((directory) => path.join(directory, "object")));
      const privateFile = { flag: "wx", mode: 0o600 } as const;

      const putBlob = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
        Effect.gen(function* () {
          const staged = yield* stage;
          const hash = createHash("sha256");
          let size = 0;
          yield* bytes.pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => {
                hash.update(chunk);
                size += chunk.byteLength;
              }),
            ),
            Stream.run(fs.sink(staged, privateFile)),
          );
          const blob = hash.digest("hex");
          yield* commit(staged, blobFile(blob), size);
          return { blob, size };
        }).pipe(Effect.scoped, Effect.withSpan("CapturedContent.putBlob"));

      const readBlob = (blob: string, range: ByteRange) =>
        Effect.gen(function* () {
          const id = yield* decodeBlobId(blob);
          const { offset, length } = yield* decodeRange(range);
          const info = yield* fs
            .stat(blobFile(id))
            .pipe(missingAs("captured content not found", id));
          const size = Number(info.size);
          if (offset > size)
            return yield* new BadArgs({
              message: "byte range starts past the end of captured content",
              detail: { offset, size },
            });
          return fs.stream(blobFile(id), { offset, bytesToRead: Math.min(length, size - offset) });
        }).pipe(Stream.unwrap);

      const materialize = (blob: string) =>
        Effect.gen(function* () {
          const id = yield* decodeBlobId(blob);
          const copy = yield* stage;
          yield* missingAs(
            "captured content not found",
            id,
          )(fs.stream(blobFile(id)).pipe(Stream.run(fs.sink(copy, privateFile))));
          return copy;
        }).pipe(Effect.withSpan("CapturedContent.materialize"));

      const putManifest = Effect.fn("CapturedContent.putManifest")(function* (
        manifest: SnapshotManifest,
      ) {
        const valid = yield* decodeManifest(manifest);
        const sizes = new Map<string, number>();
        for (const side of valid.files.flatMap((file) => [file.old, file.new])) {
          if (side.kind !== "text") continue;
          let size = sizes.get(side.blob);
          if (size === undefined) {
            const info = yield* fs
              .stat(blobFile(side.blob))
              .pipe(missingAs("snapshot manifest references missing captured content", side.blob));
            size = Number(info.size);
            sizes.set(side.blob, size);
          }
          if (size !== side.size)
            return yield* new BadArgs({
              message: "snapshot manifest references inconsistent captured content",
              detail: { blob: side.blob, size: side.size, stored: size },
            });
        }
        const content = new TextEncoder().encode(canonicalManifestJson(valid));
        const id = snapshotIdOf(valid);
        const staged = yield* stage;
        yield* fs.writeFile(staged, content, privateFile);
        yield* commit(staged, manifestFile(id), content.byteLength);
        return id;
      }, Effect.scoped);

      const loadManifest = Effect.fn("CapturedContent.loadManifest")(function* (
        snapshotId: string,
      ) {
        const id = yield* decodeSnapshotId(snapshotId);
        const content = yield* fs
          .readFile(manifestFile(id))
          .pipe(missingAs("snapshot not found", id));
        const corrupt = new InternalError({
          message: "captured snapshot manifest is corrupt",
          detail: id,
        });
        if (createHash("sha256").update(content).digest("hex") !== id) return yield* corrupt;
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(content),
          catch: () => corrupt,
        });
        return yield* decodeStoredManifest(text).pipe(Effect.mapError(() => corrupt));
      });

      return CapturedContent.of({ putBlob, readBlob, materialize, putManifest, loadManifest });
    }),
  );
}
