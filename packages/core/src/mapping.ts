import type { ContentSide, ManifestFile } from "./content.ts";
import type { CodeRange, CodeSide } from "./guidance.ts";
import type { Hunk } from "./session.ts";

/** What line mapping reads from a snapshot: each file's side identities, and its hunks. */
export type SnapshotLines = {
  readonly files: readonly ManifestFile[];
  readonly hunks: readonly Hunk[];
};

const keyOf = (hunk: Hunk) => `${hunk.file}\0${hunk.contentHash}`;

/**
 * Each old hunk's exact counterpart among `fresh`, by old id: the same file and body (its header,
 * and so its line numbers, may differ), unambiguously. Duplicate bodies correspond only when the
 * whole duplicate set is unchanged; anything else (changed body or context, split, merge, rename,
 * another file) has none.
 */
export function matchHunks(old: readonly Hunk[], fresh: readonly Hunk[]): Map<string, Hunk> {
  const oldByMatch = Map.groupBy(old, keyOf);
  const freshByMatch = Map.groupBy(fresh, keyOf);
  const freshById = new Map(fresh.map((hunk) => [hunk.id, hunk]));
  const matches = new Map<string, Hunk>();
  for (const [key, olds] of oldByMatch) {
    const candidates = freshByMatch.get(key) ?? [];
    if (olds.length === 1 && candidates.length === 1) {
      matches.set(olds[0]!.id, candidates[0]!);
      continue;
    }
    // An exact ID is safe for duplicates only when none of its peers moved or vanished.
    if (olds.length < 2 || olds.length !== candidates.length) continue;
    const same = olds.map((hunk) => freshById.get(hunk.id));
    if (
      same.every(
        (hunk, index) => hunk?.file === olds[index]!.file && hunk.patch === olds[index]!.patch,
      )
    )
      for (const [index, hunk] of olds.entries()) matches.set(hunk.id, same[index]!);
  }
  return matches;
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const otherSide = (side: CodeSide): CodeSide => (side === "old" ? "new" : "old");

/** A hunk's first line on each side; an empty side starts after the line its header names. */
function startsOf(hunk: Hunk): Record<CodeSide, number> | undefined {
  const match = hunkHeader.exec(hunk.patch);
  if (!match) return undefined;
  const start = (line: string, count: string | undefined) => Number(line) + (count === "0" ? 1 : 0);
  return { old: start(match[1]!, match[2]), new: start(match[3]!, match[4]) };
}

/** Each body row's line on each side: context has both, a removal only old, an addition only new. */
function rowsOf(hunk: Hunk): { old?: number; new?: number }[] | undefined {
  const starts = startsOf(hunk);
  if (!starts) return undefined;
  let { old, new: current } = starts;
  const rows: { old?: number; new?: number }[] = [];
  for (const line of hunk.patch.split("\n").slice(1)) {
    if (line.startsWith("-")) rows.push({ old: old++ });
    else if (line.startsWith("+")) rows.push({ new: current++ });
    else if (line.startsWith(" ")) rows.push({ old: old++, new: current++ });
  }
  return rows;
}

type Located =
  | { readonly kind: "changed"; readonly hunk: Hunk; readonly offset: number }
  | { readonly kind: "unchanged"; readonly other: number };

/**
 * Where `line` of one side of a file sits in its diff: a changed line of a hunk, `offset` lines
 * after that hunk's first line on the side, or an unchanged line and the other side's line holding
 * the same text. `hunks` are the file's, in order.
 */
function locate(hunks: readonly Hunk[], side: CodeSide, line: number): Located | undefined {
  let delta = 0;
  for (const hunk of hunks) {
    const starts = startsOf(hunk);
    const rows = rowsOf(hunk);
    if (!starts || !rows) return undefined;
    if (line < starts[side]) break;
    const own = rows.filter((row) => row[side] !== undefined);
    const other = rows.filter((row) => row[otherSide(side)] !== undefined);
    if (line < starts[side] + own.length) {
      const row = own[line - starts[side]]!;
      const counterpart = row[otherSide(side)];
      return counterpart === undefined
        ? { kind: "changed", hunk, offset: line - starts[side] }
        : { kind: "unchanged", other: counterpart };
    }
    delta = starts[otherSide(side)] + other.length - (starts[side] + own.length);
  }
  return { kind: "unchanged", other: line + delta };
}

const sameContent = (a: ContentSide, b: ContentSide) =>
  a.kind === "text"
    ? b.kind === "text" && a.blob === b.blob
    : a.kind === "absent" && b.kind === "absent";

/**
 * `range`, read in `from`, as the same lines of `to`: every line must map, unchanged and
 * unambiguously, to one contiguous range of the same file and side. A side with identical bytes
 * maps to itself. Otherwise a changed line maps only inside its hunk's exact counterpart, and an
 * unchanged line only through the other side's identical bytes to an unchanged line of `to`. No
 * similarity, rename or cross-file matching: anything else is undefined.
 */
export function mapRange(
  from: SnapshotLines,
  to: SnapshotLines,
  range: CodeRange,
): CodeRange | undefined {
  const { path, side } = range;
  const before = from.files.find((file) => file.path === path);
  const after = to.files.find((file) => file.path === path);
  if (!before || !after || before[side].kind !== "text" || after[side].kind !== "text")
    return undefined;
  if (sameContent(before[side], after[side]))
    return { path, side, startLine: range.startLine, endLine: range.endLine };
  const fromHunks = from.hunks.filter((hunk) => hunk.file === path);
  const toHunks = to.hunks.filter((hunk) => hunk.file === path);
  const sameOther = sameContent(before[otherSide(side)], after[otherSide(side)]);
  const matches = matchHunks(fromHunks, toHunks);
  let startLine: number | undefined;
  let previous: number | undefined;
  for (let line = range.startLine; line <= range.endLine; line++) {
    const at = locate(fromHunks, side, line);
    let next: number | undefined;
    if (at?.kind === "changed") {
      const counterpart = matches.get(at.hunk.id);
      const starts = counterpart && startsOf(counterpart);
      next = starts && starts[side] + at.offset;
    } else if (at && sameOther) {
      const back = locate(toHunks, otherSide(side), at.other);
      next = back?.kind === "unchanged" ? back.other : undefined;
    }
    if (next === undefined || (previous !== undefined && next !== previous + 1)) return undefined;
    startLine ??= next;
    previous = next;
  }
  return { path, side, startLine: startLine!, endLine: previous! };
}
