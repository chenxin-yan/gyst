import { describe, expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import {
  BlobIdSchema,
  canonicalManifestJson,
  GitObjectIdSchema,
  LogicalPathSchema,
  type SnapshotManifest,
  SnapshotManifestSchema,
} from "./content.ts";
import { snapshotIdOf } from "./hash.ts";

const blob = (char: string) => char.repeat(64);
const decode = Schema.decodeUnknownResult(SnapshotManifestSchema);
const manifest: SnapshotManifest = {
  scope: { kind: "uncommitted" },
  provenance: { kind: "uncommitted", head: null },
  files: [
    { path: "a.ts", old: { kind: "absent" }, new: { kind: "text", blob: blob("a"), size: 3 } },
    {
      path: "b/helper.ts",
      old: { kind: "text", blob: blob("b"), size: 1 },
      new: { kind: "text", blob: blob("b"), size: 1 },
    },
  ],
  hunks: [
    {
      id: "h",
      file: "a.ts",
      header: "@@ -0,0 +1 @@",
      patch: "@@ -0,0 +1 @@\n+a",
      contentHash: "c",
    },
  ],
};

describe("SnapshotManifestSchema", () => {
  it("keeps content and Git object identities distinct", () => {
    const isBlob = Schema.is(BlobIdSchema);
    const isGit = Schema.is(GitObjectIdSchema);
    expect(isBlob(blob("a"))).toBe(true);
    expect(isBlob("a".repeat(40))).toBe(false);
    expect(isBlob(blob("A"))).toBe(false);
    expect(isGit("a".repeat(40))).toBe(true);
    expect(isGit("a".repeat(41))).toBe(false);
  });

  it("accepts only project-relative logical paths", () => {
    const isPath = Schema.is(LogicalPathSchema);
    for (const path of ["a", "src/a b.ts", ".github/x", "a\\b"]) expect(isPath(path)).toBe(true);
    for (const path of ["", "/etc/passwd", "a/../b", "./a", "a//b", "a/", "..", "a\0b"])
      expect(isPath(path)).toBe(false);
  });

  it("rejects unordered, duplicate, doubly absent and dangling entries", () => {
    expect(Result.isSuccess(decode(manifest))).toBe(true);
    const [a, b] = manifest.files;
    const invalid: unknown[] = [
      { ...manifest, files: [b, a] },
      { ...manifest, files: [a, a] },
      {
        ...manifest,
        files: [{ path: "a.ts", old: { kind: "absent" }, new: { kind: "absent" } }, b],
      },
      { ...manifest, hunks: [{ ...manifest.hunks[0], file: "missing.ts" }] },
      { ...manifest, hunks: [manifest.hunks[0], manifest.hunks[0]] },
      { ...manifest, files: [{ ...a, new: { kind: "text", blob: "a".repeat(40), size: 3 } }, b] },
      { ...manifest, files: [{ ...a, new: { kind: "unavailable", reason: "too-large" } }, b] },
      { ...manifest, files: [{ ...a, new: { kind: "text", blob: blob("a"), size: -1 } }, b] },
    ];
    for (const value of invalid) expect(Result.isFailure(decode(value))).toBe(true);
  });

  it("records a mode change only between two different regular-file modes", () => {
    const [a, b] = manifest.files;
    const withMode = (file: unknown) => decode({ ...manifest, files: [a, file] });
    const change = { old: "100644", new: "100755" };
    expect(Result.isSuccess(withMode({ ...b, modeChange: change }))).toBe(true);
    const binary = { kind: "unavailable", reason: "binary" };
    expect(Result.isSuccess(withMode({ ...b, old: binary, modeChange: change }))).toBe(true);
    for (const invalid of [
      { ...b, modeChange: { old: "100644", new: "100644" } },
      { ...b, modeChange: { old: "100644", new: "120000" } },
      { ...b, old: { kind: "absent" }, modeChange: change },
      { ...b, old: { kind: "unavailable", reason: "symlink" }, modeChange: change },
    ])
      expect(Result.isFailure(withMode(invalid))).toBe(true);
  });

  it("requires provenance resolved for the recorded scope", () => {
    const commit = "d".repeat(40);
    const range = (recorded: string, mergeBase: string | null) =>
      decode({
        ...manifest,
        scope: { kind: "range", range: recorded },
        provenance: { kind: "range", base: commit, head: commit, mergeBase },
      });
    expect(Result.isSuccess(range("main...feature", commit))).toBe(true);
    expect(Result.isSuccess(range("main..feature", null))).toBe(true);
    expect(Result.isFailure(range("main...feature", null))).toBe(true);
    expect(Result.isFailure(range("main..feature", commit))).toBe(true);
    const rangeProvenance = { kind: "range", base: commit, head: commit, mergeBase: null };
    expect(Result.isFailure(decode({ ...manifest, provenance: rangeProvenance }))).toBe(true);
  });
});

describe("snapshotIdOf", () => {
  it("is a deterministic content identity that includes supporting files", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        hunks: manifest.hunks,
        files: manifest.files,
        provenance: manifest.provenance,
        scope: manifest.scope,
      }),
    ) as SnapshotManifest;
    expect(snapshotIdOf(reordered)).toBe(snapshotIdOf(manifest));
    // Keys are sorted at every level, independent of schema field order.
    expect(canonicalManifestJson(manifest)).toMatch(/^\{"files":\[\{"new":\{"blob":/);
    expect(snapshotIdOf(manifest)).toMatch(/^[0-9a-f]{64}$/);
    // A helper-only change with an identical patch is a different snapshot.
    const [a, b] = manifest.files;
    const helperChanged: SnapshotManifest = {
      ...manifest,
      files: [a!, { ...b!, new: { kind: "text", blob: blob("c"), size: 1 } }],
    };
    expect(snapshotIdOf(helperChanged)).not.toBe(snapshotIdOf(manifest));
  });
});
