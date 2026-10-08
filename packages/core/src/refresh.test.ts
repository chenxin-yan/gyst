import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";
import type { ManifestFile } from "./content.ts";
import { setViewed } from "./human-action.ts";
import type { CapturedRange, Note } from "./guidance.ts";
import type { SnapshotLines } from "./mapping.ts";
import { type FreshSnapshot, refresh, refreshSession, type RefreshRequest } from "./refresh.ts";
import type { Group, Session } from "./session.ts";
import { parseSnapshot } from "./snapshot.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";

const blob = (name: string) => ({ kind: "text" as const, blob: name, size: 1 });
/** A snapshot of `files` (each side named by its blob) whose hunks are `diffs`, by path. */
function lines(
  files: Record<string, readonly [string, string]>,
  diffs: Record<string, string>,
): SnapshotLines {
  const patch = Object.entries(diffs)
    .map(
      ([path, body]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`,
    )
    .join("");
  return {
    files: Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, [old, current]]): ManifestFile => ({
        path,
        old: blob(old),
        new: blob(current),
      })),
    hunks: Result.getOrThrow(parseSnapshot(patch)),
  };
}

// a.ts changes line 10 and b.ts line 5; helper.ts is unchanged supporting code both reference.
const changeA = "@@ -9,3 +9,3 @@\n l9\n-l10\n+L10\n l11";
const changeB = "@@ -4,3 +4,3 @@\n m4\n-m5\n+M5\n m6";
const files = { "a.ts": ["a0", "a1"], "b.ts": ["b0", "b1"], "helper.ts": ["h0", "h0"] } as const;
const first = lines(files, { "a.ts": changeA, "b.ts": changeB });
const [hunkA, hunkB] = first.hunks.map(({ id }) => id) as [string, string];

const pin = (path: string, side: "old" | "new", startLine: number, endLine = startLine) =>
  ({ snapshotId: "s1", path, side, startLine, endLine }) satisfies CapturedRange;
const helperLink = "[the helper](gyst:new/helper.ts#L2-L3)";
const helper = pin("helper.ts", "new", 2, 3);
const note = (id: string, anchor: CapturedRange, references: CapturedRange[] = []): Note => ({
  id,
  anchor,
  markdown: `About ${id}${references.length ? `, after ${helperLink}` : ""}.`,
  references,
});
const group = (id: string, hunkIds: string[], file: string, notes: Note[]): Group => ({
  id,
  title: id,
  overview: { markdown: `Group ${id}.`, references: [] },
  hunkIds,
  files: [file],
  notes,
});

function session(): Session {
  return {
    id: "session",
    repoRoot: "/repo",
    scope: { kind: "uncommitted" },
    snapshotId: "s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4,
    hunks: first.hunks,
    overview: { markdown: "The walkthrough.", references: [] },
    groups: [
      group("ga", [hunkA], "a.ts", [note("na", pin("a.ts", "new", 10), [helper])]),
      group("gb", [hunkB], "b.ts", [note("nb", pin("b.ts", "new", 5))]),
    ],
    viewedHunkIds: [hunkA, hunkB],
    receiptTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
    refreshReceipts: [],
  };
}
const retained = new Map([["s1", first]]);
const to = (snapshot: SnapshotLines, snapshotId = "s2"): FreshSnapshot => ({
  snapshotId,
  snapshot,
});

describe("refreshSession", () => {
  it("keeps hunk identity, Viewed, membership and notes through header and line shifts", () => {
    // Two lines inserted after a.ts line 1 move the change from line 10 to 12.
    const shifted = lines(
      { ...files, "a.ts": ["a0", "a2"] },
      { "a.ts": `@@ -1,0 +2,2 @@\n+i1\n+i2\n${changeA.replace("+9,3", "+11,3")}`, "b.ts": changeB },
    );
    const refreshed = refreshSession(session(), to(shifted), retained, LATER);
    const inserted = shifted.hunks[0]!.id;
    expect(refreshed.hunks.map(({ id }) => id)).toEqual([inserted, hunkA, hunkB]);
    expect(refreshed.hunks[1]!.header).toBe("@@ -9,3 +11,3 @@");
    expect(refreshed.viewedHunkIds).toEqual([hunkA, hunkB]);
    expect(refreshed.groups[0]).toEqual({
      ...session().groups[0],
      notes: [
        {
          ...session().groups[0]!.notes[0],
          anchor: { ...pin("a.ts", "new", 12), snapshotId: "s2" },
        },
      ],
    });
    // The new hunk is ungrouped; only the walkthrough, which covers every change, is Outdated.
    expect(refreshed.overview?.outdated).toEqual(["code"]);
    expect(refreshed.groups[1]!.overview?.outdated).toBeUndefined();
    expect(refreshed).toMatchObject({ snapshotId: "s2", revision: 5, updatedAt: LATER });
  });

  it("keeps an emptied group and its note Outdated, with the note on its old captured code", () => {
    // The base changed line 9, so A's context differs: no counterpart, no progress or membership.
    const changed = lines(
      { ...files, "a.ts": ["a3", "a4"] },
      { "a.ts": "@@ -9,3 +9,3 @@\n k9\n-l10\n+L10\n l11", "b.ts": changeB },
    );
    const refreshed = refreshSession(session(), to(changed), retained, LATER);
    const fresh = changed.hunks[0]!.id;
    expect(refreshed.hunks.map(({ id }) => id)).toEqual([fresh, hunkB]);
    expect(refreshed.viewedHunkIds).toEqual([hunkB]);
    expect(refreshed.groups[0]).toEqual({
      ...session().groups[0],
      hunkIds: [],
      files: [],
      overview: { ...session().groups[0]!.overview!, outdated: ["code"] },
      notes: [{ ...session().groups[0]!.notes[0], outdated: ["code"] }],
    });
    expect(refreshed.groups[1]).toEqual({
      ...session().groups[1],
      notes: [
        {
          ...session().groups[1]!.notes[0],
          anchor: { ...pin("b.ts", "new", 5), snapshotId: "s2" },
        },
      ],
    });
    // Nothing is complete by having no hunks left: the emptied group keeps preparation incomplete.
    expect(statusOf(refreshed).preparation).toMatchObject({
      state: "incomplete",
      overviewOutdated: true,
      groupsOutdated: ["ga"],
      notesOutdated: ["na"],
    });
  });

  it("inherits nothing through a split, a merge or a body moved to another file", () => {
    const split = lines(
      { ...files, "a.ts": ["a0", "a5"], "c.ts": ["c0", "c1"] },
      {
        "a.ts": "@@ -9,2 +9,2 @@\n l9\n-l10\n+L10\n@@ -20 +20 @@\n-l20\n+L20",
        "c.ts": changeB,
      },
    );
    const refreshed = refreshSession(session(), to(split), retained, LATER);
    expect(refreshed.hunks.map(({ id }) => id)).toEqual(split.hunks.map(({ id }) => id));
    expect(refreshed.viewedHunkIds).toEqual([]);
    expect(refreshed.groups.map(({ hunkIds }) => hunkIds)).toEqual([[], []]);
    const merged = refreshSession(
      { ...refreshSession(session(), to(split), retained, LATER), viewedHunkIds: [] },
      to(lines(files, { "a.ts": "@@ -9,3 +9,3 @@\n l9\n-l10\n+L10\n-l20\n+L20" }), "s3"),
      new Map([...retained, ["s2", split]]),
      LATER,
    );
    expect(merged.groups.map(({ hunkIds }) => hunkIds)).toEqual([[], []]);
  });

  it("does not transfer review state between ambiguous duplicate hunks", () => {
    const twice = lines(files, { "a.ts": "@@ -1 +1 @@\n-x\n+y\n@@ -5 +5 @@\n-x\n+y" });
    const [one, two] = twice.hunks.map(({ id }) => id) as [string, string];
    const original: Session = {
      ...session(),
      hunks: twice.hunks,
      groups: [group("dup", [one, two], "a.ts", [])],
      viewedHunkIds: [one, two],
    };
    const fromTwice = new Map([["s1", twice]]);
    const unchanged = refreshSession(original, to(twice), fromTwice, LATER);
    expect(unchanged.viewedHunkIds).toEqual([one, two]);
    expect(unchanged.groups[0]!.hunkIds).toEqual([one, two]);
    // A surviving ID alone does not prove which duplicate was removed or relocated.
    for (const changed of [
      lines(files, { "a.ts": "@@ -1 +1 @@\n-x\n+y" }),
      lines(files, { "a.ts": "@@ -1 +1 @@\n-x\n+y\n@@ -7 +7 @@\n-x\n+y" }),
    ]) {
      const refreshed = refreshSession(original, to(changed), fromTwice, LATER);
      expect(refreshed.viewedHunkIds).toEqual([]);
      expect(refreshed.groups[0]!.hunkIds).toEqual([]);
    }
  });

  it("marks guidance whose referenced helper changed, unviewing only the referencing note's code", () => {
    const original: Session = {
      ...session(),
      groups: session().groups.map((each) =>
        each.id === "gb"
          ? { ...each, overview: { markdown: `See ${helperLink}.`, references: [helper] } }
          : each,
      ),
    };
    // The helper changed on both sides, so the diff's patches are identical.
    const helperOnly = lines(
      { ...files, "helper.ts": ["h1", "h1"] },
      { "a.ts": changeA, "b.ts": changeB },
    );
    const refreshed = refreshSession(original, to(helperOnly), retained, LATER);
    expect(refreshed.hunks).toEqual(original.hunks);
    // Note na's anchored hunk A is unviewed; group gb's Outdated overview leaves B as it was.
    expect(refreshed.viewedHunkIds).toEqual([hunkB]);
    const [ga, gb] = refreshed.groups as Group[] as [Group, Group];
    expect(ga.notes[0]).toMatchObject({ outdated: ["references"], references: [helper] });
    expect(ga.notes[0]!.anchor.snapshotId).toBe("s2");
    expect(gb.overview).toEqual({ ...original.groups[1]!.overview, outdated: ["references"] });
    expect(ga.overview?.outdated).toBeUndefined();
    expect(refreshed.overview?.outdated).toBeUndefined();
    // The human can still mark the current code Viewed while its guidance stays Outdated.
    const read = Result.getOrThrow(
      setViewed(
        refreshed,
        {
          command: "viewed",
          session: "session",
          snapshotId: "s2",
          revision: refreshed.revision,
          requestId: "read-a",
          hunkIds: [hunkA],
          viewed: true,
        },
        LATER,
      ),
    ).session!;
    expect(read.viewedHunkIds).toEqual([hunkA, hunkB]);
    expect(read.groups[0]!.notes[0]!.outdated).toEqual(["references"]);
    // An Outdated reference already unviewed its note once; the next refresh does not again.
    const viewedAgain = { ...refreshed, viewedHunkIds: [hunkA, hunkB] };
    const next = refreshSession(
      viewedAgain,
      to({ ...helperOnly, files: helperOnly.files.map((file) => ({ ...file })) }, "s3"),
      new Map([...retained, ["s2", helperOnly]]),
      LATER,
    );
    expect(next.viewedHunkIds).toEqual([hunkA, hunkB]);
    // Once it changes again, the reader's last look at it is stale too.
    const again = refreshSession(
      next,
      to(
        lines({ ...files, "helper.ts": ["h4", "h4"] }, { "a.ts": changeA, "b.ts": changeB }),
        "s4",
      ),
      new Map([...retained, ["s3", helperOnly]]),
      LATER,
    );
    expect(again.viewedHunkIds).toEqual([hunkB]);
  });

  it("unviews a changed reference's note when what it reads changes again, even back to its pin", () => {
    const helperAt = (snapshotId: string, current: string, body?: string) =>
      [
        snapshotId,
        lines(
          { ...files, "helper.ts": ["h0", current] },
          { "a.ts": changeA, "b.ts": changeB, ...(body && { "helper.ts": body }) },
        ),
      ] as const;
    const [, edited] = helperAt("s2", "h1", "@@ -2 +2 @@\n-x2\n+y2");
    let state = refreshSession(session(), to(edited), retained, LATER);
    expect(state.groups[0]!.notes[0]!.outdated).toEqual(["references"]);
    expect(state.viewedHunkIds).toEqual([hunkB]);
    const lineage = new Map([...retained, ["s2", edited]]);
    for (const [snapshotId, snapshot, viewed] of [
      // The helper changed only far below the referenced lines: the reader's look still holds.
      [...helperAt("s3", "h2", "@@ -2 +2 @@\n-x2\n+y2\n@@ -30,0 +31 @@\n+bottom"), [hunkA, hunkB]],
      // The helper is back to the pinned bytes, which the reader has not seen beside A.
      [...helperAt("s4", "h0"), [hunkB]],
    ] as const) {
      const read = { ...state, viewedHunkIds: [hunkA, hunkB] };
      state = refreshSession(read, to(snapshot, snapshotId), lineage, LATER);
      expect(state.viewedHunkIds).toEqual(viewed);
      expect(state.groups[0]!.notes[0]).toMatchObject({
        outdated: ["references"],
        references: [helper],
      });
      lineage.set(snapshotId, snapshot);
    }
  });

  it("keeps guidance current when its referenced lines only moved or changed elsewhere", () => {
    // The helper gains a working-tree line above the referenced range, and one far below it.
    const edited = lines(
      { ...files, "helper.ts": ["h0", "h2"] },
      {
        "a.ts": changeA,
        "b.ts": changeB,
        "helper.ts": "@@ -1,0 +2 @@\n+top\n@@ -30,0 +32 @@\n+bottom",
      },
    );
    const refreshed = refreshSession(session(), to(edited), retained, LATER);
    expect(refreshed.groups[0]!.notes[0]!.outdated).toBeUndefined();
    expect(refreshed.groups[0]!.notes[0]!.references).toEqual([helper]);
    expect(refreshed.viewedHunkIds).toEqual([hunkA, hunkB]);
    // An inserted line inside the range changes it.
    const inside = lines(
      { ...files, "helper.ts": ["h0", "h3"] },
      { "a.ts": changeA, "b.ts": changeB, "helper.ts": "@@ -2,0 +3 @@\n+inside" },
    );
    const changed = refreshSession(session(), to(inside), retained, LATER);
    expect(changed.groups[0]!.notes[0]!.outdated).toEqual(["references"]);
    expect(changed.viewedHunkIds).toEqual([hunkB]);
  });

  it("keeps guidance current when its referenced added lines survive edits beside them", () => {
    // The helper's working tree adds three lines after line 1; na references the last two.
    const helperAdds = (current: string, body: string) =>
      lines(
        { ...files, "helper.ts": ["h0", current] },
        { "a.ts": changeA, "b.ts": changeB, "helper.ts": body },
      );
    const added = helperAdds("h5", "@@ -1,2 +1,5 @@\n h1\n+x\n+y\n+z\n h2");
    const reference = pin("helper.ts", "new", 3, 4);
    const original: Session = {
      ...session(),
      hunks: added.hunks,
      groups: [
        group("ga", [hunkA], "a.ts", [note("na", pin("a.ts", "new", 10), [reference])]),
        session().groups[1]!,
      ],
    };
    const fromAdded = new Map([["s1", added]]);
    for (const body of [
      // The line beside the referenced ones changed.
      "@@ -1,2 +1,5 @@\n h1\n+X\n+y\n+z\n h2",
      // A line was inserted right before them.
      "@@ -1,2 +1,6 @@\n h1\n+x\n+new\n+y\n+z\n h2",
    ]) {
      const refreshed = refreshSession(original, to(helperAdds("h6", body)), fromAdded, LATER);
      expect(refreshed.groups[0]!.notes[0]!.outdated).toBeUndefined();
      expect(refreshed.viewedHunkIds).toEqual([hunkA, hunkB]);
    }
    const edited = helperAdds("h7", "@@ -1,2 +1,5 @@\n h1\n+x\n+Y\n+z\n h2");
    const changed = refreshSession(original, to(edited), fromAdded, LATER);
    expect(changed.groups[0]!.notes[0]!.outdated).toEqual(["references"]);
    expect(changed.viewedHunkIds).toEqual([hunkB]);
  });

  it("cannot verify a reference whose pinned snapshot it cannot read", () => {
    const original: Session = {
      ...session(),
      overview: {
        markdown: `Read ${helperLink}.`,
        references: [{ ...helper, snapshotId: "s0" }],
      },
    };
    const refreshed = refreshSession(original, to(first, "s2"), retained, LATER);
    expect(refreshed.overview?.outdated).toEqual(["references"]);
    expect(refreshed.overview?.references).toEqual(original.overview?.references);
  });

  it("keeps a note on its earlier code while its group no longer covers its mapped range", () => {
    // An old-side note on A's removed line, whose old side stays the same bytes and so maps.
    const original: Session = {
      ...session(),
      groups: [group("ga", [hunkA], "a.ts", [note("na", pin("a.ts", "old", 10))])],
    };
    for (const [snapshot, diff] of [
      ["s2", "@@ -9,3 +9,3 @@\n l9\n-l10\n+X10\n l11"],
      ["s3", ""],
    ] as const) {
      const changed = lines(
        { ...files, "a.ts": ["a0", snapshot] },
        diff ? { "a.ts": diff, "b.ts": changeB } : { "b.ts": changeB },
      );
      const refreshed = refreshSession(original, to(changed, snapshot), retained, LATER);
      expect(refreshed.groups[0]).toMatchObject({ hunkIds: [], files: [] });
      expect(refreshed.groups[0]!.notes[0]).toEqual({
        ...original.groups[0]!.notes[0],
        outdated: ["code"],
      });
    }
  });

  it("unviews a spanning note's surviving hunk when its reference changes, and moves it back once its range maps", () => {
    // Note na spans A and A2; A2 changes and the helper na references changes with it.
    const changeA2 = "@@ -20 +20 @@\n-l20\n+L20";
    const spanning = lines(files, { "a.ts": `${changeA}\n${changeA2}`, "b.ts": changeB });
    const [a, a2, b] = spanning.hunks.map(({ id }) => id) as [string, string, string];
    const original: Session = {
      ...session(),
      hunks: spanning.hunks,
      groups: [
        group("ga", [a, a2], "a.ts", [note("na", pin("a.ts", "new", 10, 20), [helper])]),
        group("gb", [b], "b.ts", []),
      ],
      viewedHunkIds: [a, a2, b],
    };
    const fromSpanning = new Map([["s1", spanning]]);
    const changed = lines(
      { ...files, "a.ts": ["a0", "a6"], "helper.ts": ["h1", "h1"] },
      { "a.ts": `${changeA}\n@@ -20 +20 @@\n-l20\n+X20`, "b.ts": changeB },
    );
    const refreshed = refreshSession(original, to(changed), fromSpanning, LATER);
    expect(refreshed.groups[0]!.hunkIds).toEqual([a]);
    expect(refreshed.groups[0]!.notes[0]).toMatchObject({
      anchor: pin("a.ts", "new", 10, 20),
      outdated: ["code", "references"],
    });
    expect(refreshed.viewedHunkIds).toEqual([b]);
    // A2 was reverted: s1's a.ts is captured again, and the range maps beside A, still in ga.
    const back = refreshSession(
      refreshed,
      to(spanning, "s3"),
      new Map([...fromSpanning, ["s2", changed]]),
      LATER,
    );
    expect(back.groups[0]!.notes[0]).toMatchObject({
      anchor: { ...pin("a.ts", "new", 10, 20), snapshotId: "s3" },
      outdated: ["code", "references"],
    });
  });
});

describe("refresh", () => {
  const request: RefreshRequest = {
    command: "refresh",
    session: "session",
    snapshotId: "s1",
    requestId: "r1",
  };
  const shifted = lines(files, { "a.ts": changeA, "b.ts": changeB.replace("+4,3", "+6,3") });

  it("keeps an identical capture's snapshot, revision and progress, recording only the receipt", () => {
    const outcome = Result.getOrThrow(
      refresh(session(), request, to(first, "s1"), retained, LATER),
    );
    expect(outcome.result).toEqual({
      sessionId: "session",
      previousSnapshotId: "s1",
      snapshotId: "s1",
      revision: 4,
      replaced: false,
    });
    expect({ ...outcome.session, refreshReceipts: [] }).toEqual(session());
  });

  it("replays a committed refresh exactly and refuses changed or stale intent", () => {
    const committed = Result.getOrThrow(refresh(session(), request, to(shifted), retained, LATER));
    expect(committed.result).toMatchObject({ snapshotId: "s2", revision: 5, replaced: true });
    const later = { ...committed.session!, revision: 9 };
    // A lost reply's retry gets the original answer even after the session moved on.
    expect(refresh(later, request, to(first, "s3"), retained, LATER)).toEqual(
      Result.succeed({ result: committed.result }),
    );
    const reused = refresh(
      later,
      { ...request, snapshotId: "s2" },
      to(first, "s3"),
      retained,
      LATER,
    );
    expect(Result.getOrThrow(Result.flip(reused))._tag).toBe("validation_failed");
    const stale = refresh(later, { ...request, requestId: "r2" }, to(first, "s3"), retained, LATER);
    expect(Result.getOrThrow(Result.flip(stale))._tag).toBe("stale_revision");
  });
});
