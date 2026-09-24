import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { applyHumanAction, HumanActionSchema, type HumanAction } from "./human-action.ts";
import type { Hunk, Session } from "./session.ts";

const LATER = "2026-02-02T00:00:00.000Z";
const hunk = (id: string): Hunk => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
});
const ready: Session = {
  id: "session",
  repoRoot: "/repo",
  source: { kind: "stdin" },
  createdAt: LATER,
  updatedAt: LATER,
  revision: 3,
  seq: 3,
  cursor: { itemId: "g1", pane: "queue", hunkId: "h1" },
  hunks: [hunk("h1"), hunk("h2"), hunk("h3"), hunk("inbox")],
  groups: [
    {
      id: "g1",
      title: "coherent edit",
      notes: [{ hunkId: "h1", text: "intent and behavior" }],
      hunkIds: ["h1"],
      accepted: false,
    },
    { id: "g2", title: "read me", notes: [], hunkIds: ["h2"], accepted: false },
    { id: "g3", title: "other", notes: [], hunkIds: ["h3"], accepted: false },
  ],
  queue: ["g1", "g2", "g3"],
  queueSet: true,
  acceptHistory: [],
  receiptNoteTexts: [],
  applyReceipts: [],
};
const frame = { sessionId: "session", revision: 3 };
const act = (session: Session, action: HumanAction) =>
  Result.getOrThrow(applyHumanAction(session, action, LATER));
const toggle = (session: Session, itemId: string) =>
  act(session, { type: "verdict.toggle", itemId, ...frame });

describe("applyHumanAction", () => {
  it("rejects verdicts until the queue is set, keeping cursor navigation available", () => {
    const unready = { ...ready, queueSet: false };
    for (const action of [
      { type: "verdict.toggle", itemId: "g1", ...frame } as const,
      { type: "verdict.undo", ...frame } as const,
    ])
      expect(Result.isFailure(applyHumanAction(unready, action, LATER))).toBe(true);
    expect(act(unready, { type: "cursor.move", itemId: "g2" })).toMatchObject({
      cursor: { itemId: "g2", pane: "queue" },
      revision: 3,
      seq: 4,
    });
  });

  it("focuses pane and hunk atomically and rejects invalid targets and legacy actions", () => {
    const focused = act(ready, { type: "cursor.focus", itemId: "g1", pane: "diff", hunkId: "h1" });
    expect(focused).toMatchObject({
      cursor: { itemId: "g1", pane: "diff", hunkId: "h1" },
      revision: 3,
      seq: 4,
    });
    const browse = act(focused, {
      type: "cursor.focus",
      itemId: "g1",
      pane: "queue",
      hunkId: "h1",
    });
    expect(browse.cursor).toEqual({ itemId: "g1", pane: "queue", hunkId: "h1" });
    expect(act(focused, { type: "cursor.move", itemId: "g2" }).cursor).toEqual({
      itemId: "g2",
      pane: "queue",
      hunkId: "h2",
    });
    for (const itemId of ["g1", "missing"]) {
      expect(
        Result.isFailure(
          applyHumanAction(
            ready,
            { type: "cursor.focus", itemId, pane: "diff", hunkId: "h2" },
            LATER,
          ),
        ),
      ).toBe(true);
    }
    const decode = Schema.decodeUnknownResult(HumanActionSchema);
    for (const action of [
      { type: "expand.toggle" },
      { type: "cursor.focus", itemId: "g1", pane: "overview", hunkId: "h1" },
      { type: "cursor.focus", itemId: "g1", pane: "queue" },
      { type: "cursor.focus", hunkId: "h1" },
      { type: "cursor.focus", itemId: "g1", pane: "diff" },
    ])
      expect(Result.isFailure(decode(action))).toBe(true);
  });

  it("follows only the observed session, revision and sequence, with required wire guards", () => {
    const follow = {
      type: "cursor.follow",
      itemId: "g1",
      pane: "diff",
      hunkId: "h1",
      ...frame,
      seq: ready.seq,
    } as const;
    const decode = Schema.decodeUnknownResult(HumanActionSchema);
    expect(Result.getOrThrow(decode(follow))).toEqual(follow);
    for (const field of ["sessionId", "revision", "seq"] as const) {
      const incomplete: Record<string, unknown> = { ...follow };
      delete incomplete[field];
      expect(Result.isFailure(decode(incomplete))).toBe(true);
    }
    expect(act(ready, follow)).toMatchObject({
      cursor: { itemId: "g1", pane: "diff", hunkId: "h1" },
      revision: ready.revision,
      seq: ready.seq + 1,
    });
    for (const changed of [
      { ...ready, id: "replacement" },
      { ...ready, revision: ready.revision + 1 },
      act(ready, { type: "cursor.focus", itemId: "g2", pane: "diff", hunkId: "h2" }),
    ])
      expect(act(changed, follow)).toBe(changed);
    expect(Result.isFailure(applyHumanAction(ready, { ...follow, hunkId: "h2" }, LATER))).toBe(
      true,
    );
  });

  it("accepts atomically, skips accepted items and inbox, wraps once, and stays zoomed", () => {
    const start: Session = {
      ...ready,
      groups: ready.groups.map((group) =>
        group.id === "g2" ? { ...group, accepted: true } : group,
      ),
      cursor: { itemId: "g3", pane: "diff", hunkId: "h3" },
    };
    const accepted = toggle(start, "g3");
    expect(accepted).toMatchObject({
      revision: 4,
      seq: 4,
      acceptHistory: ["g3"],
      updatedAt: LATER,
    });
    expect(accepted.cursor).toEqual({ itemId: "g1", pane: "diff", hunkId: "h1" });
    const completed = toggle(accepted, "g1");
    expect(completed.cursor).toEqual(accepted.cursor);
    expect(completed.groups[0]?.accepted).toBe(true);
    expect(toggle(ready, "g1").cursor).toEqual({ itemId: "g2", pane: "queue", hunkId: "h2" });
    expect(ready.groups[0]?.accepted).toBe(false);
  });

  it("unaccept does not advance; undo returns to the item and retains zoom", () => {
    const accepted = toggle(ready, "g1");
    expect(toggle(accepted, "g1").cursor).toEqual(accepted.cursor);
    const zoomed = act(accepted, {
      type: "cursor.focus",
      itemId: "g2",
      pane: "diff",
      hunkId: "h2",
    });
    const undone = act(zoomed, { type: "verdict.undo", ...frame });
    expect(undone.cursor).toEqual({ itemId: "g1", pane: "diff", hunkId: "h1" });
    expect(undone.groups[0]?.accepted).toBe(false);
    expect(undone.acceptHistory).toEqual([]);
    expect(act(accepted, { type: "verdict.undo", ...frame }).cursor).toEqual({
      itemId: "g1",
      pane: "queue",
      hunkId: "h1",
    });
  });

  it("a delayed explicitly named verdict never teleports an unrelated shared cursor", () => {
    const moved = act(ready, {
      type: "cursor.focus",
      itemId: "g2",
      pane: "diff",
      hunkId: "h2",
    });
    const accepted = toggle(moved, "g1");
    expect(accepted.groups[0]?.accepted).toBe(true);
    expect(accepted.cursor).toEqual(moved.cursor);
  });
});
