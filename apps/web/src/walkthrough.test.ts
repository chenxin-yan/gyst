import type { Hunk, StatusPayload } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { changedFiles } from "./reader.ts";
import {
  annotationsOf,
  coverageOf,
  outdatedReason,
  groupProgress,
  noteLine,
  noteSequence,
  noteStep,
  type StatusGroup,
  type StatusNote,
  viewFiles,
} from "./walkthrough.ts";

const snapshotId = "s".repeat(64);
const hunk = (id: string, file: string, patch: string): Hunk => ({
  id,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: id,
});
// a.ts: changes at new lines 10 and 20 (two hunks of one group) and 40 (another group's).
// b.ts: a change at line 5. c.ts: a pure deletion of old line 3.
const hunks = [
  hunk("a1", "a.ts", "@@ -9,3 +9,3 @@\n nine\n-ten\n+TEN\n eleven"),
  hunk("a2", "a.ts", "@@ -19,3 +19,4 @@\n x\n-twenty\n+TWENTY\n+twenty-one\n y"),
  hunk("a3", "a.ts", "@@ -39,3 +40,3 @@\n x\n-forty\n+FORTY\n y"),
  hunk("b1", "b.ts", "@@ -5 +5 @@\n-five\n+FIVE"),
  hunk("c1", "c.ts", "@@ -2,3 +2,2 @@\n two\n-three\n four"),
];
const files = changedFiles(hunks, []);

const note = (
  id: string,
  path: string,
  side: "old" | "new",
  startLine: number,
  endLine: number,
): StatusNote => ({
  id,
  anchor: { snapshotId, path, side, startLine, endLine },
  markdown: id,
  references: [],
});
const group = (
  id: string,
  hunkIds: string[],
  groupFiles: string[],
  notes: StatusNote[] = [],
): StatusGroup => ({
  id,
  title: `Title ${id}`,
  overview: { markdown: `About ${id}`, references: [] },
  hunkIds,
  files: groupFiles,
  notes,
  count: hunkIds.length,
});
const core = group(
  "core",
  ["a1", "a2", "b1"],
  ["b.ts", "a.ts"],
  [note("b-note", "b.ts", "new", 5, 5), note("span", "a.ts", "new", 10, 20)],
);
const edge = group("edge", ["a3", "c1"], ["c.ts", "a.ts"], [note("gone", "c.ts", "old", 3, 3)]);
const status = (
  groups: StatusGroup[],
  preparation: Partial<StatusPayload["preparation"]> = {},
): StatusPayload => ({
  session: {
    id: "s",
    repoRoot: "/r",
    scope: { kind: "uncommitted" },
    snapshotId,
    createdAt: "",
    updatedAt: "",
  },
  revision: 1,
  overview: { markdown: "The walkthrough.", references: [] },
  groups,
  preparation: {
    state: "complete",
    groupedHunks: 5,
    totalHunks: 5,
    overviewMissing: false,
    groupsMissingOverview: [],
    overviewOutdated: false,
    groupsOutdated: [],
    notesOutdated: [],
    ...preparation,
  },
  viewedHunkIds: [],
  files: [],
});
const both = status([core, edge]);

