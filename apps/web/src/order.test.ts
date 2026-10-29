import type { FileTreeSortEntry } from "@pierre/trees";
import { describe, expect, it } from "vite-plus/test";
import { agentOrder } from "./order.ts";

const entry = (path: string): FileTreeSortEntry => {
  const isDirectory = path.endsWith("/");
  const segments = path.replace(/\/$/, "").split("/");
  return { path, segments, basename: segments.at(-1)!, depth: segments.length, isDirectory };
};

describe("agentOrder", () => {
  it("keeps files and folders where the agent's order first names them", () => {
    const order = ["test/retry.test.ts", "src/retry.ts", "README.md", "src/a/z.ts", "src/b.ts"];
    const sorted = order
      .toReversed()
      .map(entry)
      .toSorted(agentOrder(order))
      .map(({ path }) => path);
    // A folder groups its files, at the place of its first one.
    expect(sorted).toEqual([
      "test/retry.test.ts",
      "src/retry.ts",
      "src/a/z.ts",
      "src/b.ts",
      "README.md",
    ]);
  });

  it("places a folder entry where its first file is", () => {
    const order = ["test/a.ts", "README.md", "src/b.ts"];
    const sorted = ["src/", "README.md", "test/"]
      .map(entry)
      .toSorted(agentOrder(order))
      .map(({ path }) => path);
    expect(sorted).toEqual(["test/", "README.md", "src/"]);
  });
});
