import { describe, expect, it } from "bun:test";
import type { Hunk, Session } from "../src/index.ts";
import { refreshSession } from "../src/index.ts";

const hunk = (id: string, file: string, contentHash: string, tldr?: string, accepted = false): Hunk => ({
  id, file, contentHash, header: "@@ -1 +1 @@", patch: `@@ -1 +1 @@\n-${id}\n+${contentHash}`,
  ...(tldr === undefined ? {} : { tldr }), accepted,
});

function session(): Session {
  return {
    id: "session", repoRoot: "/repo", source: { kind: "git", args: ["HEAD"] },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4, seq: 7, cursor: { itemId: "group-1", expanded: false },
    hunks: [
      hunk("old-a", "a.ts", "same", "member note", true),
      hunk("old-b", "b.ts", "changed", "stale note", true),
      hunk("old-c", "c.ts", "gone", "gone note", true),
      hunk("old-d", "d.ts", "spotlight", "keep note", true),
    ],
    groups: [{ id: "group-1", tldr: "mechanical", exemplarHunkId: "old-a", hunkIds: ["old-a"], accepted: true }],
    queue: ["old-b", "group-1", "old-c", "old-d"], queueSet: true, applyReceipts: [],
  };
}

describe("refreshSession", () => {
  it("preserves unchanged identity and verdicts, drops stale annotations, and appends new inbox hunks", () => {
    const refreshed = refreshSession(session(), [
      hunk("fresh-a", "a.ts", "same"),
      hunk("fresh-b", "b.ts", "replacement"),
      hunk("fresh-d", "d.ts", "new"),
      hunk("fresh-spotlight", "d.ts", "spotlight"),
      hunk("fresh-cross-file", "e.ts", "same"),
    ]);

    expect(refreshed.hunks).toEqual([
      expect.objectContaining({ id: "old-a", tldr: "member note", accepted: true }),
      expect.objectContaining({ id: "fresh-b", tldr: undefined, accepted: false }),
      expect.objectContaining({ id: "fresh-d", tldr: undefined, accepted: false }),
      expect.objectContaining({ id: "old-d", tldr: "keep note", accepted: true }),
      expect.objectContaining({ id: "fresh-cross-file", tldr: undefined, accepted: false }),
    ]);
    expect(refreshed.groups).toEqual([
      expect.objectContaining({ id: "group-1", hunkIds: ["old-a"], accepted: true }),
    ]);
    expect(refreshed.queue).toEqual(["group-1", "old-d", "fresh-b", "fresh-d", "fresh-cross-file"]);
    expect(refreshed.queueSet).toBe(false);
    expect(refreshed.revision).toBe(5);
    expect(refreshed.seq).toBe(8);
  });

  it("drops vanished groups and picks a surviving exemplar", () => {
    const original: Session = {
      ...session(),
      groups: [{ id: "group-1", tldr: "mechanical", exemplarHunkId: "old-c", hunkIds: ["old-a", "old-c"], accepted: true }],
      queue: ["group-1", "old-b"],
    };
    const refreshed = refreshSession(original, [hunk("fresh-a", "a.ts", "same")]);
    expect(refreshed.groups[0]).toEqual(expect.objectContaining({ exemplarHunkId: "old-a", hunkIds: ["old-a"], accepted: true }));

    const empty = refreshSession(original, []);
    expect(empty.groups).toEqual([]);
    expect(empty.queue).toEqual([]);
    expect(empty.cursor).toEqual({ itemId: null, expanded: false });
  });

  it("does not transfer review state between ambiguous duplicate hunks", () => {
    const original: Session = {
      ...session(),
      cursor: { itemId: null, expanded: false },
      hunks: [
        hunk("old-first", "same.ts", "duplicate", "first note", true),
        hunk("old-second", "same.ts", "duplicate", "second note", true),
      ],
      groups: [{
        id: "group-1", tldr: "duplicate edits", exemplarHunkId: "old-first",
        hunkIds: ["old-first", "old-second"], accepted: true,
      }],
      queue: ["group-1"],
    };

    const refreshed = refreshSession(original, [hunk("fresh-only", "same.ts", "duplicate")]);

    expect(refreshed.hunks).toEqual([
      expect.objectContaining({ id: "fresh-only", tldr: undefined, accepted: false }),
    ]);
    expect(refreshed.groups).toEqual([]);
  });
});
