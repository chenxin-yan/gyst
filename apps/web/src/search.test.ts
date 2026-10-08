import type { Hunk } from "@gyst/core/wire";
import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import { capturedRows, type Opened, rowsOf } from "./cursor.ts";
import { fileDiffOf } from "./reader.ts";
import {
  diffText,
  hitsOf,
  indexOf,
  matchAt,
  matcher,
  orderOf,
  readingOrder,
  resultOf,
  searchStep,
  wholeText,
} from "./search.ts";

const hunk = (file: string, patch: string): Hunk => ({
  id: patch,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: "h",
});
const context = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ` line ${from + i}`);
// 30 old lines; the new side renames line 5 and adds one after line 20, so it has 31.
const patches = [
  ["@@ -2,7 +2,7 @@", ...context(2, 4), "-line 5", "+Line 5 renamed", ...context(6, 8)].join("\n"),
  ["@@ -18,6 +18,7 @@", ...context(18, 20), "+added after 20", ...context(21, 23)].join("\n"),
];
const oldText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
const newText = oldText
  .replace("line 5\n", "Line 5 renamed\n")
  .replace("line 20\n", "line 20\nadded after 20\n");
const partial = () =>
  fileDiffOf({
    path: "a.ts",
    hunks: patches.map((patch) => hunk("a.ts", patch)),
    manifest: undefined,
  });
const loaded = () =>
  hydratePartialDiff("clone", partial(), {
    oldFile: { name: "a.ts", contents: oldText },
    newFile: { name: "a.ts", contents: newText },
  });
/** A hit as `old:new`, `-` for a missing side. */
const show = ({ old, new: added }: { old?: number; new?: number }) =>
  `${old ?? "-"}:${added ?? "-"}`;
const search = (
  query: string,
  diff = partial(),
  layout: "split" | "stacked" = "stacked",
  opened: ReadonlyMap<number, Opened> = new Map(),
) => hitsOf(readingOrder(rowsOf(diff, opened), layout), diffText(diff), matcher(query));

describe("matcher", () => {
  it("matches literal text, ignoring case unless the query has a capital", () => {
    expect(matcher("line")("A Line here")).toBe(true);
    expect(matcher("Line")("a line here")).toBe(false);
    expect(matcher("Line")("A Line here")).toBe(true);
    expect(matcher("a.b")("axb")).toBe(false);
    expect(matcher("a.b")("a.b")).toBe(true);
    expect(matcher("(x")("f(x)")).toBe(true);
    expect(matcher("é")("CAFÉ")).toBe(true);
    expect(matcher("É")("café")).toBe(false);
  });
});

describe("hitsOf", () => {
  it("reads a partial diff's hunk lines without its sides loaded, never a hidden range", () => {
    // Line 1 is hidden before the first hunk and lines 9-17 between the hunks.
    expect(search("line 1").map(show)).toEqual(["18:18", "19:19"]);
    expect(search("line 5").map(show)).toEqual(["5:-", "-:5"]);
    expect(search("Line 5").map(show)).toEqual(["-:5"]);
    expect(search("added").map(show)).toEqual(["-:21"]);
    expect(search("line 9")).toEqual([]);
  });

  it("reads lines the reader opened in a loaded diff, and a loaded one-line range", () => {
    const opened = new Map<number, Opened>([[1, { fromStart: 2, fromEnd: 0 }]]);
    expect(search("line 1", loaded(), "stacked", opened).map(show)).toEqual([
      "1:1",
      "10:10",
      "18:18",
      "19:19",
    ]);
    // The trailing range stays hidden.
    expect(search("line 30", loaded(), "stacked", opened)).toEqual([]);
  });

  it("orders a change's lines as each layout draws them", () => {
    const diff = fileDiffOf({
      path: "b.ts",
      hunks: [hunk("b.ts", "@@ -1,2 +1,2 @@\n-x one\n-x two\n+x one!\n+x two!")],
      manifest: undefined,
    });
    expect(search("x", diff, "stacked").map(show)).toEqual(["1:-", "2:-", "-:1", "-:2"]);
    expect(search("x", diff, "split").map(show)).toEqual(["1:-", "-:1", "2:-", "-:2"]);
  });

  it("reads a captured side shown whole", () => {
    const rows = capturedRows(3, "deletions");
    expect(hitsOf(rows, wholeText(["a", "b a", "c"]), matcher("a")).map(show)).toEqual([
      "1:-",
      "2:-",
    ]);
  });
});

describe("searchStep", () => {
  // Three files: two hits, none, three.
  const result = resultOf(
    ["a", "b", "c"],
    [[{ order: 2 }, { order: 5 }], [], [{ order: 0 }, { order: 3 }, { order: 4 }]],
  );
  const step = (fileIndex: number, order: number, direction: 1 | -1, inclusive = false) => {
    const at = searchStep(result, { fileIndex, order }, direction, inclusive);
    return at && indexOf(result, at);
  };

  it("numbers matches across files", () => {
    expect(result.total).toBe(5);
    expect([0, 1, 2, 3, 4].map((index) => matchAt(result, index))).toEqual([
      { fileIndex: 0, hit: 0 },
      { fileIndex: 0, hit: 1 },
      { fileIndex: 2, hit: 0 },
      { fileIndex: 2, hit: 1 },
      { fileIndex: 2, hit: 2 },
    ]);
  });

  it("steps from a place to the next or previous match across files, wrapping at the ends", () => {
    expect(step(0, -1, 1)).toBe(0);
    expect(step(0, 2, 1)).toBe(1);
    expect(step(0, 3, 1)).toBe(1);
    expect(step(0, 5, 1)).toBe(2);
    expect(step(1, -1, 1)).toBe(2);
    expect(step(2, 4, 1)).toBe(0);
    expect(step(0, 2, -1)).toBe(4);
    expect(step(2, 0, -1)).toBe(1);
    expect(step(2, 3, -1)).toBe(2);
    expect(step(1, -1, -1)).toBe(1);
  });

  it("counts a match on the place itself only when inclusive", () => {
    expect(step(0, 2, 1, true)).toBe(0);
    expect(step(2, 4, -1, true)).toBe(4);
  });

  it("finds nothing without matches", () => {
    expect(searchStep(resultOf(["a"], [[]]), { fileIndex: 0, order: -1 }, 1)).toBeUndefined();
  });
});

describe("orderOf", () => {
  it("places a cursor on its row in reading order, a header before every row", () => {
    const rows = readingOrder(rowsOf(partial(), new Map()), "split");
    expect(orderOf(rows, { file: "a.ts", kind: "header", side: "additions" })).toBe(-1);
    expect(orderOf(rows, { file: "a.ts", kind: "range", side: "additions", range: 1 })).toBe(
      rows.findIndex((row) => row.kind === "range" && row.range === 1),
    );
    const at = orderOf(rows, { file: "a.ts", kind: "line", side: "deletions", line: 5 });
    expect(rows[at]).toMatchObject({ kind: "line", old: 5 });
    expect(rows[at + 1]).toMatchObject({ kind: "line", new: 5 });
  });
});
