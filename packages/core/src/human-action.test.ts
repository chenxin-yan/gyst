import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import type { Hunk, Session } from "./index.ts";
import { applyHumanAction } from "./index.ts";

const hunk = (id: string, tldr?: string): Hunk => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
  ...(tldr === undefined ? {} : { tldr }),
  accepted: false,
});

const unready: Session = {
  id: "session",
  repoRoot: "/repo",
  source: { kind: "stdin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  seq: 3,
  cursor: { itemId: "g1", expanded: false },
  hunks: [hunk("h1"), hunk("h2", "read me")],
  groups: [{ id: "g1", tldr: "same edit", exemplarHunkId: "h1", hunkIds: ["h1"], accepted: false }],
  queue: ["g1", "h2"],
  queueSet: false,
  acceptHistory: [],
  applyReceipts: [],
};
const ready: Session = { ...unready, queueSet: true };
const frame = { sessionId: "session", revision: 3 };

const failure = (result: ReturnType<typeof applyHumanAction>) => {
  if (Result.isSuccess(result)) throw new Error("expected validation failure");
  return result.failure;
};

describe("applyHumanAction", () => {
  it("rejects verdicts until the review queue is set, keeping cursor moves and folds available", () => {
    for (const action of [
      { type: "verdict.toggle", itemId: "g1", ...frame } as const,
      { type: "verdict.undo", ...frame } as const,
    ]) {
      expect(failure(applyHumanAction(unready, action))).toMatchObject({
        _tag: "validation_failed",
        message: "review queue is not set",
      });
    }
    const moved = Result.getOrThrow(
      applyHumanAction(unready, { type: "cursor.move", itemId: "h2" }),
    );
    expect(moved).toMatchObject({ cursor: { itemId: "h2", expanded: false }, revision: 3, seq: 4 });
    const expanded = Result.getOrThrow(applyHumanAction(unready, { type: "expand.toggle" }));
    expect(expanded).toMatchObject({
      cursor: { itemId: "g1", expanded: true },
      revision: 3,
      seq: 4,
    });
  });

  it("toggles and undoes verdicts on a ready session, bumping seq exactly once per step", () => {
    const accepted = Result.getOrThrow(
      applyHumanAction(ready, { type: "verdict.toggle", itemId: "g1", ...frame }),
    );
    expect(accepted).toMatchObject({ revision: 4, seq: 4, acceptHistory: ["g1"] });
    expect(accepted.groups[0]?.accepted).toBe(true);
    const undone = Result.getOrThrow(
      applyHumanAction(accepted, { type: "verdict.undo", sessionId: "session", revision: 4 }),
    );
    expect(undone).toMatchObject({ revision: 5, seq: 5, acceptHistory: [] });
    expect(undone.groups[0]?.accepted).toBe(false);
  });
});
