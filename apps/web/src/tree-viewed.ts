// How the sidebar's trees show Viewed: fade when done. A row with nothing left to read fades and a
// viewed file carries ✓, so the files left to read are the only ones at full ink. Also the rows'
// paths, which a tree requires to be a file's or a folder's, never both.
import type { GitStatus, GitStatusEntry } from "@pierre/trees";

/** A changed file in one tree: its letter, and whether every hunk the tree counts is Viewed. */
export type FileMark = { letter: "A" | "D" | "M" | "R"; viewed: boolean };

const gitStatusOf = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
} as const satisfies Record<FileMark["letter"], GitStatus>;

/**
 * What a tree row says when focus reaches it: a file's path, status and Viewed, or a folder's path
 * (a directory's canonical path ends in "/").
 */
export const rowAnnouncement = (path: string, mark: FileMark | undefined) =>
  path.endsWith("/")
    ? `${path.slice(0, -1)}, folder`
    : `${path}, ${mark ? gitStatusOf[mark.letter] : "unchanged"}${mark?.viewed ? ", viewed" : ""}`;

/** The folders above `path`, each ending in "/", the tree's canonical form of a directory. */
export const foldersOf = (path: string) => {
  const folders: string[] = [];
  for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
    folders.push(`${path.slice(0, slash)}/`);
  return folders;
};

/**
 * A tree's row paths for the reader's paths, deduplicated, and the way between them. A snapshot can
 * delete a file and add a folder at its path, or the reverse, and a tree throws on a file whose path
 * is a folder's. Such a file's row takes zero-width spaces after its name, so it shows under the
 * same name beside the folder.
 */
export function treeRows(paths: readonly string[]) {
  const unique = new Set(paths);
  const folders = new Set([...unique].flatMap(foldersOf));
  const taken = new Set(unique);
  const rowOfPath = new Map<string, string>();
  for (const path of unique) {
    let row = path;
    while (folders.has(`${row}/`) || (row !== path && taken.has(row))) row += "\u200B";
    taken.add(row);
    rowOfPath.set(path, row);
  }
  const pathOfRow = new Map([...rowOfPath].map(([path, row]) => [row, path]));
  return {
    rows: [...rowOfPath.values()],
    rowOf: (path: string) => rowOfPath.get(path) ?? path,
    /** A folder's row, ending in "/", is its own path. */
    pathOf: (row: string) => pathOfRow.get(row) ?? row,
  };
}

/**
 * One tree's git statuses. Without Viewed (a standalone walkthrough) they are the real statuses,
 * whose letters sit in the git lane. With Viewed the status is the row's tone instead, since only a
 * status colours a row's name: a row with nothing left to read (a viewed or unchanged file, a
 * folder holding no unviewed file) is "ignored", themed faint, and every other row has no status,
 * themed at full ink. The letters then move to the row decoration.
 */
export function viewedStatuses(
  viewedShown: boolean,
  marks: ReadonlyMap<string, FileMark>,
  paths: readonly string[],
): GitStatusEntry[] {
  if (!viewedShown)
    return [...marks].map(([path, { letter }]) => ({ path, status: gitStatusOf[letter] }));
  // TODO: Tone rows through a per-row hook once https://github.com/pierrecomputer/pierre/issues/691
  // ships (at 1.0.0-beta.6 only a git status colours a row's name). The real statuses then keep
  // their letters in the git lane, and the "ignored" tone and the "\0" sentinel go.
  const left = new Set<string>();
  for (const [path, { viewed }] of marks)
    if (!viewed) for (const folder of foldersOf(path)) left.add(folder);
  const folders = new Set(paths.flatMap(foldersOf));
  return [
    ...paths.filter((path) => marks.get(path)?.viewed !== false),
    ...[...folders].filter((folder) => !left.has(folder)),
    // No row has this path (Git paths have no NUL). It keeps the git lane, which a tree only
    // draws while some status is set, so letters line up across trees with nothing faded.
    "\0",
  ].map((path) => ({ path, status: "ignored" }));
}
