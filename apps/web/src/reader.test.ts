import type { CodePayload, Hunk, ManifestFile } from "@gyst/core/wire";
import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it, vi } from "vite-plus/test";
import { hiddenRanges } from "./cursor.ts";
import {
  capturedFiles,
  capturedText,
  changedFiles,
  fileDiffOf,
  isUnder,
  lateWholeFiles,
  layoutOf,
  lineStats,
  PagingStopped,
  splitMinWidth,
  statusOf,
  treeKey,
  treeOf,
  wholeFileType,
} from "./reader.ts";

const hunk = (file: string, patch: string): Hunk => ({
  id: `${file}:${patch}`,
  file,
  header: patch.split("\n")[0]!,
  patch,
  contentHash: "h",
});
const blob = (n: number) => String(n).repeat(64).slice(0, 64);
const text = (n: number) => ({ kind: "text", blob: blob(n), size: 1 }) as const;
const sides = (oldText: string, newText: string) => ({
  oldFile: { name: "a.ts", contents: oldText },
  newFile: { name: "a.ts", contents: newText },
});

describe("fileDiffOf", () => {
  it("keeps exact numbers and between-hunk hidden counts, and stays partial for loadDiffFiles", () => {
    const diff = fileDiffOf({
      path: "src/a b.ts",
      hunks: [
        hunk("src/a b.ts", "@@ -2,3 +2,3 @@ fn\n one\n-two\n+TWO\n three"),
        hunk("src/a b.ts", "@@ -20,2 +20,3 @@\n x\n+y\n z"),
      ],
      manifest: undefined,
    });
    expect(diff.name).toBe("src/a b.ts");
    expect(diff.type).toBe("change");
    expect(diff.isPartial).toBe(true);
    expect(diff.hunks.map((h) => [h.deletionStart, h.additionStart, h.collapsedBefore])).toEqual([
      [2, 2, 1],
      [20, 20, 15],
    ]);
  });

  const sized = (n: number, size: number) => ({ kind: "text", blob: blob(n), size }) as const;
  const diffOf = (patch: string, old: ManifestFile["old"], current: ManifestFile["new"]) =>
    fileDiffOf({
      path: "a.ts",
      hunks: [hunk("a.ts", patch)],
      manifest: { path: "a.ts", old, new: current },
    });

  it("reads a side the manifest records with no lines as a new or deleted file", () => {
    const added = "@@ -0,0 +1,2 @@\n+a\n+b";
    const removed = "@@ -1,2 +0,0 @@\n-a\n-b";
    expect(diffOf(added, { kind: "absent" }, sized(1, 4)).type).toBe("new");
    expect(diffOf(removed, sized(1, 4), { kind: "absent" }).type).toBe("deleted");
    // An existing file filled or emptied has no lines on that side either.
    expect(diffOf(added, sized(0, 0), sized(1, 4)).type).toBe("new");
    expect(diffOf(removed, sized(1, 4), sized(0, 0)).type).toBe("deleted");
  });

  it("keeps a zero-context edit at the top of a nonempty file a change that loads its tail", () => {
    const inserted = diffOf("@@ -0,0 +1 @@\n+inserted", sized(1, 8), sized(2, 17));
    expect(inserted.type).toBe("change");
    const insertedLoaded = hydratePartialDiff(
      "clone",
      inserted,
      sides("one\ntwo\n", "inserted\none\ntwo\n"),
    );
    expect(insertedLoaded.additionLines).toEqual(["inserted\n", "one\n", "two\n"]);
    expect(insertedLoaded.deletionLines).toEqual(["one\n", "two\n"]);
    expect(hiddenRanges(insertedLoaded)).toEqual([{ index: 1, old: 1, new: 2, size: 2 }]);
    const deleted = diffOf("@@ -1 +0,0 @@\n-removed", sized(1, 16), sized(2, 8));
    expect(deleted.type).toBe("change");
    const deletedLoaded = hydratePartialDiff(
      "clone",
      deleted,
      sides("removed\none\ntwo\n", "one\ntwo\n"),
    );
    expect(deletedLoaded.deletionLines).toEqual(["removed\n", "one\n", "two\n"]);
    expect(deletedLoaded.additionLines).toEqual(["one\n", "two\n"]);
    expect(hiddenRanges(deletedLoaded)).toEqual([{ index: 1, old: 2, new: 1, size: 2 }]);
  });

  it("reads a file as a change until a files page has its entry, then builds it again", () => {
    const hunks = [
      hunk("m.ts", "@@ -1 +1 @@\n-a\n+b"),
      hunk("n.ts", "@@ -0,0 +1,2 @@\n+a\n+b"),
      hunk("x.ts", "@@ -1,2 +0,0 @@\n-a\n-b"),
    ];
    const entries: ManifestFile[] = [
      { path: "m.ts", old: text(1), new: text(2) },
      { path: "n.ts", old: { kind: "absent" }, new: text(1) },
      { path: "x.ts", old: text(1), new: { kind: "absent" } },
    ];
    const before = changedFiles(hunks, []);
    expect(before.map((file) => wholeFileType(file.manifest))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const diffs = new Map(before.map((file) => [file.path, fileDiffOf(file)]));
    expect([...diffs.values()].map((diff) => diff.type)).toEqual(["change", "change", "change"]);
    // A diff the renderer already hydrated as a change is rebuilt too.
    diffs.set("x.ts", hydratePartialDiff("clone", diffs.get("x.ts")!, sides("a\nb\n", "")));
    const after = changedFiles(hunks, entries);
    expect(lateWholeFiles(before, diffs)).toEqual([]);
    const late = lateWholeFiles(after, diffs);
    expect(late.map((file) => file.path)).toEqual(["n.ts", "x.ts"]);
    for (const file of late) diffs.set(file.path, fileDiffOf(file));
    expect([...diffs.values()].map((diff) => diff.type)).toEqual(["change", "new", "deleted"]);
    expect(lateWholeFiles(after, diffs)).toEqual([]);
  });

  it("loads a new or deleted file shown as a change before its files page with an empty side", async () => {
    const read = (absent: "old" | "new") => async (side: "old" | "new") =>
      side === absent
        ? { ...page("", 0, null), content: { kind: "absent" } as const }
        : page("a\nb\n", 0, null);
    const added = fileDiffOf({
      path: "a.ts",
      hunks: [hunk("a.ts", "@@ -0,0 +1,2 @@\n+a\n+b")],
      manifest: undefined,
    });
    expect(added.type).toBe("change");
    const addedLoaded = hydratePartialDiff(
      "clone",
      added,
      await capturedFiles("a.ts", read("old")),
    );
    expect([addedLoaded.deletionLines, addedLoaded.additionLines]).toEqual([[], ["a\n", "b\n"]]);
    expect(hiddenRanges(addedLoaded)).toEqual([]);
    const deleted = fileDiffOf({
      path: "a.ts",
      hunks: [hunk("a.ts", "@@ -1,2 +0,0 @@\n-a\n-b")],
      manifest: undefined,
    });
    expect(deleted.type).toBe("change");
    const deletedLoaded = hydratePartialDiff(
      "clone",
      deleted,
      await capturedFiles("a.ts", read("new")),
    );
    expect([deletedLoaded.deletionLines, deletedLoaded.additionLines]).toEqual([
      ["a\n", "b\n"],
      [],
    ]);
    expect(hiddenRanges(deletedLoaded)).toEqual([]);
  });
});

describe("changedFiles", () => {
  it("lists files with hunks and loaded entries that changed without hunks, in path order", () => {
    const manifest: ManifestFile[] = [
      { path: "a.ts", old: text(1), new: text(2) },
      { path: "logo.bin", old: { kind: "absent" }, new: { kind: "unavailable", reason: "binary" } },
      {
        path: "same.bin",
        old: { kind: "unavailable", reason: "binary" },
        new: { kind: "unavailable", reason: "binary" },
      },
      { path: "same.ts", old: text(3), new: text(3) },
      { path: "run.sh", old: text(4), new: text(4), modeChange: { old: "100644", new: "100755" } },
    ];
    const files = changedFiles(
      [hunk("z.ts", "@@ -1 +1 @@\n-a\n+b"), hunk("a.ts", "@@ -1 +1 @@\n-a\n+b")],
      manifest,
    );
    expect(files.map((file) => [file.path, file.hunks.length, file.manifest?.path])).toEqual([
      ["a.ts", 1, "a.ts"],
      ["logo.bin", 0, "logo.bin"],
      ["run.sh", 0, "run.sh"],
      ["z.ts", 1, undefined],
    ]);
  });

  it("marks added and deleted by the manifest's absent sides, not by an emptied or filled file's hunk", () => {
    const filled = hunk("a.ts", "@@ -0,0 +1,2 @@\n+a\n+b");
    const emptied = hunk("a.ts", "@@ -1,2 +0,0 @@\n-a\n-b");
    const empty = { kind: "text", blob: blob(0), size: 0 } as const;
    const status = (hunks: Hunk[], manifest?: ManifestFile) =>
      statusOf({ path: "a.ts", hunks, manifest });
    expect(status([filled], { path: "a.ts", old: empty, new: text(1) })).toBe("M");
    expect(status([emptied], { path: "a.ts", old: text(1), new: empty })).toBe("M");
    expect(status([filled], { path: "a.ts", old: { kind: "absent" }, new: text(1) })).toBe("A");
    expect(status([emptied], { path: "a.ts", old: text(1), new: { kind: "absent" } })).toBe("D");
    // Before a files page has the entry, a lone hunk's header is the only evidence.
    expect(status([filled])).toBe("A");
    expect(status([emptied])).toBe("D");
  });

  it("counts added and removed lines", () => {
    expect(
      lineStats([hunk("a", "@@ -1,2 +1,2 @@\n-a\n+b\n+c\n d\n\\ No newline at end of file")]),
    ).toEqual({
      added: 2,
      removed: 1,
    });
  });
});

const page = (text: string, start: number, next: number | null): CodePayload => ({
  sessionId: "s",
  snapshotId: blob(9),
  file: "a.ts",
  side: "old",
  content: {
    kind: "text",
    size: 7,
    start: { line: 1, offset: start },
    text,
    next: next === null ? null : { line: 2, offset: next },
  },
});

describe("capturedText", () => {
  it("concatenates pages by byte-offset continuation", async () => {
    const read = vi.fn(async (offset: number | undefined) =>
      offset === undefined ? page("one\nt", 0, 5) : page("wo\n", 5, null),
    );
    expect(await capturedText(read)).toBe("one\ntwo\n");
    expect(read.mock.calls).toEqual([[undefined], [5]]);
  });

  it("refuses a side without captured text instead of inventing content", async () => {
    const unavailable = {
      ...page("", 0, null),
      content: { kind: "unavailable", reason: "binary" },
    } as const;
    await expect(capturedText(async () => unavailable)).rejects.toThrow("unavailable");
  });

  it("reads an absent side as empty", async () => {
    const absent = { ...page("", 0, null), content: { kind: "absent" } } as const;
    expect(await capturedText(async () => absent)).toBe("");
  });
});

describe("capturedFiles", () => {
  it("reads both sides of a file", async () => {
    const read = vi.fn(async (side: "old" | "new", _offset: number | undefined) =>
      page(`${side}\n`, 0, null),
    );
    expect(await capturedFiles("a.ts", read)).toEqual({
      oldFile: { name: "a.ts", contents: "old\n" },
      newFile: { name: "a.ts", contents: "new\n" },
    });
  });

  it("reads an absent side as empty and still refuses an unavailable one", async () => {
    const absent = { ...page("", 0, null), content: { kind: "absent" } } as const;
    const unavailable = {
      ...page("", 0, null),
      content: { kind: "unavailable", reason: "binary" },
    } as const;
    expect(
      await capturedFiles("a.ts", async (side) =>
        side === "old" ? absent : page("new\n", 0, null),
      ),
    ).toEqual({
      oldFile: { name: "a.ts", contents: "" },
      newFile: { name: "a.ts", contents: "new\n" },
    });
    await expect(
      capturedFiles("a.ts", async (side) => (side === "old" ? absent : unavailable)),
    ).rejects.toThrow("unavailable");
  });

  it("stops paging a file that left the window", async () => {
    const read = vi.fn(async (_side: "old" | "new", offset: number | undefined) =>
      offset === undefined ? page("one\n", 0, 4) : page("two\n", 4, null),
    );
    await expect(capturedFiles("a.ts", read, () => false)).rejects.toBeInstanceOf(PagingStopped);
    // Only each side's first page was read; the second never was.
    expect(read.mock.calls.map(([side, offset]) => `${side} ${offset}`).sort()).toEqual([
      "new undefined",
      "old undefined",
    ]);
  });

  it("settles a one-sided failure only once the other side has settled", async () => {
    let finish = () => {};
    const read = (side: "old" | "new") =>
      side === "old"
        ? Promise.reject(new Error("offline"))
        : new Promise<CodePayload>((resolve) => (finish = () => resolve(page("new\n", 0, null))));
    let settled = false;
    const files = capturedFiles("a.ts", read).finally(() => (settled = true));
    files.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve));
    expect(settled).toBe(false);
    finish();
    await expect(files).rejects.toThrow("offline");
  });
});

