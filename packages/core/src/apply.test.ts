import { describe, expect, it } from "bun:test";
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
  source: { kind: "stdin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  seq: 3,
  cursor: { itemId: null, pane: "queue" },
  hunks: [hunk("h1"), hunk("h2"), hunk("h3")],
  groups: [
    { id: "g1", title: "first", overview: "first", hunkIds: ["h1"], accepted: true },
    { id: "g2", title: "second", overview: "second", hunkIds: ["h2"], accepted: true },
  ],
  queue: ["g1", "g2", "h3"],
  queueSet: false,
  acceptHistory: ["g1", "g2"],
  receiptOverviews: [],
  applyReceipts: [],
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
  overview: "third",
  memberHunkIds: ["h3"],
};

describe("applyBatch", () => {
  it("invalidates title, overview and membership edits without losing unrelated verdicts", () => {
    for (const update of [
      { title: "Reworded" },
      { overview: "Updated context" },
      { memberHunkIds: ["h1", "h3"] },
    ]) {
      const changed = applied([
        { type: "group.update", id: "g1", ...update },
        { type: "queue.set", itemIds: ["g1", "g2"] },
      ]);
      expect(changed.groups[0]?.accepted).toBe(false);
      expect(changed.groups[1]?.accepted).toBe(true);
      expect(changed.acceptHistory).toEqual(["g2"]);
      expect(changed.queueSet).toBe(true);
    }
    expect(session.groups[0]?.accepted).toBe(true);
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

  it("returns dissolved members to inbox without retaining review state", () => {
    const dissolved = applied([
      { type: "group.dissolve", id: "g1" },
      { type: "queue.set", itemIds: ["g2"] },
    ]);
    expect(statusOf(dissolved).inbox.map(({ id }) => id)).toEqual(["h1", "h3"]);
    expect(dissolved.hunks).toEqual(session.hunks);
    expect(dissolved.acceptHistory).toEqual(["g2"]);
    expect(dissolved.groups[0]?.accepted).toBe(true);
  });

  it("replays only an identical envelope under a reused idempotency key", () => {
    const ops: ApplyOp[] = [third, { type: "queue.set", itemIds: ["g1", "g2", "g3"] }];
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