describe("viewFiles", () => {
  it("shows a group's files in its order, every hunk real, and covers only its own hunks", () => {
    const shown = viewFiles({ kind: "group", id: "core" }, files, both);
    expect(shown.group).toBe(core);
    expect(shown.files.map((file) => file.path)).toEqual(["b.ts", "a.ts"]);
    expect(shown.files[1]!.hunks.map((h) => h.id)).toEqual(["a1", "a2", "a3"]);
    expect(Object.fromEntries(shown.hunkIds)).toEqual({ "b.ts": ["b1"], "a.ts": ["a1", "a2"] });
  });

  it("shows every change under a path with all of each file's hunks, and falls back from a gone group", () => {
    const all = viewFiles({ kind: "files", path: "" }, files, both);
    expect(all.group).toBeUndefined();
    expect(all.files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(all.hunkIds.get("a.ts")).toEqual(["a1", "a2", "a3"]);
    expect(viewFiles({ kind: "files", path: "b.ts" }, files, both).files).toHaveLength(1);
    expect(viewFiles({ kind: "group", id: "removed" }, files, both)).toEqual(all);
  });
});

describe("groupProgress", () => {
  it("derives a checkmark from Viewed hunks only, never for an empty group", () => {
    expect(groupProgress(core, new Set(["a1", "b1"]))).toEqual({
      viewed: 2,
      total: 3,
      done: false,
    });
    expect(groupProgress(core, new Set(["a1", "a2", "b1", "c1"]))).toEqual({
      viewed: 3,
      total: 3,
      done: true,
    });
    expect(groupProgress({ hunkIds: [] }, new Set())).toEqual({ viewed: 0, total: 0, done: false });
  });
});

describe("coverageOf", () => {
  it("says nothing for a plain or complete walkthrough", () => {
    expect(coverageOf(status([], { state: "plain", groupedHunks: 0 }))).toBeUndefined();
    expect(coverageOf(both)).toBeUndefined();
  });

  it("says what an incomplete walkthrough lacks, leaving ungrouped hunks under Files", () => {
    expect(
      coverageOf(
        status([core, { ...edge, overview: null }], {
          state: "incomplete",
          groupedHunks: 3,
          overviewMissing: true,
          groupsMissingOverview: ["edge"],
          overviewOutdated: false,
          groupsOutdated: [],
          notesOutdated: [],
        }),
      ),
    ).toEqual([
      "Walkthrough in progress.",
      "3 of 5 hunks are in groups; the rest are under Files.",
      "The walkthrough has no overview yet.",
      "Title edge has no overview yet.",
    ]);
  });

  it("names Outdated guidance, so a walkthrough with it reads as unfinished", () => {
    expect(
      coverageOf(
        status([core, edge], {
          state: "incomplete",
          groupedHunks: 5,
          overviewMissing: false,
          groupsMissingOverview: [],
          overviewOutdated: true,
          groupsOutdated: ["edge"],
          notesOutdated: ["n1", "n2"],
        }),
      ),
    ).toEqual([
      "Walkthrough in progress.",
      "The walkthrough overview is Outdated.",
      "Title edge is Outdated.",
      "2 notes are Outdated.",
    ]);
  });
});

describe("outdatedReason", () => {
  it("says why guidance is Outdated, in words, and nothing for current guidance", () => {
    expect(outdatedReason(undefined)).toBeUndefined();
    expect(outdatedReason(["code", "references"])).toBe(
      "Outdated: the code it explains changed; code it references changed.",
    );
    expect(outdatedReason(undefined, true)).toBe("Outdated: its changes are gone since a refresh.");
  });
});

describe("notes", () => {
  it("sit under the last changed line inside their range, on their side", () => {
    const a = files[0]!.hunks;
    // 10–20 spans a1, the unchanged lines between and a2, whose last addition is line 21: outside.
    expect(noteLine(note("n", "a.ts", "new", 10, 20), a)).toBe(20);
    expect(noteLine(note("n", "a.ts", "new", 8, 30), a)).toBe(21);
    expect(noteLine(note("n", "a.ts", "old", 9, 25), a)).toBe(20);
    // A pure deletion is on the old side only.
    expect(noteLine(note("n", "c.ts", "old", 1, 4), files[2]!.hunks)).toBe(3);
    // No changed line inside: the end of the range.
    expect(noteLine(note("n", "a.ts", "new", 25, 30), a)).toBe(30);
  });

  it("follow code order: the view's file order, then hunk, old side first, then start line", () => {
    const coreView = viewFiles({ kind: "group", id: "core" }, files, both);
    expect(
      noteSequence(coreView, both).map(({ note, file, side, line }) => [note.id, file, side, line]),
    ).toEqual([
      ["b-note", "b.ts", "additions", 5],
      ["span", "a.ts", "additions", 20],
    ]);
    const mixed = status([
      group(
        "core",
        ["a1", "a2", "b1"],
        ["a.ts", "b.ts"],
        [
          note("second-hunk", "a.ts", "new", 20, 21),
          note("new-side", "a.ts", "new", 10, 10),
          note("old-side", "a.ts", "old", 10, 10),
        ],
      ),
      edge,
    ]);
    const all = viewFiles({ kind: "files", path: "" }, files, mixed);
    expect(noteSequence(all, mixed).map(({ note }) => note.id)).toEqual([
      "old-side",
      "new-side",
      "second-hunk",
      "gone",
    ]);
    // A group view shows its own notes; one pinned to another snapshot is not on this diff.
    const stale = status([
      {
        ...core,
        notes: [{ ...core.notes[0]!, anchor: { ...core.notes[0]!.anchor, snapshotId: "old" } }],
      },
    ]);
    expect(noteSequence(viewFiles({ kind: "group", id: "core" }, files, stale), stale)).toEqual([]);
  });

  it("step by the reader's place, from a note's own line, or from the note Mouse mode went to", () => {
    const sequence = noteSequence(viewFiles({ kind: "files", path: "" }, files, both), both);
    expect(sequence.map(({ note }) => note.id)).toEqual(["span", "b-note", "gone"]);
    expect(noteStep(sequence, undefined, 1)).toBe(0);
    expect(noteStep(sequence, undefined, -1)).toBe(2);
    expect(noteStep(sequence, { fileIndex: 0, side: "additions", line: 0 }, 1)).toBe(0);
    expect(noteStep(sequence, { fileIndex: 0, side: "additions", line: 20 }, 1)).toBe(1);
    expect(noteStep(sequence, { fileIndex: 0, side: "additions", line: 20 }, -1)).toBeUndefined();
    expect(noteStep(sequence, { fileIndex: 0, side: "additions", line: 30 }, -1)).toBe(0);
    expect(noteStep(sequence, { fileIndex: 2, side: "deletions", line: 3 }, 1)).toBeUndefined();
    expect(noteStep(sequence, { fileIndex: 2, side: "additions", line: 9 }, -1)).toBe(2);
    expect(noteStep(sequence, { fileIndex: 2, side: "additions", line: 9 }, -1, 1)).toBe(0);
  });
});

describe("annotationsOf", () => {
  it("places notes and labels the hunks a group view shows but does not own", () => {
    const shown = viewFiles({ kind: "group", id: "core" }, files, both);
    const annotations = annotationsOf(shown, noteSequence(shown, both), both);
    expect(Object.fromEntries(annotations)).toEqual({
      "b.ts": [
        { side: "additions", lineNumber: 5, metadata: { kind: "note", note: core.notes[0] } },
      ],
      "a.ts": [
        { side: "additions", lineNumber: 20, metadata: { kind: "note", note: core.notes[1] } },
        {
          side: "additions",
          lineNumber: 41,
          metadata: { kind: "foreign", hunkId: "a3", owner: "Title edge" },
        },
      ],
    });
    // An ungrouped hunk has no owner yet; a pure deletion is labelled on the old side.
    const partial = status([group("core", ["a1"], ["a.ts"]), group("edge", ["a2"], ["a.ts"])]);
    const shownPartial = viewFiles({ kind: "group", id: "edge" }, files, partial);
    expect(annotationsOf(shownPartial, [], partial).get("a.ts")).toEqual([
      {
        side: "additions",
        lineNumber: 10,
        metadata: { kind: "foreign", hunkId: "a1", owner: "Title core" },
      },
      {
        side: "additions",
        lineNumber: 41,
        metadata: { kind: "foreign", hunkId: "a3", owner: undefined },
      },
    ]);
    const deletion = status([group("core", ["b1"], ["b.ts"]), group("edge", ["a1"], ["c.ts"])]);
    const cView = viewFiles({ kind: "group", id: "edge" }, files, deletion);
    expect(annotationsOf(cView, [], deletion).get("c.ts")).toEqual([
      {
        side: "deletions",
        lineNumber: 3,
        metadata: { kind: "foreign", hunkId: "c1", owner: undefined },
      },
    ]);
  });

  it("labels nothing in a files view, and leaves a file without notes out", () => {
    const shown = viewFiles({ kind: "files", path: "" }, files, both);
    const annotations = annotationsOf(shown, noteSequence(shown, both), both);
    expect([...annotations.keys()]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(annotations.get("a.ts")!.map(({ metadata }) => metadata.kind)).toEqual(["note"]);
    const none = status([group("core", ["a1"], ["a.ts"])]);
    expect(annotationsOf(viewFiles({ kind: "files", path: "" }, files, none), [], none).size).toBe(
      0,
    );
  });
});
