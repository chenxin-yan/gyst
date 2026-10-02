// Pure pieces of the session reader: captured hunks and pages in, @pierre/diffs inputs and tree
// structure out. No React or DOM here, so each is unit tested on its own.
import type { CodePayload, ContentSide, Hunk, ManifestFile } from "@gyst/core/wire";
import { type FileDiffLoadedChangedFiles, type FileDiffMetadata, processFile } from "@pierre/diffs";

// ─── changed files ───────────────────────────────────────────────────────

/** A file the reader shows: its captured hunks, and its manifest entry once a files page has it. */
export type ReaderFile = {
  path: string;
  hunks: readonly Hunk[];
  manifest: ManifestFile | undefined;
};

const sameSide = (old: ContentSide, current: ContentSide) =>
  old.kind === current.kind &&
  (old.kind !== "text" || (current.kind === "text" && old.blob === current.blob)) &&
  (old.kind !== "unavailable" || (current.kind === "unavailable" && old.reason === current.reason));

/**
 * Whether a manifest entry records a change without hunks: an unavailable side, an added or
 * deleted non-text file, a rename or a mode change. Two unavailable sides with the same reason
 * carry no evidence of a change (their bytes are not captured), so they read as unchanged.
 */
const changedWithoutHunks = (file: ManifestFile) =>
  !sameSide(file.old, file.new) || file.renamedFrom !== undefined || file.modeChange !== undefined;

/**
 * Every file with hunks, plus every loaded manifest entry that changed without any, in path
 * order. Files with hunks keep their manifest entry when a loaded page has it.
 */
export function changedFiles(
  hunks: readonly Hunk[],
  manifest: readonly ManifestFile[],
): ReaderFile[] {
  const byPath = new Map(manifest.map((file) => [file.path, file]));
  const files = new Map<string, ReaderFile>();
  for (const [path, fileHunks] of Map.groupBy(hunks, (hunk) => hunk.file))
    files.set(path, { path, hunks: fileHunks, manifest: byPath.get(path) });
  for (const file of manifest)
    if (!files.has(file.path) && changedWithoutHunks(file))
      files.set(file.path, { path: file.path, hunks: [], manifest: file });
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A changed file's status letter. Added and deleted come from the manifest's absent sides once a
 * files page has the entry: an existing file emptied or filled has the same hunk headers as a
 * deletion or an addition. Until then a lone hunk's header is the only evidence.
 */
export function statusOf({ hunks, manifest }: ReaderFile): "A" | "D" | "M" | "R" {
  if (manifest !== undefined) {
    if (manifest.renamedFrom !== undefined) return "R";
    if (manifest.old.kind === "absent") return "A";
    if (manifest.new.kind === "absent") return "D";
    return "M";
  }
  const [first] = hunks;
  if (first !== undefined && hunks.length === 1) {
    if (first.header.startsWith("@@ -0,0 ")) return "A";
    if (first.header.includes(" +0,0 @@")) return "D";
  }
  return "M";
}

/** Added and removed line counts over a file's hunks. */
export function lineStats(hunks: readonly Hunk[]) {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks)
    for (const line of hunk.patch.split("\n").slice(1)) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  return { added, removed };
}

// ─── renderer input ──────────────────────────────────────────────────────

/**
 * One file's captured hunks as partial @pierre/diffs metadata: exact line numbers and hidden-range
 * counts between hunks, with full contents loaded later through `loadDiffFiles`. A side with no
 * lines (absent or empty) makes the file new or deleted, which has no hidden context to load.
 * Build it once per snapshot: the renderer keys its hydration to this object's identity.
 */
export function fileDiffOf(path: string, hunks: readonly Hunk[]): FileDiffMetadata {
  // processFile reads its first section as file headers, so a placeholder pair precedes the hunks;
  // the real path is set afterwards, since Git quoting or spaces could confuse header parsing.
  const diff = processFile(`--- file\n+++ file\n${hunks.map((hunk) => hunk.patch).join("\n")}\n`, {
    isGitDiff: false,
    throwOnError: true,
  });
  if (diff === undefined) throw new Error(`no diff for ${path}`);
  diff.name = path;
  const [first] = diff.hunks;
  if (diff.hunks.length === 1 && first!.deletionStart === 0 && first!.deletionCount === 0)
    diff.type = "new";
  else if (diff.hunks.length === 1 && first!.additionStart === 0 && first!.additionCount === 0)
    diff.type = "deleted";
  return diff;
}

