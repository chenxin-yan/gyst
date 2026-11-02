import type { CapturedRange, Draft, HumanMessage, ThreadEntry } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import {
  commentDraftOn,
  commentsOrder,
  draftChange,
  draftPlace,
  draftText,
  forgetDraftText,
  keepDraftText,
  replyOutdated,
  threadLocation,
  threadPlaces,
} from "./conversation.ts";
import type { NotePlace, StatusNote } from "./walkthrough.ts";

const range = (path: string, startLine: number, endLine = startLine, snapshotId = "s2") =>
  ({ snapshotId, path, side: "new", startLine, endLine }) satisfies CapturedRange;
const asked = (id: string, extra: Partial<HumanMessage> = {}): HumanMessage => ({
  id,
  author: "human",
  kind: "question",
  pending: true,
  markdown: `Why ${id}?`,
  references: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const thread = (
  id: string,
  anchor: CapturedRange,
  extra: Partial<ThreadEntry> = {},
): ThreadEntry => ({
  id,
  anchor,
  resolved: false,
  version: `${id}-v`,
  messageCount: 1,
  pendingCount: 1,
  ...extra,
});
const note: StatusNote = { id: "n1", anchor: range("a.ts", 4), markdown: "Now.", references: [] };
const notes = new Map([[note.id, note]]);
const placed: NotePlace = { note, file: "a.ts", fileIndex: 0, side: "additions", line: 4 };

describe("threadPlaces", () => {
  it("shows open threads at their code or under their note, in code order, never resolved ones", () => {
    const threads = [
      thread("b", range("b.ts", 1)),
      thread("late", range("a.ts", 9, 12)),
      thread("note", range("a.ts", 4), { note: { id: "n1", removed: false } }),
      thread("resolved", range("a.ts", 2), { resolved: true }),
      // A removed note's thread stays on the code it was about.
      thread("orphan", range("a.ts", 6), { note: { id: "n1", removed: true } }),
      // Earlier code and unshown files are left to Comments.
      thread("earlier", range("a.ts", 3, 3, "s1")),
      thread("unshown", range("c.ts", 3)),
    ];
    const places = threadPlaces(threads, ["a.ts", "b.ts"], "s2", [placed], notes);
    expect(places.map(({ thread: { id }, note: on, line }) => [id, on, line])).toEqual([
      ["note", "n1", 4],
      ["orphan", undefined, 6],
      ["late", undefined, 12],
      ["b", undefined, 1],
    ]);
    // An expanded earlier file shows its own snapshot's threads.
    expect(
      threadPlaces(threads, ["a.ts"], "s1", [], notes).map(({ thread: { id } }) => id),
    ).toEqual(["earlier"]);
  });

  it("places only a new comment's composer itself; a reply's sits in its thread or note", () => {
    const comment: Draft = { id: "d", snapshotId: "s2", anchor: range("a.ts", 2, 3) };
    expect(draftPlace(comment, ["a.ts"], "s2")).toEqual({
      file: "a.ts",
      side: "additions",
      line: 3,
    });
    expect(draftPlace({ ...comment, thread: "t" }, ["a.ts"], "s2")).toBeUndefined();
    expect(draftPlace(comment, ["a.ts"], "s3")).toBeUndefined();
  });

  it("resumes a comment draft only on the same snapshot's lines, so a refresh's earlier one stays apart", () => {
    const earlier: Draft = { id: "earlier", snapshotId: "s1", anchor: range("a.ts", 2, 3, "s1") };
    const reply: Draft = {
      id: "reply",
      snapshotId: "s2",
      anchor: range("a.ts", 2, 3),
      thread: "t",
    };
    expect(commentDraftOn([earlier, reply], range("a.ts", 2, 3))).toBeUndefined();
    expect(commentDraftOn([earlier, reply], range("a.ts", 2, 3, "s1"))).toBe(earlier);
    const current: Draft = { ...earlier, id: "current", anchor: range("a.ts", 2, 3) };
    expect(commentDraftOn([earlier, current], range("a.ts", 2, 3))).toBe(current);
  });
});

describe("replies against a note's wording", () => {
  const onNote = thread("t", range("a.ts", 4), { note: { id: "n1", removed: false } });
  const wording = (markdown: string) => ({ markdown, references: [], anchor: range("a.ts", 4) });

  it("marks a reply Outdated when the note's wording changed or the note went, Pending or not", () => {
    const current = asked("m1", { wording: wording("Now.") });
    const earlier = asked("m2", { wording: wording("Before.") });
    expect(replyOutdated(current, onNote, notes)).toBe(false);
    expect(replyOutdated(earlier, onNote, notes)).toBe(true);
    expect(replyOutdated(current, { note: { id: "n1", removed: true } }, notes)).toBe(true);
    expect(replyOutdated(current, onNote, new Map())).toBe(true);
    // Code comments and agent replies carry no wording.
    expect(replyOutdated(asked("m3"), onNote, notes)).toBe(false);
  });

  it("flags what changed under a draft without rebinding it", () => {
    const reply: Draft = {
      id: "d",
      snapshotId: "s2",
      anchor: range("a.ts", 4),
      note: { id: "n1", removed: false },
      wording: wording("Now."),
    };
    expect(draftChange(reply, [], notes, "s2")).toBeUndefined();
    expect(draftChange({ ...reply, wording: wording("Before.") }, [], notes, "s2")).toEqual({
      message:
        "The note changed since you began. Your reply keeps the wording you began it against.",
      blocks: false,
    });
    expect(
      draftChange({ ...reply, note: { id: "n1", removed: true } }, [], notes, "s2")?.blocks,
    ).toBe(false);
    // The agent re-anchored the note to the old side of the same lines, its wording unchanged: the
    // draft followed it, and says it keeps the code it was begun on.
    const switched = { ...note, anchor: { ...note.anchor, side: "old" as const } };
    const followed = { ...reply, anchor: switched.anchor };
    expect(draftChange(followed, [], new Map([[note.id, switched]]), "s2")).toEqual({
      message:
        "The note moved to other code since you began. Your reply keeps the code you began it against, a.ts:L4 · new.",
      blocks: false,
    });
    expect(
      draftChange(
        { ...followed, wording: wording("Before.") },
        [],
        new Map([[note.id, { ...switched, markdown: "Now." }]]),
        "s2",
      )?.message,
    ).toBe(
      "The note changed and moved to other code since you began. Your reply keeps the wording and code you began it against, a.ts:L4 · new.",
    );
    const resolved = thread("t", range("a.ts", 4), { resolved: true });
    expect(draftChange({ ...reply, thread: "t" }, [resolved], notes, "s2")?.blocks).toBe(true);
    const comment: Draft = { id: "c", snapshotId: "s1", anchor: range("a.ts", 2, 2, "s1") };
    expect(draftChange(comment, [], notes, "s2")?.message).toMatch(/stays on the code/);
    expect(
      draftChange(
        { id: "r", snapshotId: "s2", anchor: range("a.ts", 2), thread: "gone" },
        [],
        notes,
        "s2",
      ),
    ).toEqual({
      message: "This thread no longer exists, so the reply can't be sent.",
      blocks: true,
    });
  });
});

describe("the Comments list", () => {
  it("lists open threads before resolved ones, each in the order they began", () => {
    const threads = [
      thread("a", range("a.ts", 1), { resolved: true }),
      thread("b", range("a.ts", 2)),
      thread("c", range("a.ts", 3)),
    ];
    expect(commentsOrder(threads).map(({ id }) => id)).toEqual(["b", "c", "a"]);
    expect(threadLocation(range("a.ts", 2, 5), "s2")).toBe("a.ts:L2–5 · new");
    expect(threadLocation(range("a.ts", 2, 2, "s1"), "s2")).toBe("a.ts:L2 · new · earlier code");
  });
});

describe("draft texts", () => {
  it("keeps each session's draft text until it is sent or discarded", () => {
    expect(draftText("s", "d")).toEqual({ markdown: "", kind: "question" });
    keepDraftText("s", "d", { markdown: "Half a thought", kind: "change" });
    expect(draftText("s", "d")).toEqual({ markdown: "Half a thought", kind: "change" });
    expect(draftText("other", "d").markdown).toBe("");
    forgetDraftText("s", "d");
    expect(draftText("s", "d").markdown).toBe("");
  });
});
