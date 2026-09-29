import {
  BadArgs,
  BlobIdSchema,
  type ByteRange,
  ByteRangeSchema,
  canonicalManifestJson,
  InternalError,
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

      // The scope removes this write's temporary directory on success, failure or interruption.
      const stage = fs
        .makeTempFileScoped({ directory: staging })
        .pipe(Effect.tap((file) => fs.chmod(file, 0o600)));

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
            Stream.run(fs.sink(staged)),
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
        yield* fs.writeFile(staged, content);
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

      return CapturedContent.of({ putBlob, readBlob, putManifest, loadManifest });
    }),
  );
}
