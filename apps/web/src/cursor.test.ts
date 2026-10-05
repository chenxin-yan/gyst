import type { Hunk } from "@gyst/core/wire";
import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import {
  capturedRows,
  change,
  type Cursor,
  edge,
  fileStep,
  hiddenRanges,
  locate,
  type Model,
  moved,
  type Opened,
  type Row,
  rowsOf,
  type Side,
  stopsOf,
  switched,
} from "./cursor.ts";
import { fileDiffOf } from "./reader.ts";

const hunk = (file: string, patch: string): Hunk => ({
  id: patch,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: "h",
});
const lines = (from: number, to: number, name = (n: number) => `l${n}`) =>
  Array.from({ length: to - from + 1 }, (_, i) => ` ${name(from + i)}`);
// 30 old lines; the new side changes line 5 and adds one after line 20, so it has 31.
const patches = [
  ["@@ -2,7 +2,7 @@", ...lines(2, 4), "-l5", "+L5", ...lines(6, 8)].join("\n"),
  ["@@ -18,6 +18,7 @@", ...lines(18, 20), "+new", ...lines(21, 23)].join("\n"),
];
const oldText = lines(1, 30)
  .map((line) => `${line.slice(1)}\n`)
  .join("");
const newText = oldText.replace("l5\n", "L5\n").replace("l20\n", "l20\nnew\n");
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

/** A row as `old:new` (`-` for a missing side), or `~range` for a hidden range. */
const show = (row: Row) =>
  row.kind === "range" ? `~${row.range}` : `${row.old ?? "-"}:${row.new ?? "-"}`;
