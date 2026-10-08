import type { CapturedRange, Hunk } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import type { Cursor } from "./cursor.ts";
import type { Place } from "./navigation.ts";
import { type ReadingPlace, recall, remember, viewKey } from "./reading-memory.ts";

const placeAt = (path: string, file: string | undefined): ReadingPlace => ({
  review: { kind: "files", path },
  captured: undefined,
  expandedOpened: new Map(),
  peek: undefined,
  back: [],
  inputMode: "vim",
  cursor: undefined,
  opened: new Map(),
  folds: new Map([[viewKey({ kind: "files", path }), new Set()]]),
  expandedFolded: new Set(),
  author: { shown: false, commits: undefined },
  top: file === undefined ? undefined : { position: { file, side: undefined, line: undefined } },
});

const hunk = (file: string, id: string, patch: string): Hunk => ({
  id,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: id,
});
const none: ReadonlySet<string> = new Set();
const x = hunk("lib/x.ts", "x1", "@@ -9 +9 @@\n-a\n+b");
const y = hunk("lib/y.ts", "y1", "@@ -3 +3 @@\n-c\n+d");

describe("reading memory", () => {
  it("keeps each session's place apart, so switching sessions resumes each where it was left", () => {
    const b: ReadingPlace = {
      ...placeAt("src", undefined),
      inputMode: "mouse",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map([["src/b.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      folds: new Map([["files:src", new Set(["src/a.ts"])]]),
      top: { position: { file: "src/b.ts", side: "additions", line: 9 } },
    };
    remember("b", "snap-b", [], b);
    remember("c", "snap-c", [], placeAt("", "c.ts"));
    expect(recall("b", "snap-b", [], none)).toEqual(b);
    expect(recall("c", "snap-c", [], none)).toEqual(placeAt("", "c.ts"));
    expect(recall("a", "snap-b", [], none)).toBeUndefined();
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
      peek: { kind: "reference", target, origin: { kind: "note", noteId: "span" } },
    };
    const expanded: ReadingPlace = {
      ...placeAt("", undefined),
      review: origin.review,
      captured: target,
      expandedOpened: new Map([["lib/x.ts", new Map([[1, { fromStart: 3, fromEnd: 0 }]])]]),
      expandedFolded: new Set(["lib/x.ts"]),
      peek: { kind: "reference", target, origin: { kind: "overview" } },
      back: [origin],
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 5 },
      top: { position: { file: "lib/x.ts", side: "additions", line: 2 } },
    };
    remember("e", "snap-e", [], expanded);
    expect(recall("e", "snap-e", [], none)).toEqual(expanded);
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
    expect(recall("d", "new", [wide, yChanged], none)).toEqual(deep);
    // x.ts's hunk survived but moved, a line on the old side and two on the new: the cursor and
    // the top move with it. Its hidden ranges were renumbered, so their opened lines are not kept.
    const header = "@@ -9,3 +10,4 @@";
    const moved = { ...wide, header, patch: wide.patch.replace("@@ -8,3 +8,4 @@", header) };
    const shifted = {
      ...deep,
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map(),
      top: { position: { file: "lib/x.ts", side: "deletions", line: 10 } },
    } satisfies ReadingPlace;
    expect(recall("d", "new", [moved, y], none)).toEqual(shifted);
    // A Generated file the reader is inside stays unfolded, so the place is there to return to;
    // another view it was open in folds it.
    const xGenerated = new Set(["lib/x.ts"]);
    expect(recall("d", "new", [moved, y], xGenerated)).toEqual(shifted);
    remember("d", "old", [wide, y], {
      ...deep,
      folds: new Map([...deep.folds, ["group:core", new Set<string>()]]),
    });
    expect(recall("d", "new", [moved, y], xGenerated)?.folds).toEqual(
      new Map([
        ["files:lib", new Set()],
        ["group:core", xGenerated],
      ]),
    );
    remember("d", "old", [wide, y], deep);
    // A changed hunk, or a line outside every hunk, keeps nothing to stand on: the file's top.
    const edited = hunk("lib/x.ts", "x2", "@@ -8,3 +8,4 @@\n c8\n-a\n+B\n+b2\n c10");
    const fileTop = { ...placeAt("lib", "lib/x.ts"), inputMode: "mouse" as const };
    expect(recall("d", "new", [edited, y], none)).toEqual(fileTop);
    expect(recall("d", "new", [edited, y], xGenerated)).toEqual({
      ...fileTop,
      folds: new Map([["files:lib", xGenerated]]),
    });
    remember("d", "old", [wide, y], {
      ...deep,
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 20 },
      top: { position: { file: "lib/x.ts", side: "additions", line: 30 } },
    });
    expect(recall("d", "new", [moved, y], none)).toEqual(fileTop);
    // A cursor on the file's header stays while the file has changes.
    const onHeader: Cursor = { file: "lib/x.ts", kind: "header", side: "additions" };
    remember("d", "old", [wide, y], { ...deep, cursor: onHeader });
    expect(recall("d", "new", [edited, y], none)).toEqual({ ...fileTop, cursor: onHeader });
    expect(recall("d", "new", [y], none)).toEqual({ ...fileTop, cursor: undefined });
    // An overview at the top is kept as the panel's offset.
    const overview: ReadingPlace = { ...placeAt("", undefined), top: { scrollTop: 40 } };
    remember("d", "new", [x], overview);
    expect(recall("d", "newer", [moved], none)).toEqual(overview);
  });

  it("keeps the author's explanation shown with its read commits for the same snapshot, and not past a refresh", () => {
    const commits = {
      commits: [{ id: "a".repeat(40), message: "Why" }],
      total: 2,
      next: "a".repeat(40),
    };
    const reading: ReadingPlace = {
      ...placeAt("", undefined),
      author: { shown: true, commits },
      top: { scrollTop: 650 },
    };
    remember("g", "old", [x], reading);
    expect(recall("g", "old", [x], none)).toEqual(reading);
    // The offset was into the explanation, which the refreshed reader starts without.
    expect(recall("g", "new", [x], none)).toEqual(placeAt("", undefined));
    const inFile: ReadingPlace = { ...placeAt("", "lib/x.ts"), author: { shown: true, commits } };
    remember("g", "old", [x], inFile);
    expect(recall("g", "new", [x], none)).toEqual(placeAt("", "lib/x.ts"));
  });

  it("keeps a refresh's unchanged files folded as the reader left them in each view, and folds changed Generated ones", () => {
    const z = hunk("dist/z.js", "z1", "@@ -1 +1 @@\n-e\n+f");
    const w = hunk("dist/w.js", "w1", "@@ -1 +1 @@\n-g\n+h");
    // In All changes the reader unfolded Generated z.js and folded x.ts; y.ts and w.js are open.
    // In the core group only z.js is folded.
    remember("f", "old", [x, y, z, w], {
      ...placeAt("", undefined),
      folds: new Map([
        ["files:", new Set(["lib/x.ts"])],
        ["group:core", new Set(["dist/z.js"])],
      ]),
    });
    // z.js still reads the same, so it stays as each view left it; w.js changed and is Generated
    // now, so it folds in both.
    const wChanged = { ...w, patch: "@@ -1 +1 @@\n-g\n+i" };
    const generated = new Set(["dist/z.js", "dist/w.js"]);
    expect(recall("f", "new", [x, y, z, wChanged], generated)?.folds).toEqual(
      new Map([
        ["files:", new Set(["lib/x.ts", "dist/w.js"])],
        ["group:core", new Set(["dist/z.js", "dist/w.js"])],
      ]),
    );
    // A folded file whose diff changed takes the new snapshot's default: not Generated, unfolded.
    const xChanged = { ...x, patch: "@@ -9 +9 @@\n-a\n+c" };
    expect(recall("f", "new", [xChanged, y, z, w], none)?.folds).toEqual(
      new Map([
        ["files:", new Set()],
        ["group:core", new Set(["dist/z.js"])],
      ]),
    );
    // A view the reader was in but never folded in starts from the Generated files, but one
    // holding the reader's line stays open.
    remember("f", "old", [x, y, z, w], {
      ...placeAt("", "dist/w.js"),
      folds: new Map(),
      top: { position: { file: "dist/w.js", side: "additions", line: 1 } },
    });
    expect(recall("f", "new", [x, y, z, wChanged], generated)?.folds).toEqual(
      new Map([["files:", new Set(["dist/z.js"])]]),
    );
    // Only Generated flags changed: x.ts became Generated and z.js stopped, with the cursor in
    // x.ts. Every file reads the same, so each stays as the reader saw it.
    const cursor = { file: "lib/x.ts", kind: "line", side: "additions", line: 9 } as const;
    remember("f", "old", [x, y, z, w], {
      ...placeAt("", undefined),
      cursor,
      folds: new Map([["files:", new Set(["dist/z.js"])]]),
    });
    const flagsOnly = recall("f", "new", [x, y, z, w], new Set(["lib/x.ts"]));
    expect(flagsOnly?.cursor).toEqual(cursor);
    expect(flagsOnly?.folds).toEqual(new Map([["files:", new Set(["dist/z.js"])]]));
  });

  it("opens the file holding the reader's line after a refresh from an expanded reference, though its view had it folded", () => {
    const z = hunk("dist/z.js", "z1", "@@ -1 +1 @@\n-e\n+f");
    // The reader expanded a reference into z.js, which All changes and the core group both fold.
    const cursor = { file: "dist/z.js", kind: "line", side: "additions", line: 1 } as const;
    remember("g", "old", [x, y, z], {
      ...placeAt("", undefined),
      captured: { snapshotId: "old", path: "dist/z.js", side: "new", startLine: 1, endLine: 1 },
      cursor,
      folds: new Map([
        ["files:", new Set(["dist/z.js"])],
        ["group:core", new Set(["dist/z.js"])],
      ]),
      top: { position: { file: "dist/z.js", side: "additions", line: 1 } },
    });
    // y.ts changed, z.js reads the same: the refresh drops the reference and keeps the line, so
    // the view it returns to must show z.js. The core group, where the reader isn't, keeps its fold.
    const yChanged = { ...y, patch: "@@ -3 +3 @@\n-c\n+e" };
    const after = recall("g", "new", [x, yChanged, z], new Set(["dist/z.js"]));
    expect(after?.captured).toBeUndefined();
    expect(after?.cursor).toEqual(cursor);
    expect(after?.folds).toEqual(
      new Map([
        ["files:", new Set()],
        ["group:core", new Set(["dist/z.js"])],
      ]),
    );
  });
});
