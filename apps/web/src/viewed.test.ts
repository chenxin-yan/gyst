import { describe, expect, it } from "vite-plus/test";
import {
  checkboxOf,
  initialViewed,
  intentFor,
  sectionViewed,
  type ViewedState,
  viewedReducer,
} from "./viewed.ts";

const snapshotId = "s".repeat(64);
const start = () => initialViewed({ snapshotId, revision: 3, viewedHunkIds: ["b1"] });
let minted = 0;
const mint = () => `r${++minted}`;
const change = { file: "a.ts", hunkIds: ["a1", "a2"], viewed: true };
const result = (fields: { revision: number; hunkIds: string[]; viewed: boolean }) => ({
  sessionId: "s1",
  snapshotId,
  ...fields,
});
const sent = (state: ViewedState) => {
  const intent = intentFor(state, change, mint)!;
  return viewedReducer(state, { type: "send", intent });
};

describe("sectionViewed", () => {
  it("is checked only when every hunk of the section is Viewed, never for an empty one", () => {
    const viewed = new Set(["a1", "a2"]);
    expect(sectionViewed(["a1", "a2"], viewed)).toBe(true);
    expect(sectionViewed(["a1", "a3"], viewed)).toBe(false);
    expect(sectionViewed([], viewed)).toBe(false);
  });
});

describe("Viewed writes", () => {
  it("mints a request id when the human acts, against the revision they saw", () => {
    const intent = intentFor(start(), change, mint)!;
    expect(intent).toMatchObject({ ...change, revision: 3, attempts: 1 });
    expect(intent.requestId).toMatch(/^r\d+$/);
  });

  it("applies a first answer: the section's hunks and the new revision", () => {
    const applied = viewedReducer(sent(start()), {
      type: "applied",
      result: result({ revision: 4, hunkIds: ["a1", "a2"], viewed: true }),
    });
    expect([...applied.viewed]).toEqual(["b1", "a1", "a2"]);
    expect([applied.revision, applied.intent, applied.busy]).toEqual([4, undefined, undefined]);
    // Unchecking clears exactly that section.
    const cleared = viewedReducer(
      viewedReducer(applied, {
        type: "send",
        intent: intentFor(applied, { ...change, viewed: false }, mint)!,
      }),
      { type: "applied", result: result({ revision: 5, hunkIds: ["a1", "a2"], viewed: false }) },
    );
    expect([...cleared.viewed]).toEqual(["b1"]);
  });

  it("allows one write at a time and shows the asked state while it is sent", () => {
    const sending = sent(start());
    expect(intentFor(sending, { ...change, file: "b.ts" }, mint)).toBeUndefined();
    expect(checkboxOf(sending, "a.ts", ["a1", "a2"])).toMatchObject({
      checked: true,
      pending: "sending",
    });
    expect(checkboxOf(sending, "b.ts", ["b1"])).toMatchObject({
      checked: true,
      pending: undefined,
    });
  });

  it("keeps a failed intent for its retry with the same request id and revision", () => {
    const sending = sent(start());
    const failed = viewedReducer(sending, { type: "failed", error: new Error("offline") });
    expect(failed.busy).toBeUndefined();
    expect(checkboxOf(failed, "a.ts", ["a1", "a2"])).toMatchObject({
      checked: false,
      failure: new Error("offline"),
    });
    const retry = intentFor(failed, change, mint)!;
    expect(retry).toMatchObject({
      requestId: sending.intent!.requestId,
      revision: 3,
      attempts: 2,
      failure: undefined,
    });
    // Another change is a new intent with a new id.
    expect(intentFor(failed, { ...change, viewed: false }, mint)!.requestId).not.toBe(
      sending.intent!.requestId,
    );
  });

  it("reads status again after a retried answer, which may replay an earlier one", () => {
    const failed = viewedReducer(sent(start()), { type: "failed", error: new Error("lost") });
    const retried = viewedReducer(failed, {
      type: "send",
      intent: intentFor(failed, change, mint)!,
    });
    const answered = viewedReducer(retried, {
      type: "applied",
      result: result({ revision: 4, hunkIds: ["a1", "a2"], viewed: true }),
    });
    expect(answered.busy).toEqual({ kind: "rereading", file: "a.ts" });
    expect([...answered.viewed]).toEqual(["b1"]);
    expect(intentFor(answered, change, mint)).toBeUndefined();
    const reread = viewedReducer(answered, {
      type: "status",
      status: { snapshotId, revision: 6, viewedHunkIds: ["a1", "a2", "c1"] },
    });
    expect([[...reread.viewed], reread.revision, reread.busy]).toEqual([
      ["a1", "a2", "c1"],
      6,
      undefined,
    ]);
  });

  it("treats a stale or reused intent as a conflict: reread, never overwrite", () => {
    for (const _tag of ["stale_revision", "validation_failed"]) {
      const conflicted = viewedReducer(sent(start()), {
        type: "failed",
        error: { _tag, message: "x" },
      });
      expect(conflicted.intent).toBeUndefined();
      expect(conflicted.busy).toEqual({ kind: "rereading", file: "a.ts" });
      expect(conflicted.notice).toEqual({ file: "a.ts", kind: "conflict" });
      const reread = viewedReducer(conflicted, {
        type: "status",
        status: { snapshotId, revision: 9, viewedHunkIds: [] },
      });
      expect([reread.revision, reread.notice?.kind, [...reread.viewed]]).toEqual([
        9,
        "conflict",
        [],
      ]);
    }
  });

  it("asks for a reload when the snapshot was replaced or status can't be read", () => {
    const conflicted = viewedReducer(sent(start()), {
      type: "failed",
      error: { _tag: "stale_revision", message: "x" },
    });
    const replaced = viewedReducer(conflicted, {
      type: "status",
      status: { snapshotId: "t".repeat(64), revision: 1, viewedHunkIds: [] },
    });
    expect([replaced.notice, replaced.busy, replaced.revision]).toEqual([
      { file: "a.ts", kind: "reload" },
      undefined,
      3,
    ]);
    const unread = viewedReducer(conflicted, { type: "unread", error: new Error("down") });
    expect(unread.notice).toEqual({ file: "a.ts", kind: "reload", failure: new Error("down") });
    // No new write until a reread succeeds.
    expect(intentFor(unread, change, mint)).toBeUndefined();
    expect(intentFor(replaced, change, mint)).toBeUndefined();
  });

  it("recovers from a failed reread with a successful status read of the same snapshot", () => {
    const unread = viewedReducer(
      viewedReducer(sent(start()), { type: "failed", error: { _tag: "stale_revision" } }),
      { type: "unread", error: new Error("down") },
    );
    // A reload of the same snapshot reads status again.
    const reloaded = viewedReducer(unread, {
      type: "status",
      status: { snapshotId, revision: 7, viewedHunkIds: ["c1"] },
    });
    expect([reloaded.notice, reloaded.revision, [...reloaded.viewed]]).toEqual([
      undefined,
      7,
      ["c1"],
    ]);
    expect(intentFor(reloaded, change, mint)).toMatchObject({ revision: 7, attempts: 1 });
  });
});