const span = (from: number, to: number, shift = 0) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}:${from + i + shift}`);

describe("hiddenRanges", () => {
  it("numbers the ranges as the renderer does, with the trailing one only once the sides load", () => {
    expect(hiddenRanges(partial())).toEqual([
      { index: 0, old: 1, new: 1, size: 1 },
      { index: 1, old: 9, new: 9, size: 9 },
    ]);
    expect(hiddenRanges(loaded()).at(-1)).toEqual({ index: 2, old: 24, new: 25, size: 7 });
  });
});

describe("rowsOf", () => {
  it("reads hunks continuously in stacked order, with a row for each hidden range", () => {
    expect(rowsOf(partial(), new Map()).map(show)).toEqual([
      "~0",
      ...span(2, 4),
      "5:-",
      "-:5",
      ...span(6, 8),
      "~1",
      ...span(18, 20),
      "-:21",
      ...span(21, 23, 1),
    ]);
  });

  it("shows a loaded one-line range whole and opened lines from either end of a range", () => {
    const opened = new Map<number, Opened>([[1, { fromStart: 2, fromEnd: 1 }]]);
    const rows = rowsOf(loaded(), opened);
    expect(rows.map(show)).toEqual([
      ...span(1, 4),
      "5:-",
      "-:5",
      ...span(6, 10),
      "~1",
      ...span(17, 20),
      "-:21",
      ...span(21, 23, 1),
      "~2",
    ]);
    // The still-hidden part names its first line; opened lines remember their range.
    expect(rows.find((row) => row.kind === "range" && row.range === 1)).toMatchObject({
      old: 11,
      new: 11,
    });
    expect(rows.find((row) => row.kind === "line" && row.new === 17)).toMatchObject({ range: 1 });
  });

  it("pairs a change's deletions and additions on one split row and numbers the changes", () => {
    const rows = rowsOf(partial(), new Map());
    const at = (text: string) => rows[rows.map(show).indexOf(text)]!;
    expect(at("5:-").split).toBe(at("-:5").split);
    expect([at("5:-"), at("-:21")].map((row) => row.kind === "line" && row.block)).toEqual([0, 1]);
  });
});

/** Two files: a.ts as above, then b.ts with one change. `folded` files show their header alone. */
const model = (layout: "split" | "stacked", folded: string[] = []): Model => {
  const diffs = new Map([
    ["a.ts", partial()],
    [
      "b.ts",
      fileDiffOf({
        path: "b.ts",
        hunks: [hunk("b.ts", "@@ -1,2 +1,2 @@\n-x\n+y\n z")],
        manifest: undefined,
      }),
    ],
  ]);
  const rows = (file: string) => (folded.includes(file) ? [] : rowsOf(diffs.get(file)!, new Map()));
  return {
    files: [...diffs.keys()],
    rows,
    stops: (file: string, side: Side) => stopsOf(file, rows(file), layout, side),
  };
};
const line = (file: string, side: Side, n: number): Cursor => ({
  file,
  kind: "line",
  side,
  line: n,
});
const header = (file: string, side: Side = "additions"): Cursor => ({ file, kind: "header", side });

describe("stops and movement", () => {
  it("walks one split column, and every stacked line", () => {
    const describeStops = (layout: "split" | "stacked", side: Side) =>
      model(layout)
        .stops("a.ts", side)
        .slice(0, 7)
        .map((stop) => (stop.kind === "line" ? `${stop.side}:${stop.line}` : stop.kind));
    expect(describeStops("split", "deletions")).toEqual([
      "header",
      "range",
      "deletions:2",
      "deletions:3",
      "deletions:4",
      "deletions:5",
      "deletions:6",
    ]);
    expect(describeStops("stacked", "deletions").slice(4)).toEqual([
      "additions:4",
      "deletions:5",
      "additions:5",
    ]);
  });

  it("moves across headers into the next and previous file, and stays in place at the edges", () => {
    const stacked = model("stacked");
    const last = edge(stacked, "last", "additions")!;
    expect(last).toEqual(line("b.ts", "additions", 2));
    expect(moved(stacked, line("a.ts", "additions", 24), 1)).toEqual(header("b.ts"));
    expect(moved(stacked, header("b.ts"), -1)).toEqual(line("a.ts", "additions", 24));
    expect(moved(stacked, last, 5)).toEqual(last);
    expect(edge(stacked, "first", "additions")).toEqual(header("a.ts"));
    expect(moved(stacked, header("a.ts"), -3)).toEqual(header("a.ts"));
    // A folded file is its header alone.
    expect(moved(model("stacked", ["a.ts"]), header("a.ts"), 1)).toEqual(header("b.ts"));
  });

  it("keeps a selection's moves on its file's lines", () => {
    const stacked = model("stacked");
    expect(moved(stacked, line("a.ts", "additions", 24), 3, true)).toEqual(
      line("a.ts", "additions", 24),
    );
    expect(moved(stacked, line("a.ts", "additions", 2), -2, true)).toEqual(
      line("a.ts", "additions", 2),
    );
  });

  it("switches split columns on the same row, and places a stacked deletion beside itself", () => {
    const split = model("split");
    expect(switched(split, line("a.ts", "deletions", 5), "additions")).toEqual(
      line("a.ts", "additions", 5),
    );
    expect(switched(split, line("a.ts", "additions", 8), "deletions")).toEqual(
      line("a.ts", "deletions", 8),
    );
    // The added line 21 has no old side: its row's nearest deletions-side line is above it.
    expect(switched(split, line("a.ts", "additions", 21), "deletions")).toEqual(
      line("a.ts", "deletions", 20),
    );
    // Past the added line the numbers differ: old 22 sits beside new 23, as a pulled-back cursor needs.
    expect(switched(split, line("a.ts", "deletions", 22), "additions")).toEqual(
      line("a.ts", "additions", 23),
    );
    const stops = split.stops("a.ts", "additions");
    const at = locate(stops, split.rows("a.ts"), line("a.ts", "deletions", 5));
    expect(stops[at]).toMatchObject({ side: "additions", line: 5 });
  });

  it("stands on an opened range's first line, and on the header when its line is gone", () => {
    const rows = rowsOf(loaded(), new Map([[1, { fromStart: 9, fromEnd: 0 }]]));
    const stops = stopsOf("a.ts", rows, "stacked", "additions");
    const range: Cursor = { file: "a.ts", kind: "range", side: "additions", range: 1 };
    expect(stops[locate(stops, rows, range)]).toMatchObject({ kind: "line", line: 9 });
    expect(locate(stops, rows, line("a.ts", "additions", 99))).toBe(0);
  });
});

describe("change and file jumps", () => {
  it("goes to each change's first line, across files, and back", () => {
    const stacked = model("stacked");
    const first = change(stacked, header("a.ts"), 1)!;
    expect(first).toEqual(line("a.ts", "deletions", 5));
    const second = change(stacked, first, 1)!;
    expect(second).toEqual(line("a.ts", "additions", 21));
    expect(change(stacked, second, 1)).toEqual(line("b.ts", "deletions", 1));
    expect(change(stacked, line("a.ts", "additions", 23), -1)).toEqual(second);
    expect(change(stacked, first, -1)).toBeUndefined();
  });

  it("starts a change on the other split column when it has no lines on the walked one", () => {
    const split = model("split");
    const first = change(split, header("a.ts", "deletions"), 1)!;
    expect(first).toEqual(line("a.ts", "deletions", 5));
    expect(change(split, first, 1)).toEqual(line("a.ts", "additions", 21));
    // Folded files have no changes to stop on.
    expect(change(model("split", ["a.ts"]), header("a.ts"), 1)).toEqual(
      line("b.ts", "additions", 1),
    );
  });

  it("goes to the next file's header, and back to its own header before the previous one", () => {
    const stacked = model("stacked");
    expect(fileStep(stacked, line("a.ts", "additions", 3), 1)).toEqual(header("b.ts"));
    expect(fileStep(stacked, line("b.ts", "additions", 2), -1)).toEqual(header("b.ts"));
    expect(fileStep(stacked, header("b.ts"), -1)).toEqual(header("a.ts"));
    expect(fileStep(stacked, header("b.ts"), 1)).toBeUndefined();
  });
});

describe("a captured file shown whole", () => {
  const whole = (layout: "split" | "stacked", side: "deletions" | "additions"): Model => ({
    files: ["src/long.ts"],
    rows: () => capturedRows(5, side),
    stops: (file, at) => stopsOf(file, capturedRows(5, side), layout, at),
  });

  it("walks lines 1 to the end on the side it was opened on, with no changes to jump to", () => {
    const split = whole("split", "deletions");
    const old = line("src/long.ts", "deletions", 2);
    expect(moved(split, old, 1)).toEqual(line("src/long.ts", "deletions", 3));
    expect(moved(split, header("src/long.ts", "deletions"), 2)).toEqual(old);
    expect(edge(split, "last", "deletions")).toEqual(line("src/long.ts", "deletions", 5));
    expect(change(split, old, 1)).toBeUndefined();
    expect(capturedRows(0, "additions")).toEqual([]);
  });

  it("keeps an old side's cursor and selection on the old side when stacked", () => {
    const stacked = whole("stacked", "deletions");
    const from = line("src/long.ts", "deletions", 4);
    expect(moved(stacked, from, 1)).toEqual(line("src/long.ts", "deletions", 5));
    expect(moved(stacked, from, 5, true)).toEqual(line("src/long.ts", "deletions", 5));
    expect(moved(stacked, from, -9, true)).toEqual(line("src/long.ts", "deletions", 1));
    expect(edge(stacked, "last", "additions")).toEqual(line("src/long.ts", "deletions", 5));
    const stops = stacked.stops("src/long.ts", "deletions");
    expect(
      stops[locate(stops, capturedRows(5, "deletions"), line("src/long.ts", "deletions", 3))],
    ).toMatchObject({ kind: "line", side: "deletions", line: 3 });
  });

  it("keeps a new side's cursor on the new side when stacked", () => {
    const stacked = whole("stacked", "additions");
    expect(moved(stacked, line("src/long.ts", "additions", 4), 5, true)).toEqual(
      line("src/long.ts", "additions", 5),
    );
  });
});
