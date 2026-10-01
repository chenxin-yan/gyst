import type { CodePayload, Hunk, ManifestFile } from "@gyst/core/wire";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  capturedFilesLoader,
  capturedText,
  changedFiles,
  fileDiffOf,
  isUnder,
  layoutOf,
  lineStats,
  splitMinWidth,
  statusOf,
  treeKey,
  treeOf,
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

describe("fileDiffOf", () => {
  it("keeps exact numbers and between-hunk hidden counts, and stays partial for loadDiffFiles", () => {
    const diff = fileDiffOf("src/a b.ts", [
      hunk("src/a b.ts", "@@ -2,3 +2,3 @@ fn\n one\n-two\n+TWO\n three"),
      hunk("src/a b.ts", "@@ -20,2 +20,3 @@\n x\n+y\n z"),
    ]);
    expect(diff.name).toBe("src/a b.ts");
    expect(diff.type).toBe("change");
    expect(diff.isPartial).toBe(true);
    expect(diff.hunks.map((h) => [h.deletionStart, h.additionStart, h.collapsedBefore])).toEqual([
      [2, 2, 1],
      [20, 20, 15],
    ]);
  });

  it("reads a side with no lines as a new or deleted file, which has nothing hidden to load", () => {
    expect(fileDiffOf("n.ts", [hunk("n.ts", "@@ -0,0 +1,2 @@\n+a\n+b")]).type).toBe("new");
    expect(fileDiffOf("d.ts", [hunk("d.ts", "@@ -1,2 +0,0 @@\n-a\n-b")]).type).toBe("deleted");
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
});

describe("capturedFilesLoader", () => {
  it("loads both sides once per path and retries a failed load", async () => {
    let fail = true;
    const read = vi.fn(async (_path: string, side: "old" | "new", _offset: number | undefined) => {
      if (fail) throw new Error("offline");
      return page(`${side}\n`, 0, null);
    });
    const load = capturedFilesLoader(read);
    await expect(load("a.ts")).rejects.toThrow("offline");
    fail = false;
    const files = await load("a.ts");
    expect(files).toEqual({
      oldFile: { name: "a.ts", contents: "old\n" },
      newFile: { name: "a.ts", contents: "new\n" },
    });
    expect(await load("a.ts")).toBe(files);
    expect(read.mock.calls.filter(([, , offset]) => offset === undefined)).toHaveLength(4);
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
