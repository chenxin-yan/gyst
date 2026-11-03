// The order of a walkthrough group's files in its sidebar tree: the agent's, within each folder.
import type { FileTreeSortComparator, FileTreeSortEntry } from "@pierre/trees";

const keyOf = (segments: readonly string[], depth: number, folder: boolean) =>
  segments.slice(0, depth).join("/") + (folder || depth < segments.length ? "/" : "");

/**
 * Siblings in the order of the given paths: a folder where its first file is, a file where it is.
 * The tree's comparator sees whole paths, so it compares them at their first differing segment.
 */
export function agentOrder(paths: readonly string[]): FileTreeSortComparator {
  const rank = new Map<string, number>();
  paths.forEach((path, index) => {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
      const key = keyOf(segments, depth, false);
      if (!rank.has(key)) rank.set(key, index);
    }
  });
  const rankAt = ({ segments, isDirectory }: FileTreeSortEntry, depth: number) =>
    rank.get(keyOf(segments, depth, isDirectory)) ?? Number.MAX_SAFE_INTEGER;
  return (left, right) => {
    const deepest = Math.max(left.segments.length, right.segments.length);
    let depth = 1;
    while (depth < deepest && left.segments[depth - 1] === right.segments[depth - 1]) depth++;
    return rankAt(left, depth) - rankAt(right, depth);
  };
}