describe("layoutOf", () => {
  it("splits in auto from 120 columns of available width; explicit choices win", () => {
    expect(layoutOf("auto", splitMinWidth)).toBe("split");
    expect(layoutOf("auto", splitMinWidth - 1)).toBe("stacked");
    expect(layoutOf("auto", 350)).toBe("stacked");
    expect(layoutOf("split", 350)).toBe("split");
    expect(layoutOf("stacked", 2000)).toBe("stacked");
  });
});

describe("treeOf and isUnder", () => {
  it("compacts single-folder chains into one row", () => {
    expect(treeOf(["packages/core/src/a.ts", "packages/core/src/b/c.ts", "x.ts"])).toEqual([
      {
        kind: "folder",
        name: "packages/core/src",
        path: "packages/core/src",
        children: [
          {
            kind: "folder",
            name: "b",
            path: "packages/core/src/b",
            children: [{ kind: "file", name: "c.ts", path: "packages/core/src/b/c.ts" }],
          },
          { kind: "file", name: "a.ts", path: "packages/core/src/a.ts" },
        ],
      },
      { kind: "file", name: "x.ts", path: "x.ts" },
    ]);
  });

  it("nests paths with folders first, by name", () => {
    expect(treeOf(["b.ts", "src/z.ts", "src/lib/a.ts", "a.ts", "src/b.ts", "a.ts"])).toEqual([
      {
        kind: "folder",
        name: "src",
        path: "src",
        children: [
          {
            kind: "folder",
            name: "lib",
            path: "src/lib",
            children: [{ kind: "file", name: "a.ts", path: "src/lib/a.ts" }],
          },
          { kind: "file", name: "b.ts", path: "src/b.ts" },
          { kind: "file", name: "z.ts", path: "src/z.ts" },
        ],
      },
      { kind: "file", name: "a.ts", path: "a.ts" },
      { kind: "file", name: "b.ts", path: "b.ts" },
    ]);
  });

  it("keys a deleted file and an added folder at the same path apart", () => {
    const nodes = treeOf(["src", "src/a.ts"]);
    expect(nodes.map((node) => [node.kind, node.path])).toEqual([
      ["folder", "src"],
      ["file", "src"],
    ]);
    expect(new Set(nodes.map(treeKey)).size).toBe(2);
  });

  it("selects a file, a folder's descendants or everything", () => {
    expect(isUnder("src/a.ts", "")).toBe(true);
    expect(isUnder("src/a.ts", "src")).toBe(true);
    expect(isUnder("src/a.ts", "src/a.ts")).toBe(true);
    expect(isUnder("srcx/a.ts", "src")).toBe(false);
    expect(isUnder("src", "src/a.ts")).toBe(false);
  });
});
