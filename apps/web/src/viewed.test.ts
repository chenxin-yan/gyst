import { DaemonUnreachable, StaleRevision, ValidationFailed } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { TransportError } from "./api.ts";
import {
  checkboxOf,
  initialViewed,
  intentFor,
  readOneSnapshot,
  replayOf,
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

describe("live progress", () => {
  it("ignores a status read older than the progress shown, finishing a reread", () => {
    const applied = viewedReducer(sent(start()), {
      type: "applied",
      result: result({ revision: 5, hunkIds: ["a1", "a2"], viewed: true }),
    });
    const late = { snapshotId, revision: 4, viewedHunkIds: ["b1"] };
    expect(viewedReducer(applied, { type: "status", status: late })).toBe(applied);
    const rereading = viewedReducer(sent(applied), {
      type: "failed",
      error: { _tag: "stale_revision" },
    });
    const reread = viewedReducer(rereading, { type: "status", status: late });
    expect([reread.busy, reread.revision, [...reread.viewed]]).toEqual([
      undefined,
      5,
      ["b1", "a1", "a2"],
    ]);
    // The same revision applies as read.
    expect(
      viewedReducer(applied, { type: "status", status: { ...late, revision: 5 } }).viewed,
    ).toEqual(new Set(["b1"]));
  });

  it("replays a write whose reply was lost with its request id and payload", () => {
    const sending = sent(start());
    for (const error of [
      new TransportError("unavailable", "lost"),
      new DaemonUnreachable({ message: "restarted" }),
    ]) {
      const failed = viewedReducer(sending, { type: "failed", error });
      const replay = replayOf(failed)!;
      expect(replay).toEqual({ ...sending.intent!, attempts: 2, failure: undefined });
      // Its answer may be the receipt of the first send, so status is read again.
      const answered = viewedReducer(viewedReducer(failed, { type: "send", intent: replay }), {
        type: "applied",
        result: result({ revision: 4, hunkIds: ["a1", "a2"], viewed: true }),
      });
      expect(answered.busy).toEqual({ kind: "rereading", file: "a.ts" });
      expect(answered.revision).toBe(3);
    }
  });

  it("keeps a failed write and its retry across a read of progress changed elsewhere", () => {
    const failed = viewedReducer(sent(start()), {
      type: "failed",
      error: new TransportError("unavailable", "lost"),
    });
    const read = viewedReducer(failed, {
      type: "status",
      status: { snapshotId, revision: 4, viewedHunkIds: ["c1"] },
    });
    expect([read.revision, [...read.viewed], read.intent]).toEqual([4, ["c1"], failed.intent]);
    expect(checkboxOf(read, "a.ts", ["a1", "a2"]).failure).toBe(failed.intent!.failure);
    expect(intentFor(read, change, mint)).toEqual({
      ...failed.intent,
      attempts: 2,
      failure: undefined,
    });
  });

  it("replays nothing while busy or for a write that failed for certain", () => {
    const sending = sent(start());
    expect(replayOf(start())).toBeUndefined();
    expect(replayOf(sending)).toBeUndefined();
    for (const error of [
      new TransportError("unauthorized", "m"),
      new TransportError("forbidden", "m"),
      new StaleRevision({ message: "m" }),
      new ValidationFailed({ message: "m" }),
    ])
      expect(replayOf(viewedReducer(sending, { type: "failed", error }))).toBeUndefined();
  });
});

describe("readOneSnapshot", () => {
  const [a, b] = ["a".repeat(64), "b".repeat(64)];
  // A loader read: the diff's snapshot, and status naming its own snapshot and progress.
  const loaded = (diff: string, status: string) => ({
    snapshotId: diff,
    status: { session: { snapshotId: status }, revision: 2, viewedHunkIds: ["h1"] },
  });
  const reads = (...results: ReturnType<typeof loaded>[]) => {
    let next = 0;
    return async () => results[next++]!;
  };

  it("refuses status of one snapshot beside the diff of another, after one more read", async () => {
    await expect(readOneSnapshot(reads(loaded(b, a), loaded(b, a)))).rejects.toThrow(/Try again/);
    // The second read agreeing is the load.
    expect(await readOneSnapshot(reads(loaded(b, a), loaded(b, b)))).toEqual(loaded(b, b));
  });

  it("starts writable progress from a consistent load", async () => {
    const { status } = await readOneSnapshot(reads(loaded(b, b)));
    const state = initialViewed({ ...status, snapshotId: status.session.snapshotId });
    expect(state).toMatchObject({ snapshotId: b, revision: 2 });
    expect(intentFor(state, change, mint)).toMatchObject({ revision: 2, attempts: 1 });
  });
});
