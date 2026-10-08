import { describe, expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import { setViewed, type ViewedRequest } from "./human-action.ts";
import { type Hunk, type Session, SessionSchema } from "./session.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";
const hunk = (id: string, file = `${id}.ts`): Hunk => ({
  id,
  file,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${id}`,
  contentHash: id,
});
const session: Session = {
  id: "session",
  repoRoot: "/repo",
  scope: { kind: "uncommitted" },
  snapshotId: "snapshot",
  createdAt: LATER,
  updatedAt: LATER,
  revision: 3,
  hunks: [hunk("a1", "a.ts"), hunk("a2", "a.ts"), hunk("b1", "b.ts")],
  overview: null,
  groups: [
    { id: "g", title: "grouped", overview: null, hunkIds: ["a1"], files: ["a.ts"], notes: [] },
  ],
  viewedHunkIds: [],
  receiptTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
  refreshReceipts: [],
  threads: [],
  drafts: [],
  conversationReceipts: [],
  pickupReceipts: [],
};
const request = (fields: Partial<ViewedRequest> = {}): ViewedRequest => ({
  command: "viewed",
  session: "session",
  snapshotId: "snapshot",
  revision: 3,
  requestId: "r1",
  hunkIds: ["a1"],
  viewed: true,
  ...fields,
});
const set = (from: Session, fields?: Partial<ViewedRequest>) =>
  Result.getOrThrow(setViewed(from, request(fields), LATER));
const failure = (from: Session, fields?: Partial<ViewedRequest>) => {
  const result = setViewed(from, request(fields), LATER);
  if (Result.isSuccess(result)) throw new Error("expected failure");
  return result.failure;
};

describe("setViewed", () => {
  it("sets and clears exactly the named hunks, deriving each file's state", () => {
    const first = set(session, { hunkIds: ["a2", "a1"] });
    expect(first.result).toEqual({
      sessionId: "session",
      snapshotId: "snapshot",
      revision: 4,
      hunkIds: ["a2", "a1"],
      viewed: true,
    });
    const viewed = first.session!;
    // Stored in hunk order, independent of the request's order.
    expect(viewed.viewedHunkIds).toEqual(["a1", "a2"]);
    expect(viewed.revision).toBe(4);
    expect(viewed.updatedAt).toBe(LATER);
    expect(statusOf(viewed).files).toEqual([
      { path: "a.ts", hunkCount: 2, viewed: true },
      { path: "b.ts", hunkCount: 1, viewed: false },
    ]);
    // Viewed is per hunk, not a group verdict: groups are untouched.
    expect(viewed.groups).toEqual(session.groups);

    const cleared = set(viewed, { requestId: "r2", revision: 4, hunkIds: ["a2"], viewed: false });
    expect(cleared.session!.viewedHunkIds).toEqual(["a1"]);
    expect(statusOf(cleared.session!).files[0]).toEqual({
      path: "a.ts",
      hunkCount: 2,
      viewed: false,
    });
    // Setting an already-set state is still a recorded write.
    const again = set(viewed, { requestId: "r3", revision: 4, hunkIds: ["a1"] });
    expect(again.session!.viewedHunkIds).toEqual(["a1", "a2"]);
    expect(again.result.revision).toBe(5);
  });

  it("replays an identical retry from its receipt, even after the state moved on and a reload", () => {
    const first = set(session);
    const moved = set(first.session!, { requestId: "r2", revision: 4, hunkIds: ["b1"] }).session!;
    const reloaded = Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(moved)));
    // The receipt answers before the stale revision would.
    expect(setViewed(reloaded, request(), LATER)).toEqual(Result.succeed({ result: first.result }));
  });

  it("fails a reused request id with a different payload without writing", () => {
    const viewed = set(session).session!;
    for (const changed of [
      { hunkIds: ["a2"] },
      { viewed: false },
      { revision: 4 },
      { hunkIds: ["a1", "a2"] },
    ])
      expect(failure(viewed, changed)).toMatchObject({
        _tag: "validation_failed",
        message: "request id reused with a different payload",
      });
  });

  it("conflicts on a stale revision or snapshot instead of overwriting", () => {
    for (const stale of [{ revision: 2 }, { revision: 4 }, { snapshotId: "older" }])
      expect(failure(session, stale)).toMatchObject({
        _tag: "stale_revision",
        detail: { snapshotId: "snapshot", revision: 3 },
      });
  });

  it("rejects unknown, duplicate or no hunk ids atomically", () => {
    for (const hunkIds of [["a1", "gone"], ["a1", "a1"], []])
      expect(failure(session, { hunkIds })._tag).toBe("validation_failed");
    expect(failure(session, { hunkIds: ["a1", "gone"] }).detail).toEqual({ unknown: ["gone"] });
    expect(failure(session, { requestId: "" })._tag).toBe("bad_args");
    expect(session.viewedHunkIds).toEqual([]);
    expect(session.viewedReceipts).toEqual([]);
  });

  it("refuses a saved session whose Viewed names no current hunk", () => {
    const decode = Schema.decodeUnknownSync(SessionSchema);
    expect(decode({ ...session, viewedHunkIds: ["a1"] }).viewedHunkIds).toEqual(["a1"]);
    for (const viewedHunkIds of [["gone"], ["a1", "a1"]])
      expect(() => decode({ ...session, viewedHunkIds })).toThrow();
  });
});
