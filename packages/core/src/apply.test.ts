import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import { type ApplyEnvelope, type ApplyOp, applyBatch } from "./apply.ts";
import type { Hunk, Session } from "./session.ts";

const LATER = "2026-02-02T00:00:00.000Z";

const hunk = (id: string, tldr?: string, accepted = false): Hunk => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
  ...(tldr === undefined ? {} : { tldr }),
  accepted,
});

const session: Session = {
  id: "session",
  repoRoot: "/repo",
  source: { kind: "stdin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  seq: 3,
  cursor: { itemId: null, expanded: false },
  hunks: [hunk("h1", "first", true), hunk("h2", "second", true), hunk("h3")],
  groups: [],
  queue: ["h1", "h2", "h3"],
  queueSet: false,
  acceptHistory: ["h1", "h2"],
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

describe("applyBatch", () => {
  it("resets a spotlight verdict when its annotation changes, not when it is repeated", () => {
    const reworded = applied([{ type: "hunk.annotate", hunkId: "h1", tldr: "reworded" }]);
    expect(reworded.hunks[0]).toEqual(
      expect.objectContaining({ tldr: "reworded", accepted: false }),
    );
    expect(reworded.hunks[1]?.accepted).toBe(true);
    expect(reworded.acceptHistory).toEqual(["h2"]);

    const repeated = applied([{ type: "hunk.annotate", hunkId: "h1", tldr: "first" }]);
    expect(repeated.hunks[0]).toEqual(expect.objectContaining({ tldr: "first", accepted: true }));
    expect(repeated.acceptHistory).toEqual(["h1", "h2"]);

    // A finalized queue survives a re-wording, so the history must be pruned even then.
    const finalized = applied([{ type: "hunk.annotate", hunkId: "h1", tldr: "reworded" }], {
      ...session,
      hunks: [session.hunks[0]!, session.hunks[1]!],
      queue: ["h1", "h2"],
      queueSet: true,
    });
    expect(finalized).toMatchObject({ queueSet: true, acceptHistory: ["h2"] });
  });

  it("rejects an empty group id and leaves the batch unapplied", () => {
    for (const id of ["", "  "]) {
      const error = rejected([
        { type: "hunk.annotate", hunkId: "h3", tldr: "third" },
        {
          type: "group.create",
          id,
          tldr: "mechanical",
          memberHunkIds: ["h3"],
          exemplarHunkId: "h3",
        },
      ]);
      expect(error._tag).toBe("validation_failed");
      expect(error.detail).toEqual([{ opIndex: 1, message: "group id must not be empty" }]);
    }
    expect(rejected([{ type: "group.update", id: "", tldr: "renamed" }]).detail).toEqual([
      { opIndex: 0, message: "group id must not be empty" },
    ]);
  });

  it("clears a hunk's verdict once it is hidden inside a group", () => {
    const grouped = applied([
      { type: "group.create", id: "g1", tldr: "same", memberHunkIds: ["h1"], exemplarHunkId: "h1" },
    ]);
    expect(grouped.hunks[0]?.accepted).toBe(false);
    expect(grouped.hunks[1]?.accepted).toBe(true);
    expect(grouped.acceptHistory).toEqual(["h2"]);

    const widened = applied(
      [{ type: "group.update", id: "g1", memberHunkIds: ["h1", "h2"] }],
      { ...grouped, revision: 3 },
      "widen",
    );
    expect(widened.hunks.map(({ accepted }) => accepted)).toEqual([false, false, false]);
    expect(widened.acceptHistory).toEqual([]);
  });

  it("replays only an identical envelope under a reused idempotency key", () => {
    const ops: ApplyOp[] = [{ type: "hunk.annotate", hunkId: "h3", tldr: "third" }];
    const first = Result.getOrThrow(applyBatch(session, batch(ops), LATER));
    const next = first.session!;
    expect(next.updatedAt).toBe(LATER);

    const replay = Result.getOrThrow(applyBatch(next, batch(ops), LATER));
    expect(replay).toEqual({ status: first.status });

    for (const different of [
      batch([{ type: "hunk.annotate", hunkId: "h3", tldr: "changed" }]),
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
