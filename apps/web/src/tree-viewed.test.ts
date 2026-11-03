import { describe, expect, it } from "vite-plus/test";
import { type FileMark, rowAnnouncement, treeRows, viewedStatuses } from "./tree-viewed.ts";

const marks = new Map<string, FileMark>([
  ["src/a.ts", { letter: "M", viewed: true }],
  ["src/b.ts", { letter: "A", viewed: false }],
  ["lib/index.ts", { letter: "M", viewed: true }],
  ["test/index.ts", { letter: "M", viewed: false }],
]);
const paths = [...marks.keys(), "lib/c.ts", "README.md"];
const faded = (statuses: { path: string }[]) => statuses.map(({ path }) => path).toSorted();

describe("viewedStatuses", () => {
  it("fades what has nothing left to read, through the ignored status", () => {
    const statuses = viewedStatuses(true, marks, paths);
    expect(statuses.every(({ status }) => status === "ignored")).toBe(true);
    // Viewed and unchanged files, and the folder with no unviewed file; never src/ or test/.
    expect(faded(statuses)).toEqual(
      ["\0", "README.md", "lib/", "lib/c.ts", "lib/index.ts", "src/a.ts"].toSorted(),
    );
  });

  it("fades a folder only once every file under it is done, nested folders too", () => {
    const nested = new Map<string, FileMark>([
      ["a/b/c.ts", { letter: "M", viewed: false }],
      ["a/d.ts", { letter: "M", viewed: true }],
    ]);
    expect(faded(viewedStatuses(true, nested, [...nested.keys()]))).toEqual(["\0", "a/d.ts"]);
    nested.set("a/b/c.ts", { letter: "M", viewed: true });
    expect(faded(viewedStatuses(true, nested, [...nested.keys()]))).toEqual(
      ["\0", "a/", "a/b/", "a/b/c.ts", "a/d.ts"].toSorted(),
    );
  });

  it("keeps the real statuses without Viewed, as in a standalone walkthrough", () => {
    expect(viewedStatuses(false, marks, paths)).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
      { path: "lib/index.ts", status: "modified" },
      { path: "test/index.ts", status: "modified" },
    ]);
  });
});

describe("treeRows", () => {
  it("keeps a file deleted where a folder was added apart from that folder, under the same name", () => {
    const tree = treeRows(["src", "src/a.ts", "lib/b.ts", "src"]);
    expect(tree.rows).toEqual(["src\u200B", "src/a.ts", "lib/b.ts"]);
    expect(tree.rowOf("src")).toBe("src\u200B");
    expect(tree.pathOf("src\u200B")).toBe("src");
    expect(tree.rowOf("src/a.ts")).toBe("src/a.ts");
    expect(tree.pathOf("src/a.ts")).toBe("src/a.ts");
    // A folder's row ends in "/", and is no file's.
    expect(tree.pathOf("src/")).toBe("src/");
  });

  it("keeps the reverse too, a file added where a nested folder was deleted", () => {
    const tree = treeRows(["a/b/c.ts", "a/b"]);
    expect(tree.rows).toEqual(["a/b/c.ts", "a/b\u200B"]);
    expect(tree.pathOf("a/b\u200B")).toBe("a/b");
  });

  it("never gives a row a path another file already has", () => {
    const replaced = ["src", "src/a.ts", "src\u200B", "src\u200B/b.ts"];
    const tree = treeRows(replaced);
    expect(new Set(tree.rows).size).toBe(4);
    expect(tree.rows.map(tree.pathOf)).toEqual(replaced);
  });
});

describe("rowAnnouncement", () => {
  it("says a row's path, then a file's status and Viewed or that it is a folder", () => {
    expect(rowAnnouncement("src/a.ts", marks.get("src/a.ts"))).toBe("src/a.ts, modified, viewed");
    expect(rowAnnouncement("src/b.ts", marks.get("src/b.ts"))).toBe("src/b.ts, added");
    expect(rowAnnouncement("lib/c.ts", undefined)).toBe("lib/c.ts, unchanged");
    expect(rowAnnouncement("lib/", undefined)).toBe("lib, folder");
  });
});
