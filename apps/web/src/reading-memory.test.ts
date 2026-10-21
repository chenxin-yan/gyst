import type { CapturedRange, Hunk } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import type { Cursor } from "./cursor.ts";
import type { Place } from "./navigation.ts";
import { type ReadingPlace, recall, remember } from "./reading-memory.ts";

const placeAt = (path: string, file: string | undefined): ReadingPlace => ({
  review: { kind: "files", path },
  captured: undefined,
  expandedOpened: new Map(),
  peek: undefined,
  back: [],
  inputMode: "vim",
  cursor: undefined,
  opened: new Map(),
  top: file === undefined ? undefined : { position: { file, side: undefined, line: undefined } },
});

const hunk = (file: string, id: string, patch: string): Hunk => ({
  id,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: id,
});
const x = hunk("lib/x.ts", "x1", "@@ -9 +9 @@\n-a\n+b");
const y = hunk("lib/y.ts", "y1", "@@ -3 +3 @@\n-c\n+d");

describe("reading memory", () => {
  it("keeps each session's place apart, so switching sessions resumes each where it was left", () => {
    const b: ReadingPlace = {
      ...placeAt("src", undefined),
      inputMode: "mouse",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map([["src/b.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      top: { position: { file: "src/b.ts", side: "additions", line: 9 } },
    };
    remember("b", "snap-b", [], b);
    remember("c", "snap-c", [], placeAt("", "c.ts"));
    expect(recall("b", "snap-b", [])).toEqual(b);
    expect(recall("c", "snap-c", [])).toEqual(placeAt("", "c.ts"));
    expect(recall("a", "snap-b", [])).toBeUndefined();
  });

  it("keeps an expanded reference with its opened lines, its peek and the places Back returns to", () => {
    const target: CapturedRange = {
      snapshotId: "snap-e",
      path: "lib/x.ts",
      side: "new",
      startLine: 4,
      endLine: 6,
    };
    const origin: Place = {
      review: { kind: "group", id: "core" },
      captured: undefined,
      cursor: { file: "a.ts", kind: "line", side: "additions", line: 18 },
      lines: null,
      folded: new Set<string>(),
      restore: { scrollTop: 120 },
      peek: { target, origin: { kind: "note", noteId: "span" } },
    };
    const expanded: ReadingPlace = {
      ...placeAt("", undefined),
      review: origin.review,
      captured: target,
      expandedOpened: new Map([["lib/x.ts", new Map([[1, { fromStart: 3, fromEnd: 0 }]])]]),
      peek: { target, origin: { kind: "overview" } },
      back: [origin],
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 5 },
      top: { position: { file: "lib/x.ts", side: "additions", line: 2 } },
    };
    remember("e", "snap-e", [], expanded);
    expect(recall("e", "snap-e", [])).toEqual(expanded);
  });

  it("carries the view and input mode over a refresh, and positions in hunks it kept exactly", () => {
    // x.ts's hunk covers old lines 8-10 and new lines 8-11.
    const wide = hunk("lib/x.ts", "x1", "@@ -8,3 +8,4 @@\n c8\n-a\n+b\n+b2\n c10");
    const deep: ReadingPlace = {
      ...placeAt("lib", "lib/x.ts"),
      inputMode: "mouse",
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 10 },
      opened: new Map([["lib/x.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      top: { position: { file: "lib/x.ts", side: "deletions", line: 9 } },
    };
    remember("d", "old", [wide, y], deep);
    // Only y.ts changed: x.ts reads the same, so the reader is where they were.
    const yChanged = { ...y, patch: "@@ -3 +3 @@\n-c\n+e" };
    expect(recall("d", "new", [wide, yChanged])).toEqual(deep);
    // x.ts's hunk survived but moved, a line on the old side and two on the new: the cursor and
    // the top move with it. Its hidden ranges were renumbered, so their opened lines are not kept.
    const header = "@@ -9,3 +10,4 @@";
    const moved = { ...wide, header, patch: wide.patch.replace("@@ -8,3 +8,4 @@", header) };
    expect(recall("d", "new", [moved, y])).toEqual({
      ...deep,
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map(),
      top: { position: { file: "lib/x.ts", side: "deletions", line: 10 } },
    });
    // A changed hunk, or a line outside every hunk, keeps nothing to stand on: the file's top.
    const edited = hunk("lib/x.ts", "x2", "@@ -8,3 +8,4 @@\n c8\n-a\n+B\n+b2\n c10");
    const fileTop = { ...placeAt("lib", "lib/x.ts"), inputMode: "mouse" as const };
    expect(recall("d", "new", [edited, y])).toEqual(fileTop);
    remember("d", "old", [wide, y], {
      ...deep,
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 20 },
      top: { position: { file: "lib/x.ts", side: "additions", line: 30 } },
    });
    expect(recall("d", "new", [moved, y])).toEqual(fileTop);
    // A cursor on the file's header stays while the file has changes.
    const onHeader: Cursor = { file: "lib/x.ts", kind: "header", side: "additions" };
    remember("d", "old", [wide, y], { ...deep, cursor: onHeader });
    expect(recall("d", "new", [edited, y])).toEqual({ ...fileTop, cursor: onHeader });
    expect(recall("d", "new", [y])).toEqual({ ...fileTop, cursor: undefined });
    // An overview at the top is kept as the panel's offset.
    const overview: ReadingPlace = { ...placeAt("", undefined), top: { scrollTop: 40 } };
    remember("d", "new", [x], overview);
    expect(recall("d", "newer", [moved])).toEqual(overview);
  });
});
