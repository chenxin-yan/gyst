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

const overview = (markdown: string) => ({ markdown, references: [] });
const note = (id: string, path: string, line = 1) => ({
  id,
  anchor: { snapshotId: "snapshot", path, side: "new" as const, startLine: line, endLine: line },
  ...overview(`About ${id}.`),
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
    overview: overview("The walkthrough."),
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
        overview: overview("Intent and behavior."),
        hunkIds: ["old-a"],
        files: ["a.ts"],
        notes: [note("note-a", "a.ts")],
      },
      {
        id: "group-b",
        title: "changed",
        overview: null,
        hunkIds: ["old-b"],
        files: ["b.ts"],
        notes: [],
      },
      {
        id: "group-c",
        title: "gone",
        overview: null,
        hunkIds: ["old-c"],
        files: ["c.ts"],
        notes: [],
      },
      {
        id: "group-d",
        title: "stable",
        overview: overview("Keep."),
        hunkIds: ["old-d"],
        files: ["d.ts"],
        notes: [note("note-d", "d.ts")],
      },
    ],
    viewedHunkIds: ["old-a", "old-b", "old-c", "old-d"],
    receiptTexts: [],
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
    expect(refreshed.groups).toEqual([session().groups[0], session().groups[3]]);
    // A changed body, a vanished hunk and a same body in another file keep no progress.
    expect(refreshed.viewedHunkIds).toEqual(["old-a", "old-d"]);
    expect(refreshed.revision).toBe(5);
  });

  it("keeps overviews and surviving file order, and notes only on their own snapshot", () => {
    const original: Session = {
      ...session(),
      groups: [
        {
          id: "group-1",
          title: "coherent change",
          overview: overview("Intent and behavior."),
          hunkIds: ["old-c", "old-a", "old-d"],
          files: ["d.ts", "c.ts", "a.ts"],
          notes: [note("note-a", "a.ts"), note("note-d", "d.ts")],
        },
      ],
    };
    const fresh = [hunk("fresh-a", "a.ts", "same"), hunk("fresh-d", "d.ts", "independent")];
    const same = refreshSession(original, fresh, LATER);
    expect(same.groups).toEqual([
      { ...original.groups[0], hunkIds: ["old-a", "old-d"], files: ["d.ts", "a.ts"] },
    ]);
    // Until #91 reconciles guidance, a new snapshot drops notes anchored to the old one.
    const next = refreshSession({ ...original, snapshotId: "next" }, fresh, LATER);
    expect(next.overview).toEqual(original.overview);
    expect(next.groups).toEqual([{ ...same.groups[0], notes: [] }]);
    expect(next.viewedHunkIds).toEqual(["old-a", "old-d"]);

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
        overview: overview(`group ${index}`),
        hunkIds: [hunk.id],
        files: ["same.ts"],
        notes: [note(`note-${index}`, "same.ts", index === 0 ? 1 : 20)],
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
          overview: null,
          hunkIds: ["old-first", "old-second"],
          files: ["same.ts"],
          notes: [],
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
