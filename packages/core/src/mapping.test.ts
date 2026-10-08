import { describe, expect, it } from "vite-plus/test";
import { Result } from "effect";
import type { ContentSide } from "./content.ts";
import { mapRange, matchHunks, type SnapshotLines } from "./mapping.ts";
import { parseFilePatch } from "./snapshot.ts";

const blob = (name: string): ContentSide => ({
  kind: "text",
  blob: name.padEnd(64, "0").replace(/[^0-9a-f]/g, "f"),
  size: 1,
});
/** One file `a.ts` whose sides are the named blobs and whose hunks are `patch`'s. */
const snapshot = (old: string, current: string, patch: string): SnapshotLines => ({
  files: [{ path: "a.ts", old: blob(old), new: blob(current) }],
  hunks: patch ? Result.getOrThrow(parseFilePatch(`--- a/a.ts\n+++ b/a.ts\n${patch}`, "a.ts")) : [],
});
const range = (side: "old" | "new", startLine: number, endLine = startLine) => ({
  path: "a.ts",
  side,
  startLine,
  endLine,
});

// The old side is 20 lines; the first snapshot changes line 10, the second also inserts two lines
// after line 2, so everything from line 3 on moves down by two on the new side.
const first = snapshot("0", "1", "@@ -9,3 +9,3 @@\n l9\n-l10\n+L10\n l11\n");
const shifted = snapshot(
  "0",
  "2",
  "@@ -2,0 +3,2 @@\n+i1\n+i2\n@@ -9,3 +11,3 @@\n l9\n-l10\n+L10\n l11\n",
);

