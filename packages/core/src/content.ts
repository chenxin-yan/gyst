import { Schema } from "effect";
import { LogicalPathSchema } from "./guidance.ts";
import { HunkSchema, ScopeSchema } from "./session.ts";

export { LogicalPathSchema };

const sha256Pattern = /^[0-9a-f]{64}$/;

/** SHA-256 (lowercase hex) of a captured file's full raw bytes; never a Git object ID. */
export const BlobIdSchema = Schema.String.check(Schema.isPattern(sha256Pattern));
/** SHA-256 (lowercase hex) of a manifest's canonical JSON; see `snapshotIdOf`. */
export const SnapshotIdSchema = Schema.String.check(Schema.isPattern(sha256Pattern));
/** A resolved Git commit: SHA-1 or SHA-256 object format, lowercase hex. */
export const GitObjectIdSchema = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);

/** One side of a file. `text` is the exact eligible bytes; the rest say why no bytes exist. */
export const ContentSideSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), blob: BlobIdSchema, size: Schema.Natural }),
  /** The file does not exist on this side (added or deleted). */
  Schema.Struct({ kind: Schema.Literal("absent") }),
  /** The path exists but its content is not reviewable text; never captured or reviewed. */
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["binary", "unsupported-encoding", "symlink", "submodule"]),
  }),
]);
export type ContentSide = typeof ContentSideSchema.Type;

/** The same captured content; two unavailable sides with one reason hold no bytes to compare. */
export const sameSide = (old: ContentSide, current: ContentSide) =>
  old.kind === current.kind &&
  (old.kind !== "text" || (current.kind === "text" && old.blob === current.blob)) &&
  (old.kind !== "unavailable" || (current.kind === "unavailable" && old.reason === current.reason));

/** A regular file's Git mode: executable or not. */
export const FileModeSchema = Schema.Literals(["100644", "100755"]);

export const ManifestFileSchema = Schema.Struct({
  path: LogicalPathSchema,
  old: ContentSideSchema,
  new: ContentSideSchema,
  /**
   * Present only when a regular file's executable bit changed. Mode changes are recorded, never
   * reviewed: hunks cover content alone, so a mode-only change has none. On a rename target,
   * `old` is the mode of the `renamedFrom` source.
   */
  modeChange: Schema.optional(Schema.Struct({ old: FileModeSchema, new: FileModeSchema })),
  /**
   * This added file's bytes are exactly those of the named deleted file. Renames are recorded,
   * never reviewed: both paths keep their captured sides and neither has hunks.
   */
  renamedFrom: Schema.optional(LogicalPathSchema),
  /**
   * Present only on a changed file that Git's attributes at capture mark `linguist-generated` or
   * `linguist-vendored`: its new side's, or its old side's when it was deleted. A Generated file
   * starts folded and is otherwise reviewed like any other.
   */
  generated: Schema.optional(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    (file) =>
      file.old.kind !== "absent" ||
      file.new.kind !== "absent" ||
      "a file cannot be absent on both sides",
  ),
  Schema.makeFilter(
    ({ old, new: current, modeChange, renamedFrom }) =>
      modeChange === undefined ||
      (modeChange.old !== modeChange.new &&
        // A rename target's old mode belongs to its source, whose bytes the rename check pins.
        (renamedFrom === undefined ? [old, current] : [current]).every(
          (side) =>
            side.kind === "text" ||
            (side.kind === "unavailable" &&
              side.reason !== "symlink" &&
              side.reason !== "submodule"),
        )) ||
      "a mode change names two different modes of a regular file present on both sides, or of a rename's source and target",
  ),
  Schema.makeFilter(
    ({ old, new: current, renamedFrom }) =>
      renamedFrom === undefined ||
      (old.kind === "absent" && current.kind === "text") ||
      "a rename target is absent on its old side and text on its new side",
  ),
);
export type ManifestFile = typeof ManifestFileSchema.Type;

/**
 * Commits resolved once per capture. Uncommitted `head` is null for an unborn repository (empty
 * baseline). A range's old side is `mergeBase` for `...` and `base` for `..`. A PR's old side is
 * always the merge base of its base branch and head, never a lower layer's newest head.
 */
export const ProvenanceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uncommitted"), head: Schema.NullOr(GitObjectIdSchema) }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    base: GitObjectIdSchema,
    head: GitObjectIdSchema,
    mergeBase: Schema.NullOr(GitObjectIdSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("pr"),
    base: GitObjectIdSchema,
    head: GitObjectIdSchema,
    mergeBase: GitObjectIdSchema,
  }),
]);
export type Provenance = typeof ProvenanceSchema.Type;

/**
 * An immutable captured snapshot: the whole scope's files (unchanged supporting files included) in
 * strictly ascending path order, and text hunks derived from those same bytes. It holds no clock,
 * session, review revision or host path, so equal inputs always have one `snapshotIdOf`.
 */
export const SnapshotManifestSchema = Schema.Struct({
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
  files: Schema.Array(ManifestFileSchema),
  hunks: Schema.Array(HunkSchema),
}).check(
  Schema.makeFilter(
    ({ scope, provenance }) =>
      (provenance.kind === scope.kind &&
        (provenance.kind !== "range" ||
          (scope.kind === "range" && scope.range.includes("...")) ===
            (provenance.mergeBase !== null))) ||
      "provenance must match the recorded scope, with a merge base exactly for `...` ranges",
  ),
  Schema.makeFilter(
    ({ files }) =>
      files.every((file, index) => index === 0 || files[index - 1]!.path < file.path) ||
      "files must be in strictly ascending path order",
  ),
  Schema.makeFilter(({ files, hunks }) => {
    const paths = new Set(files.map((file) => file.path));
    return (
      (hunks.every((hunk) => paths.has(hunk.file)) &&
        new Set(hunks.map((hunk) => hunk.id)).size === hunks.length) ||
      "hunks must have unique ids and name manifest files"
    );
  }),
  Schema.makeFilter(({ files, hunks }) => {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const sources = files.flatMap(({ renamedFrom }) => (renamedFrom ? [renamedFrom] : []));
    const renamed = new Set([...sources, ...files.filter((f) => f.renamedFrom).map((f) => f.path)]);
    return (
      (new Set(sources).size === sources.length &&
        files.every(({ renamedFrom, new: current }) => {
          const source = renamedFrom === undefined ? undefined : byPath.get(renamedFrom);
          return (
            renamedFrom === undefined ||
            (source?.old.kind === "text" &&
              source.new.kind === "absent" &&
              current.kind === "text" &&
              source.old.blob === current.blob)
          );
        }) &&
        hunks.every((hunk) => !renamed.has(hunk.file))) ||
      "a rename pairs one deleted file with an added file of the same bytes, and neither has hunks"
    );
  }),
);
export type SnapshotManifest = typeof SnapshotManifestSchema.Type;

/** Offset and length in bytes; a read stops early at end of content, and `offset` may equal size. */
export const ByteRangeSchema = Schema.Struct({ offset: Schema.Natural, length: Schema.Natural });
export type ByteRange = typeof ByteRangeSchema.Type;

const sortKeys = (_key: string, value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value;

/** The exact stored bytes of a manifest: sorted-key JSON of its encoded form. */
export const canonicalManifestJson = (manifest: SnapshotManifest): string =>
  JSON.stringify(Schema.encodeSync(SnapshotManifestSchema)(manifest), sortKeys);
