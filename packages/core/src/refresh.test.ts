import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import { refreshSession } from "./refresh.ts";
import type { Hunk, Session } from "./session.ts";
import { parseSnapshot } from "./snapshot.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";

const snapshot = (patch: string) => Result.getOrThrow(parseSnapshot(patch));

const hunk = (
  id: string,
  file: string,
  contentHash: string,
  title?: string,
  accepted = false,
): Hunk => ({
  id,
  file,
  contentHash,
  header: "@@ -1 +1 @@",
  patch: `@@ -1 +1 @@\n-${id}\n+${contentHash}`,
  ...(title === undefined ? {} : { title, overview: title }),
  accepted,
});

function session(): Session {
  return {
    id: "session",
    repoRoot: "/repo",
    source: { kind: "git", args: ["HEAD"], cwd: "/repo" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4,
    seq: 7,
    cursor: { itemId: "group-1", pane: "queue" },
    hunks: [
      hunk("old-a", "a.ts", "same", "member note", true),
      hunk("old-b", "b.ts", "changed", "stale note", true),
      hunk("old-c", "c.ts", "gone", "gone note", true),
      hunk("old-d", "d.ts", "spotlight", "keep note", true),
    ],
    groups: [
      {
        id: "group-1",
        title: "coherent change",
        overview: "intent and behavior",
        hunkIds: ["old-a"],
        accepted: true,
      },
    ],
    queue: ["old-b", "group-1", "old-c", "old-d"],
    queueSet: true,
    acceptHistory: ["group-1"],
    receiptOverviews: [],
    applyReceipts: [],
  };
}

describe("refreshSession", () => {
  it("preserves unchanged identity and verdicts, drops stale annotations, and appends new inbox hunks", () => {
    const refreshed = refreshSession(
      session(),
      [
        hunk("fresh-a", "a.ts", "same"),
        hunk("fresh-b", "b.ts", "replacement"),
        hunk("fresh-d", "d.ts", "new"),
        hunk("fresh-spotlight", "d.ts", "spotlight"),
        hunk("fresh-cross-file", "e.ts", "same"),
      ],
      LATER,
    );

    expect(refreshed.updatedAt).toBe(LATER);
    expect(refreshed.hunks).toEqual([
      // A grouped hunk is hidden behind its group, so it carries no verdict of its own.
      expect.objectContaining({
        id: "old-a",
        title: "member note",
        overview: "member note",
        accepted: false,
      }),
      expect.objectContaining({
        id: "fresh-b",
        title: undefined,
        overview: undefined,
        accepted: false,
      }),
      expect.objectContaining({
        id: "fresh-d",
        title: undefined,
        overview: undefined,
        accepted: false,
      }),
      expect.objectContaining({
        id: "old-d",
        title: "keep note",
        overview: "keep note",
        accepted: true,
      }),
      expect.objectContaining({
        id: "fresh-cross-file",
        title: undefined,
        overview: undefined,
        accepted: false,
      }),
    ]);
    expect(refreshed.groups).toEqual([
      expect.objectContaining({ id: "group-1", hunkIds: ["old-a"], accepted: true }),
    ]);
    expect(refreshed.queue).toEqual(["group-1", "old-d", "fresh-b", "fresh-d", "fresh-cross-file"]);
    expect(refreshed.acceptHistory).toEqual(["group-1"]);
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
      hunks: fresh.map((hunk, index) => ({
        ...hunk,
        title: `note ${index}`,
        overview: `note ${index}`,
        accepted: index === 0,
      })),
      groups: [],
      queue: fresh.map(({ id }) => id),
      cursor: { itemId: fresh[0]!.id, pane: "queue" },
    };
    const unchanged = refreshSession(original, snapshot(patch), LATER);
    expect(unchanged.hunks).toEqual(original.hunks);
    expect(unchanged.queue).toEqual(original.queue);
    expect(statusOf(unchanged).ready).toBe(true);

    // A surviving ID alone does not prove which duplicate was removed or relocated.
    for (const changed of [
      fresh.slice(0, 1),
      snapshot(patch.replace("@@ -20 +20 @@", "@@ -30 +30 @@")),
    ]) {
      const refreshed = refreshSession(original, changed, LATER);
      expect(
        refreshed.hunks.every(
          (hunk) => !hunk.accepted && hunk.title === undefined && hunk.overview === undefined,
        ),
      ).toBe(true);
      expect(refreshed.queueSet).toBe(false);
    }
  });

  it("does not transfer review state between ambiguous duplicate hunks", () => {
    const original: Session = {
      ...session(),
      cursor: { itemId: null, pane: "queue" },
      hunks: [
        hunk("old-first", "same.ts", "duplicate", "first note", true),
        hunk("old-second", "same.ts", "duplicate", "second note", true),
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
    };

    const refreshed = refreshSession(original, [hunk("fresh-only", "same.ts", "duplicate")], LATER);

    expect(refreshed.hunks).toEqual([
      expect.objectContaining({
        id: "fresh-only",
        title: undefined,
        overview: undefined,
        accepted: false,
      }),
    ]);
    expect(refreshed.groups).toEqual([]);
  });
});
