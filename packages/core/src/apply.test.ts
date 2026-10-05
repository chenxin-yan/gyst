import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";
import { type ApplyEnvelope, type ApplyOp, applyBatch } from "./apply.ts";
import type { Hunk, Session } from "./session.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";

const hunk = (id: string): Hunk => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
});

const session: Session = {
  id: "session",
  repoRoot: "/repo",
  scope: { kind: "uncommitted" },
  snapshotId: "snapshot",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  hunks: [hunk("h1"), hunk("h2"), hunk("h3")],
  groups: [
    {
      id: "g1",
      title: "first",
      notes: [{ hunkId: "h1", text: "first" }],
      hunkIds: ["h1"],
    },
    { id: "g2", title: "second", notes: [], hunkIds: ["h2"] },
  ],
  viewedHunkIds: ["h1"],
  receiptNoteTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
};

const batch = (ops: ApplyOp[], idempotencyKey = "key"): ApplyEnvelope => ({
  revision: 3,
  idempotencyKey,
  ops,
});
const applied = (ops: ApplyOp[], from = session, idempotencyKey?: string) =>
  Result.getOrThrow(applyBatch(from, batch(ops, idempotencyKey), LATER)).session!;
const rejected = (ops: ApplyOp[]) => {
  const result = applyBatch(session, batch(ops), LATER);
  if (Result.isSuccess(result)) throw new Error("expected validation failure");
  return result.failure;
};

const third: ApplyOp = {
  type: "group.create",
  id: "g3",
  title: "third",
  notes: [],
  memberHunkIds: ["h3"],
};

describe("applyBatch", () => {
  it("applies group edits as one batch with no queue to set", () => {
    const changed = applied([
      { type: "group.update", id: "g1", title: "Reworded", memberHunkIds: ["h1", "h3"] },
      { type: "group.update", id: "g2", notes: [{ hunkId: "h2", text: "Updated context" }] },
    ]);
    expect(changed.groups).toEqual([
      {
        id: "g1",
        title: "Reworded",
        notes: [{ hunkId: "h1", text: "first" }],
        hunkIds: ["h1", "h3"],
      },
      {
        id: "g2",
        title: "second",
        notes: [{ hunkId: "h2", text: "Updated context" }],
        hunkIds: ["h2"],
      },
    ]);
    expect(changed.revision).toBe(4);
    expect(session.groups[0]?.title).toBe("first");
  });

  it("rejects an empty group id and leaves the batch unapplied", () => {
    for (const id of ["", "  "]) {
      const error = rejected([
        { type: "group.update", id: "g1", title: "reworded" },
        { ...third, id },
      ]);
      expect(error._tag).toBe("validation_failed");
      expect(error.detail).toEqual([{ opIndex: 1, message: "group id must not be empty" }]);
    }
    expect(session.groups[0]?.title).toBe("first");
    expect(rejected([{ type: "group.update", id: "", title: "renamed" }]).detail).toEqual([
      { opIndex: 0, message: "group id must not be empty" },
    ]);
    expect(rejected([{ ...third, memberHunkIds: ["h1"] }]).detail).toEqual([
      { opIndex: 0, message: "a hunk may belong to only one group" },
    ]);
  });

  it("leaves dissolved members ungrouped under their files", () => {
    const dissolved = applied([{ type: "group.dissolve", id: "g1" }]);
    expect(statusOf(dissolved).groups.map(({ id }) => id)).toEqual(["g2"]);
    expect(dissolved.hunks).toEqual(session.hunks);
    expect(rejected([{ type: "group.dissolve", id: "g9" }]).detail).toEqual([
      { opIndex: 0, message: "group g9 does not exist" },
    ]);
  });

  it("replays only an identical envelope under a reused idempotency key", () => {
    const ops: ApplyOp[] = [third];
    const first = Result.getOrThrow(applyBatch(session, batch(ops), LATER));
    const next = first.session!;
    expect(next.updatedAt).toBe(LATER);

    const replay = Result.getOrThrow(applyBatch(next, batch(ops), LATER));
    expect(replay).toEqual({ status: first.status });

    for (const different of [
      batch([{ ...third, title: "changed" }]),
      { ...batch(ops), revision: next.revision },
    ]) {
      const reused = applyBatch(next, different, LATER);
      if (Result.isSuccess(reused)) throw new Error("expected validation failure");
      expect(reused.failure).toMatchObject({
        _tag: "validation_failed",
        message: "idempotency key reused with a different batch",
      });
    }
  });
});
