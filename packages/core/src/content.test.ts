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

  it("records a byte-identical rename only between an absent-then-text pair of one blob", () => {
    const text = { kind: "text", blob: blob("e"), size: 2 } as const;
    const gone = { path: "a.old", old: text, new: { kind: "absent" } };
    const added = { path: "b.new", old: { kind: "absent" }, new: text, renamedFrom: "a.old" };
    const base = { ...manifest, files: [gone, added], hunks: [] };
    expect(Result.isSuccess(decode(base))).toBe(true);
    const other = { kind: "text", blob: blob("f"), size: 2 };
    for (const invalid of [
      { ...base, files: [gone, { ...added, renamedFrom: "missing" }] },
      { ...base, files: [gone, { ...added, new: other }] },
      { ...base, files: [{ ...gone, new: text }, added] },
      { ...base, files: [gone, { ...added, old: text }] },
      { ...base, files: [gone, added, { ...added, path: "c.new" }] },
      { ...base, hunks: [{ ...manifest.hunks[0], file: "b.new" }] },
      { ...base, hunks: [{ ...manifest.hunks[0], file: "a.old" }] },
    ])
      expect(Result.isFailure(decode(invalid))).toBe(true);
    // A snapshot quota leaves out both sides' bytes or neither; the record stays.
    const quota = { kind: "unavailable", reason: "quota" };
    const leftOut = {
      ...base,
      files: [
        { ...gone, old: quota },
        { ...added, new: quota },
      ],
    };
    expect(Result.isSuccess(decode(leftOut))).toBe(true);
    for (const invalid of [
      { ...base, files: [{ ...gone, old: quota }, added] },
      { ...base, files: [gone, { ...added, new: quota }] },
      { ...leftOut, files: [leftOut.files[0], { ...added, new: { ...quota, reason: "binary" } }] },
      { ...leftOut, hunks: [{ ...manifest.hunks[0], file: "b.new" }] },
    ])
      expect(Result.isFailure(decode(invalid))).toBe(true);
    // A rename that changes mode records the source's mode as the old one, on the target only.
    const change = { old: "100644", new: "100755" };
    expect(
      Result.isSuccess(decode({ ...base, files: [gone, { ...added, modeChange: change }] })),
    ).toBe(true);
    for (const invalid of [
      { ...base, files: [gone, { ...added, modeChange: { old: "100755", new: "100755" } }] },
      { ...base, files: [gone, { ...added, renamedFrom: undefined, modeChange: change }] },
      { ...base, files: [{ ...gone, modeChange: change }, added] },
    ])
      expect(Result.isFailure(decode(invalid))).toBe(true);
  });

  it("requires provenance resolved for the recorded scope", () => {
    const commit = "d".repeat(40);
    const range = (recorded: string, mergeBase: string | null) =>
      decode({
        ...manifest,
        scope: { kind: "range", range: recorded },
        provenance: { kind: "range", base: commit, head: commit, mergeBase },
        commits: [],
      });
    expect(Result.isSuccess(range("main...feature", commit))).toBe(true);
    expect(Result.isSuccess(range("main..feature", null))).toBe(true);
    expect(Result.isFailure(range("main...feature", null))).toBe(true);
    expect(Result.isFailure(range("main..feature", commit))).toBe(true);
    const rangeProvenance = { kind: "range", base: commit, head: commit, mergeBase: null };
    expect(Result.isFailure(decode({ ...manifest, provenance: rangeProvenance }))).toBe(true);
  });

  it("requires a PR scope's own merge base, and only for a PR scope", () => {
    const [base, head, mergeBase] = ["b", "c", "d"].map((char) => char.repeat(40));
    const scope = { kind: "pr", repository: "acme/widgets", number: 2 } as const;
    const pullRequest: SnapshotManifest = {
      ...manifest,
      scope,
      provenance: { kind: "pr", base: base!, head: head!, mergeBase: mergeBase! },
    };
    expect(Result.getOrThrow(decode(pullRequest))).toEqual(pullRequest);
    expect(JSON.parse(canonicalManifestJson(pullRequest)) as SnapshotManifest).toMatchObject({
      scope,
      provenance: pullRequest.provenance,
    });
    for (const invalid of [
      { ...pullRequest, provenance: { ...pullRequest.provenance, mergeBase: null } },
      { ...pullRequest, provenance: { kind: "range", base, head, mergeBase } },
      { ...pullRequest, scope: { kind: "range", range: "main...feature" } },
      { ...manifest, provenance: pullRequest.provenance },
    ])
      expect(Result.isFailure(decode(invalid))).toBe(true);
  });

  it("captures commit messages exactly for a recorded range", () => {
    const commit = "d".repeat(40);
    const range: SnapshotManifest = {
      ...manifest,
      scope: { kind: "range", range: "main..feature" },
      provenance: { kind: "range", base: commit, head: commit, mergeBase: null },
      commits: [{ id: commit, message: "Add a\n\nWhy it matters.\n" }],
    };
    expect(Result.getOrThrow(decode(range))).toEqual(range);
    expect(Result.isSuccess(decode({ ...range, commits: [] }))).toBe(true);
    const pullRequest = {
      ...manifest,
      scope: { kind: "pr", repository: "acme/widgets", number: 2 },
      provenance: { kind: "pr", base: commit, head: commit, mergeBase: commit },
    };
    for (const invalid of [
      { ...range, commits: undefined },
      { ...range, commits: [{ id: "HEAD", message: "" }] },
      { ...manifest, commits: [] },
      { ...pullRequest, commits: range.commits },
    ])
      expect(Result.isFailure(decode(invalid))).toBe(true);
    expect(snapshotIdOf({ ...range, commits: [] })).not.toBe(snapshotIdOf(range));
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
