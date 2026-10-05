import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";
import { refreshSession } from "./refresh.ts";
import type { Hunk, Session } from "./session.ts";
import { parseSnapshot } from "./snapshot.ts";

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
    scope: { kind: "uncommitted" },
    snapshotId: "snapshot",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4,
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
        notes: [{ hunkId: "old-a", text: "intent and behavior" }],
        hunkIds: ["old-a"],
      },
      { id: "group-b", title: "changed", notes: [], hunkIds: ["old-b"] },
      { id: "group-c", title: "gone", notes: [], hunkIds: ["old-c"] },
      {
        id: "group-d",
        title: "stable",
        notes: [{ hunkId: "old-d", text: "keep" }],
        hunkIds: ["old-d"],
      },
    ],
    viewedHunkIds: ["old-a", "old-b", "old-c", "old-d"],
    receiptNoteTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
  };
}

describe("refreshSession", () => {
  it("keeps groups and Viewed only for exactly matched hunks; new hunks start ungrouped and unviewed", () => {
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
      expect.objectContaining({ id: "group-1", hunkIds: ["old-a"] }),
      expect.objectContaining({
        id: "group-d",
        notes: [{ hunkId: "old-d", text: "keep" }],
        hunkIds: ["old-d"],
      }),
    ]);
    // A changed body, a vanished hunk and a same body in another file keep no progress.
    expect(refreshed.viewedHunkIds).toEqual(["old-a", "old-d"]);
    expect(refreshed.revision).toBe(5);
  });

  it("clears a group's notes when any member disappears, keeping survivors' own Viewed", () => {
    const original: Session = {
      ...session(),
      groups: [
        {
          id: "group-1",
          title: "coherent change",
          notes: [{ hunkId: "old-a", text: "intent and behavior" }],
          hunkIds: ["old-a", "old-c"],
        },
      ],
    };
    const refreshed = refreshSession(original, [hunk("fresh-a", "a.ts", "same")], LATER);
    expect(refreshed.groups).toEqual([
      { id: "group-1", title: "coherent change", notes: [], hunkIds: ["old-a"] },
    ]);
    expect(refreshed.viewedHunkIds).toEqual(["old-a"]);

    const empty = refreshSession(original, [], LATER);
    expect(empty.groups).toEqual([]);
    expect(empty.viewedHunkIds).toEqual([]);
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
        notes: [{ hunkId: hunk.id, text: `note ${index}` }],
        hunkIds: [hunk.id],
      })),
      viewedHunkIds: [fresh[0]!.id],
    };
    const unchanged = refreshSession(original, snapshot(patch), LATER);
    expect(unchanged.hunks).toEqual(original.hunks);
    expect(unchanged.groups).toEqual(original.groups);
    expect(unchanged.viewedHunkIds).toEqual([fresh[0]!.id]);

    // A surviving ID alone does not prove which duplicate was removed or relocated.
    for (const changed of [
      fresh.slice(0, 1),
      snapshot(patch.replace("@@ -20 +20 @@", "@@ -30 +30 @@")),
    ]) {
      const refreshed = refreshSession(original, changed, LATER);
      expect(refreshed.groups).toEqual([]);
      expect(refreshed.viewedHunkIds).toEqual([]);
    }
  });

  it("does not transfer review state between ambiguous duplicate hunks", () => {
    const original: Session = {
      ...session(),
      hunks: [
        hunk("old-first", "same.ts", "duplicate"),
        hunk("old-second", "same.ts", "duplicate"),
      ],
      groups: [
        {
          id: "group-1",
          title: "duplicate edits",
          notes: [],
          hunkIds: ["old-first", "old-second"],
        },
      ],
      viewedHunkIds: ["old-first", "old-second"],
    };

    const refreshed = refreshSession(original, [hunk("fresh-only", "same.ts", "duplicate")], LATER);

    expect(refreshed.hunks).toEqual([hunk("fresh-only", "same.ts", "duplicate")]);
    expect(refreshed.groups).toEqual([]);
    expect(refreshed.viewedHunkIds).toEqual([]);
  });
});