/** Why a side stopped paging: its file left the reader's window or selection. Not a failure to show. */
export class PagingStopped extends Error {}

/**
 * A captured side's full text, read a page at a time from the start: each page's text is the
 * exact bytes from its start, so the pages concatenate to the file. One page is in flight at a
 * time, and paging stops before the next page once `wanted` says no. A side without captured text
 * is an error here; callers only ask for sides that have hunks.
 */
export async function capturedText(
  readPage: (offset: number | undefined) => Promise<CodePayload>,
  wanted: () => boolean = () => true,
): Promise<string> {
  let text = "";
  let offset: number | undefined;
  do {
    if (offset !== undefined && !wanted()) throw new PagingStopped("the file left the window");
    const { content } = await readPage(offset);
    if (content.kind !== "text") throw new Error(`the captured side is ${content.kind}`);
    text += content.text;
    offset = content.next?.offset;
  } while (offset !== undefined);
  return text;
}

/**
 * Both captured sides of a changed file, read side by side. It settles only once both sides have
 * settled, a failed one included, so a file's reads all end before its load does.
 */
export async function capturedFiles(
  path: string,
  readPage: (side: "old" | "new", offset: number | undefined) => Promise<CodePayload>,
  wanted: () => boolean = () => true,
): Promise<FileDiffLoadedChangedFiles> {
  const [oldSide, newSide] = await Promise.allSettled(
    (["old", "new"] as const).map((side) =>
      capturedText((offset) => readPage(side, offset), wanted),
    ),
  );
  if (oldSide!.status === "rejected") throw oldSide!.reason;
  if (newSide!.status === "rejected") throw newSide!.reason;
  return {
    oldFile: { name: path, contents: oldSide!.value },
    newFile: { name: path, contents: newSide!.value },
  };
}

// ─── layout ──────────────────────────────────────────────────────────────

export type LayoutMode = "split" | "stacked" | "auto";

/** The diff's 12.5px JetBrains Mono advances 0.6em a column; auto splits at 120 columns. */
export const splitMinWidth = 120 * 7.5;

/** The layout shown for a chosen mode in a reading panel `width` pixels wide. */
export const layoutOf = (mode: LayoutMode, width: number): "split" | "stacked" =>
  mode !== "auto" ? mode : width >= splitMinWidth ? "split" : "stacked";

// ─── tree and selection ──────────────────────────────────────────────────

export type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

/**
 * Paths as a folder tree; each level lists folders first, then files, by name. A folder whose only
 * child is a folder merges with it into one row named `a/b`, as editors compact them.
 */
export function treeOf(paths: Iterable<string>): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeNode[]>([["", root]]);
  const childrenOf = (path: string): TreeNode[] => {
    let children = folders.get(path);
    if (children === undefined) {
      const slash = path.lastIndexOf("/");
      children = [];
      folders.set(path, children);
      childrenOf(path.slice(0, Math.max(slash, 0))).push({
        kind: "folder",
        name: path.slice(slash + 1),
        path,
        children,
      });
    }
    return children;
  };
  for (const path of new Set(paths)) {
    const slash = path.lastIndexOf("/");
    childrenOf(path.slice(0, Math.max(slash, 0))).push({
      kind: "file",
      name: path.slice(slash + 1),
      path,
    });
  }
  const order = (a: TreeNode, b: TreeNode) =>
    a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name < b.name ? -1 : 1;
  for (const children of folders.values()) children.sort(order);
  const compact = (node: TreeNode): TreeNode => {
    if (node.kind === "file") return node;
    let folder = node;
    while (folder.children.length === 1 && folder.children[0]!.kind === "folder") {
      const [only] = folder.children as [Extract<TreeNode, { kind: "folder" }>];
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    return { ...folder, children: folder.children.map(compact) };
  };
  return root.map(compact);
}

/** A tree node's React key: a deleted file and an added folder can share a path. */
export const treeKey = (node: TreeNode) => `${node.kind}:${node.path}`;

/** Whether `path` is the selected file or under the selected folder; "" selects everything. */
export const isUnder = (path: string, selection: string) =>
  selection === "" || path === selection || path.startsWith(`${selection}/`);