describe("mapRange", () => {
  it("maps a side with identical bytes to itself", () => {
    expect(mapRange(first, snapshot("0", "1", ""), range("new", 4, 12))).toEqual(
      range("new", 4, 12),
    );
  });

  it("follows a line shift through unchanged lines and an exactly matched hunk", () => {
    expect(mapRange(first, shifted, range("new", 9, 11))).toEqual(range("new", 11, 13));
    expect(mapRange(first, shifted, range("new", 1, 2))).toEqual(range("new", 1, 2));
    expect(mapRange(first, shifted, range("old", 5, 12))).toEqual(range("old", 5, 12));
  });

  it("refuses a range a change split, a changed hunk and both sides changing", () => {
    expect(mapRange(first, shifted, range("new", 2, 3))).toBeUndefined();
    const edited = snapshot("0", "3", "@@ -9,3 +9,3 @@\n l9\n-l10\n+other\n l11\n");
    expect(mapRange(first, edited, range("new", 10))).toBeUndefined();
    expect(mapRange(first, edited, range("new", 1, 9))).toEqual(range("new", 1, 9));
    const rebased = snapshot(
      "4",
      "2",
      "@@ -2,0 +3,2 @@\n+i1\n+i2\n@@ -9,3 +11,3 @@\n l9\n-l10\n+L10\n l11\n",
    );
    expect(mapRange(first, rebased, range("new", 4))).toBeUndefined();
    expect(mapRange(first, rebased, range("new", 10))).toEqual(range("new", 12));
  });

  it("maps context lines through an exactly matched hunk when both sides moved", () => {
    // Base and head both gained two lines above the change: only coordinates moved.
    const moved = snapshot("5", "6", "@@ -11,3 +11,3 @@\n l9\n-l10\n+L10\n l11\n");
    expect(mapRange(first, moved, range("new", 9, 11))).toEqual(range("new", 11, 13));
    expect(mapRange(first, moved, range("old", 9, 10))).toEqual(range("old", 11, 12));
    // Outside the hunk nothing proves where a line went.
    expect(mapRange(first, moved, range("new", 8, 9))).toBeUndefined();
  });

  it("maps an unchanged line of a changed hunk through edits beside it", () => {
    // The new side adds three lines after line 5; later captures edit or add lines beside them.
    const added = snapshot("0", "7", "@@ -5,2 +5,5 @@\n l5\n+a\n+ref\n+b\n l6\n");
    const adjacent = snapshot("0", "8", "@@ -5,2 +5,5 @@\n l5\n+A\n+ref\n+b\n l6\n");
    expect(mapRange(added, adjacent, range("new", 7, 9))).toEqual(range("new", 7, 9));
    expect(mapRange(added, adjacent, range("new", 6))).toBeUndefined();
    const inserted = snapshot("0", "9", "@@ -5,2 +5,6 @@\n l5\n+a\n+new\n+ref\n+b\n l6\n");
    expect(mapRange(added, inserted, range("new", 7, 9))).toEqual(range("new", 8, 10));
    expect(mapRange(added, inserted, range("new", 5, 6))).toEqual(range("new", 5, 6));
    expect(mapRange(added, inserted, range("new", 6, 7))).toBeUndefined();
    // Identical lines either side of an insertion leave which one is the reference ambiguous.
    const doubled = snapshot("0", "a", "@@ -5,2 +5,6 @@\n l5\n+a\n+ref\n+ref\n+b\n l6\n");
    expect(mapRange(added, doubled, range("new", 7))).toBeUndefined();
    expect(mapRange(added, doubled, range("new", 6))).toEqual(range("new", 6));
    // So does deleting one of two identical lines: neither one is the line that stayed.
    expect(mapRange(doubled, added, range("new", 7))).toBeUndefined();
    expect(mapRange(doubled, added, range("new", 8))).toBeUndefined();
    expect(mapRange(doubled, added, range("new", 6))).toEqual(range("new", 6));
    expect(mapRange(doubled, added, range("new", 9))).toEqual(range("new", 8));
    // A removed line maps the same way while the new side stays the same bytes.
    const removed = snapshot("b", "0", "@@ -5,4 +5,2 @@\n l5\n-x\n-gone\n l6\n");
    const edited = snapshot("c", "0", "@@ -5,4 +5,2 @@\n l5\n-y\n-gone\n l6\n");
    expect(mapRange(removed, edited, range("old", 7, 8))).toEqual(range("old", 7, 8));
    const removedTwice = snapshot("e", "0", "@@ -5,5 +5,2 @@\n l5\n-x\n-gone\n-gone\n l6\n");
    expect(mapRange(removedTwice, removed, range("old", 7))).toBeUndefined();
    expect(mapRange(removedTwice, removed, range("old", 8))).toBeUndefined();
    expect(mapRange(removedTwice, removed, range("old", 6))).toEqual(range("old", 6));
    // Nothing maps through a changed hunk while both sides changed.
    expect(
      mapRange(
        added,
        { ...adjacent, files: [{ path: "a.ts", old: blob("d"), new: blob("8") }] },
        range("new", 7),
      ),
    ).toBeUndefined();
  });

  it("refuses a repeated changed line whatever other edit hides the competing copy", () => {
    // Lines one side adds (or removes) after line 5 while the other side stays the same bytes.
    const run = (side: "old" | "new", name: string, lines: string[]) =>
      snapshot(
        side === "old" ? name : "0",
        side === "new" ? name : "0",
        `@@ -5,${side === "old" ? lines.length + 2 : 2} +5,${side === "new" ? lines.length + 2 : 2} @@\n l5\n${lines.map((line) => `${side === "new" ? "+" : "-"}${line}\n`).join("")} l6\n`,
      );
    for (const side of ["old", "new"] as const) {
      // Deleting one ref and editing b leaves only the prefix reading, for the first ref.
      const doubled = run(side, "11", ["a", "ref", "ref", "b"]);
      const edited = run(side, "12", ["a", "ref", "B"]);
      expect(mapRange(doubled, edited, range(side, 7))).toBeUndefined();
      expect(mapRange(doubled, edited, range(side, 8))).toBeUndefined();
      expect(mapRange(doubled, edited, range(side, 6))).toEqual(range(side, 6));
      expect(mapRange(edited, doubled, range(side, 7))).toBeUndefined();
      expect(mapRange(edited, doubled, range(side, 6))).toEqual(range(side, 6));
      // Two insertions agree on the second ref's readings, yet either later ref could be it.
      const twice = run(side, "13", ["a", "ref", "ref", "X", "b"]);
      const thrice = run(side, "14", ["a", "ref", "Y", "ref", "ref", "X", "b"]);
      expect(mapRange(twice, thrice, range(side, 7))).toBeUndefined();
      expect(mapRange(twice, thrice, range(side, 8))).toBeUndefined();
      expect(mapRange(twice, thrice, range(side, 9, 10))).toEqual(range(side, 11, 12));
      expect(mapRange(thrice, twice, range(side, 10))).toBeUndefined();
      expect(mapRange(thrice, twice, range(side, 9))).toBeUndefined();
      expect(mapRange(thrice, twice, range(side, 11, 12))).toEqual(range(side, 9, 10));
      // A segment that stayed the same still maps its repeated lines.
      expect(
        mapRange(twice, run(side, "15", ["a", "ref", "ref", "X", "b"]), range(side, 7, 8)),
      ).toEqual(range(side, 7, 8));
    }
  });

  it("aligns a long changed hunk once, not once per line", () => {
    // An added file of 20,000 lines whose last line the next capture edits.
    const size = 20_000;
    const addedFile = (current: string, last: string) =>
      snapshot(
        "0",
        current,
        `@@ -0,0 +1,${size} @@\n${Array.from({ length: size - 1 }, (_, index) => `+line ${index}\n`).join("")}+${last}\n`,
      );
    const before = addedFile("f", "last");
    const after = addedFile("e", "edited");
    const started = performance.now();
    expect(mapRange(before, after, range("new", 1, size - 1))).toEqual(range("new", 1, size - 1));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("maps nothing to a file the other snapshot lacks", () => {
    expect(mapRange(first, { files: [], hunks: [] }, range("new", 1))).toBeUndefined();
  });
});

describe("matchHunks", () => {
  it("matches exact same-file bodies whatever their headers, and never ambiguous duplicates", () => {
    expect([...matchHunks(first.hunks, shifted.hunks)]).toEqual([
      [first.hunks[0]!.id, shifted.hunks[1]],
    ]);
    const twice = snapshot("0", "1", "@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-a\n+b\n");
    const once = snapshot("0", "1", "@@ -1 +1 @@\n-a\n+b\n");
    expect(matchHunks(twice.hunks, once.hunks).size).toBe(0);
    expect(matchHunks(twice.hunks, twice.hunks).size).toBe(2);
  });
});
