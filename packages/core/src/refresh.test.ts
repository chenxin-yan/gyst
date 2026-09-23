import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import { refreshSession } from "./refresh.ts";
import type { Hunk, Session } from "./session.ts";
import { parseSnapshot } from "./snapshot.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";
const snapshot = (patch: string) => Result.getOrThrow(parseSnapshot(patch));
const hunk = (id: string, file: string, contentHash: string): Hunk => ({
  id,
  file,
  contentHash,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${contentHash}`,
});

function session(): Session {
  return {
    id: "session",
    repoRoot: "/repo",
    source: { kind: "git", args: ["HEAD"], cwd: "/repo", patchHash: "snapshot" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4,
    seq: 7,
    cursor: { itemId: "group-1", pane: "queue" },
    hunks: [
      hunk("old-a", "a.ts", "same"),
      hunk("old-b", "b.ts", "changed"),
      hunk("old-c", "c.ts", "gone"),
      hunk("old-d", "d.ts", "independent"),
    ],
    groups: [
      {
        id: "group-1",
        title: "coherent change",
        overview: "intent and behavior",
        hunkIds: ["old-a"],
        accepted: true,
      },
      { id: "group-b", title: "changed", overview: "stale", hunkIds: ["old-b"], accepted: true },
      { id: "group-c", title: "gone", overview: "gone", hunkIds: ["old-c"], accepted: true },
      { id: "group-d", title: "stable", overview: "keep", hunkIds: ["old-d"], accepted: true },
    ],
    queue: ["group-b", "group-1", "group-c", "group-d"],
    queueSet: true,
    acceptHistory: ["group-1", "group-d"],
    receiptOverviews: [],
    applyReceipts: [],
  };
}

describe("refreshSession", () => {
  it("preserves unchanged groups and verdicts, drops stale groups, and appends new inbox hunks", () => {
    const refreshed = refreshSession(
      session(),
      [
        hunk("fresh-a", "a.ts", "same"),
        hunk("fresh-b", "b.ts", "replacement"),
        hunk("fresh-d", "d.ts", "new"),
        hunk("fresh-independent", "d.ts", "independent"),
        hunk("fresh-cross-file", "e.ts", "same"),
      ],
      LATER,
    );

    expect(refreshed.updatedAt).toBe(LATER);
    expect(refreshed.hunks.map(({ id }) => id)).toEqual([
      "old-a",
      "fresh-b",
      "fresh-d",
      "old-d",
      "fresh-cross-file",
    ]);
    expect(refreshed.groups).toEqual([
      expect.objectContaining({ id: "group-1", hunkIds: ["old-a"], accepted: true }),
      expect.objectContaining({
        id: "group-d",
        overview: "keep",
        hunkIds: ["old-d"],
        accepted: true,
      }),
    ]);
    expect(refreshed.queue).toEqual([
      "group-1",
      "group-d",
      "fresh-b",
      "fresh-d",
      "fresh-cross-file",
    ]);
    expect(refreshed.acceptHistory).toEqual(["group-1", "group-d"]);
    expect(refreshed.queueSet).toBe(false);
    expect(refreshed.revision).toBe(5);
    expect(refreshed.seq).toBe(8);
  });

  it("drops vanished groups and unaccepts a group when any member disappears", () => {
    const original: Session = {
      ...session(),
      groups: [
        {
          id: "group-1",
          title: "coherent change",
          overview: "intent and behavior",
          hunkIds: ["old-a", "old-c"],
          accepted: true,
        },
      ],
      queue: ["group-1", "old-b"],
      acceptHistory: ["group-1"],
    };
    const refreshed = refreshSession(original, [hunk("fresh-a", "a.ts", "same")], LATER);
    expect(refreshed.groups[0]).toEqual(
      expect.objectContaining({
        title: "coherent change",
        overview: "intent and behavior",
        hunkIds: ["old-a"],
        accepted: false,
      }),
    );
    expect(refreshed.acceptHistory).toEqual([]);
    // Losing either member invalidates the verdict, regardless of position.
    expect(
      refreshSession(original, [hunk("fresh-c", "c.ts", "gone")], LATER).groups[0]?.accepted,
    ).toBe(false);

    expect(refreshed.queue).toEqual(["group-1"]);
    expect(refreshed.queueSet).toBe(true);
    expect(statusOf(refreshed).ready).toBe(true);
    expect(
      refreshSession({ ...original, queueSet: false }, [hunk("fresh-a", "a.ts", "same")], LATER)
        .queueSet,
    ).toBe(false);

    const empty = refreshSession(original, [], LATER);
    expect(empty.groups).toEqual([]);
    expect(empty.queue).toEqual([]);
    expect(empty.acceptHistory).toEqual([]);
    expect(empty.cursor).toEqual({ itemId: null, pane: "queue" });

    // The focused member vanished; zoom and pane survive on the first remaining member.
    const focused = refreshSession(
      { ...original, cursor: { itemId: "group-1", pane: "overview", hunkId: "old-c" } },
      [hunk("fresh-a", "a.ts", "same")],
      LATER,
    );
    expect(focused.cursor).toEqual({ itemId: "group-1", pane: "overview", hunkId: "old-a" });
  });

  it("preserves stable duplicate identities only when the whole duplicate set is unchanged", () => {
    const patch =
      "diff --git a/same.ts b/same.ts\n--- a/same.ts\n+++ b/same.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-old\n+new\n";
    const fresh = snapshot(patch);
    const original: Session = {
      ...session(),
      hunks: fresh,
      groups: fresh.map((hunk, index) => ({
        id: `duplicate-${index}`,
        title: `note ${index}`,
        overview: `note ${index}`,
        hunkIds: [hunk.id],
        accepted: index === 0,
      })),
      queue: ["duplicate-0", "duplicate-1"],
      cursor: { itemId: "duplicate-0", pane: "queue" },
      acceptHistory: ["duplicate-0"],
    };
    const unchanged = refreshSession(original, snapshot(patch), LATER);
    expect(unchanged.hunks).toEqual(original.hunks);
    expect(unchanged.groups).toEqual(original.groups);
    expect(unchanged.queue).toEqual(original.queue);
    expect(statusOf(unchanged).ready).toBe(true);

    // A surviving ID alone does not prove which duplicate was removed or relocated.
    for (const changed of [
      fresh.slice(0, 1),
      snapshot(patch.replace("@@ -20 +20 @@", "@@ -30 +30 @@")),
    ]) {
      const refreshed = refreshSession(original, changed, LATER);
      expect(refreshed.groups).toEqual([]);
      expect(refreshed.acceptHistory).toEqual([]);
      expect(statusOf(refreshed).inbox).toHaveLength(changed.length);
      expect(refreshed.queueSet).toBe(false);
    }
  });

  it("does not transfer review state between ambiguous duplicate hunks", () => {
    const original: Session = {
      ...session(),
      cursor: { itemId: null, pane: "queue" },
      hunks: [
        hunk("old-first", "same.ts", "duplicate"),
        hunk("old-second", "same.ts", "duplicate"),
      ],
      groups: [
        {
          id: "group-1",
          title: "duplicate edits",
          overview: "intent and behavior",
          hunkIds: ["old-first", "old-second"],
          accepted: true,
        },
      ],
      queue: ["group-1"],
      acceptHistory: ["group-1"],
    };

    const refreshed = refreshSession(original, [hunk("fresh-only", "same.ts", "duplicate")], LATER);

    expect(refreshed.hunks).toEqual([hunk("fresh-only", "same.ts", "duplicate")]);
    expect(refreshed.groups).toEqual([]);
    expect(refreshed.acceptHistory).toEqual([]);
  });
});
