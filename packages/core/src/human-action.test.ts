import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import { applyHumanAction } from "./human-action.ts";
import type { Hunk, Session } from "./session.ts";

const LATER = "2026-02-02T00:00:00.000Z";

const hunk = (id: string, title?: string): Hunk => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
  ...(title === undefined ? {} : { title, overview: title }),
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
  groups: [
    {
      id: "g1",
      title: "same edit",
      overview: "intent and behavior",
      hunkIds: ["h1"],
      accepted: false,
    },
  ],
  queue: ["g1", "h2"],
  queueSet: false,
  acceptHistory: [],
  receiptOverviews: [],
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
      expect(failure(applyHumanAction(unready, action, LATER))).toMatchObject({
        _tag: "validation_failed",
        message: "review queue is not set",
      });
    }
    const moved = Result.getOrThrow(
      applyHumanAction(unready, { type: "cursor.move", itemId: "h2" }, LATER),
    );
    expect(moved).toMatchObject({ cursor: { itemId: "h2", expanded: false }, revision: 3, seq: 4 });
    const expanded = Result.getOrThrow(applyHumanAction(unready, { type: "expand.toggle" }, LATER));
    expect(expanded).toMatchObject({
      cursor: { itemId: "g1", expanded: true },
      revision: 3,
      seq: 4,
    });
  });

  it("focuses a hunk inside the current item, expanding groups, and drops focus on fold, move and leave", () => {
    const focused = Result.getOrThrow(
      applyHumanAction(unready, { type: "cursor.focus", hunkId: "h1" }, LATER),
    );
    expect(focused).toMatchObject({
      cursor: { itemId: "g1", expanded: true, hunkId: "h1" },
      revision: 3,
      seq: 4,
    });
    expect(
      failure(applyHumanAction(unready, { type: "cursor.focus", hunkId: "h2" }, LATER)),
    ).toMatchObject({ _tag: "validation_failed" });
    expect(
      Result.getOrThrow(applyHumanAction(focused, { type: "cursor.focus", hunkId: null }, LATER))
        .cursor,
    ).toEqual({ itemId: "g1", expanded: true });
    expect(
      Result.getOrThrow(applyHumanAction(focused, { type: "expand.toggle" }, LATER)).cursor,
    ).toEqual({ itemId: "g1", expanded: false });
    expect(
      Result.getOrThrow(applyHumanAction(focused, { type: "cursor.move", itemId: "h2" }, LATER))
        .cursor,
    ).toEqual({ itemId: "h2", expanded: false });
    // A lone hunk is its own focus target and needs no expansion.
    const spotlight = Result.getOrThrow(
      applyHumanAction(
        { ...unready, cursor: { itemId: "h2", expanded: false } },
        { type: "cursor.focus", hunkId: "h2" },
        LATER,
      ),
    );
    expect(spotlight.cursor).toEqual({ itemId: "h2", expanded: false, hunkId: "h2" });
    expect(
      failure(
        applyHumanAction(
          { ...unready, cursor: { itemId: null, expanded: false } },
          { type: "cursor.focus", hunkId: "h1" },
          LATER,
        ),
      ),
    ).toMatchObject({ _tag: "validation_failed" });
  });

  it("toggles and undoes verdicts on a ready session, bumping seq exactly once per step", () => {
    const accepted = Result.getOrThrow(
      applyHumanAction(ready, { type: "verdict.toggle", itemId: "g1", ...frame }, LATER),
    );
    expect(accepted).toMatchObject({
      revision: 4,
      seq: 4,
      acceptHistory: ["g1"],
      updatedAt: LATER,
    });
    expect(accepted.groups[0]?.accepted).toBe(true);
    const undone = Result.getOrThrow(
      applyHumanAction(
        accepted,
        { type: "verdict.undo", sessionId: "session", revision: 4 },
        LATER,
      ),
    );
    expect(undone).toMatchObject({ revision: 5, seq: 5, acceptHistory: [] });
    expect(undone.groups[0]?.accepted).toBe(false);
  });
});
