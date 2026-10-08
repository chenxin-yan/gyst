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

/**
 * One body row: its line on each side (context has both, a removal only old, an addition only new)
 * and its text, a missing final newline included.
 */
type Row = { old?: number; new?: number; text: string };
type ParsedHunk = Hunk & { readonly starts: Record<CodeSide, number>; readonly rows: Row[] };

function parse(hunk: Hunk): ParsedHunk | undefined {
  const starts = startsOf(hunk);
  if (!starts) return undefined;
  let { old, new: current } = starts;
  const rows: Row[] = [];
  for (const line of hunk.patch.split("\n").slice(1)) {
    const text = line.slice(1);
    if (line.startsWith("-")) rows.push({ old: old++, text });
    else if (line.startsWith("+")) rows.push({ new: current++, text });
    else if (line.startsWith(" ")) rows.push({ old: old++, new: current++, text });
    else if (line.startsWith("\\") && rows.length > 0) rows.at(-1)!.text += `\n${line}`;
  }
  return { ...hunk, starts, rows };
}

type Located = {
  /** The hunk holding the line, how many lines after its first line on the side, and its row. */
  readonly within?: { readonly hunk: ParsedHunk; readonly offset: number; readonly row: Row };
  /** For an unchanged line, the other side's line holding the same text. */
  readonly other: number | undefined;
};

/**
 * Where `line` of one side of a file sits in its diff: inside a hunk, as a changed or a context
 * line, or between hunks. `hunks` are the file's, in order.
 */
function locate(hunks: readonly ParsedHunk[], side: CodeSide, line: number): Located {
  let delta = 0;
  for (const hunk of hunks) {
    const { starts, rows } = hunk;
    if (line < starts[side]) break;
    const own = rows.filter((row) => row[side] !== undefined);
    const other = rows.filter((row) => row[otherSide(side)] !== undefined);
    if (line < starts[side] + own.length) {
      const offset = line - starts[side];
      const row = own[offset]!;
      return { within: { hunk, offset, row }, other: row[otherSide(side)] };
    }
    delta = starts[otherSide(side)] + other.length - (starts[side] + own.length);
  }
  return { other: line + delta };
}

/**
 * `line` of one side of `hunk` as the same line of `counterpart`, its exact counterpart (the same
 * body, under a header that may differ); undefined when `hunk` holds no such line.
 */
export function counterpartLine(
  hunk: Hunk,
  counterpart: Hunk,
  side: CodeSide,
  line: number,
): number | undefined {
  const parsed = parse(hunk);
  const starts = startsOf(counterpart);
  if (!parsed || !starts) return undefined;
  const offset = line - parsed.starts[side];
  const lines = parsed.rows.filter((row) => row[side] !== undefined).length;
  return offset >= 0 && offset < lines ? starts[side] + offset : undefined;
}

const sameContent = (a: ContentSide, b: ContentSide) =>
  a.kind === "text"
    ? b.kind === "text" && a.blob === b.blob
    : a.kind === "absent" && b.kind === "absent";

/** Whether one side of `path` holds different content in `to` than in `from`, or in only one. */
export function sideChanged(
  from: SnapshotLines,
  to: SnapshotLines,
  { path, side }: Pick<CodeRange, "path" | "side">,
) {
  const before = from.files.find((file) => file.path === path);
  const after = to.files.find((file) => file.path === path);
  return before && after ? !sameContent(before[side], after[side]) : before !== after;
}

/**
 * Maps single lines of one side of `path` from `from` to `to` (see `mapRange`), or undefined when
 * either snapshot lacks that side as text.
 */
function lineMapper(
  from: SnapshotLines,
  to: SnapshotLines,
  { path, side }: Pick<CodeRange, "path" | "side">,
): ((line: number) => number | undefined) | undefined {
  const before = from.files.find((file) => file.path === path);
  const after = to.files.find((file) => file.path === path);
  if (!before || !after || before[side].kind !== "text" || after[side].kind !== "text")
    return undefined;
  if (sameContent(before[side], after[side])) return (line) => line;
  const other = otherSide(side);
  const sameOther = sameContent(before[other], after[other]);
  const fromHunks = from.hunks.filter((hunk) => hunk.file === path);
  const toHunks = to.hunks.filter((hunk) => hunk.file === path);
  const matches = matchHunks(fromHunks, toHunks);
  const parsedFrom = fromHunks.map(parse);
  const parsedTo = toHunks.map(parse);
  if (
    !parsedFrom.every((hunk) => hunk !== undefined) ||
    !parsedTo.every((hunk) => hunk !== undefined)
  )
    return undefined;
  // The other side's lines either snapshot changes. With its bytes the same, each other line of it
  // stays one unchanged line of this side in both.
  const changedOther = new Set(
    [...parsedFrom, ...parsedTo].flatMap(({ rows }) =>
      rows.flatMap((row) => (row[side] === undefined ? [row[other]!] : [])),
    ),
  );
  /**
   * This side's lines strictly between two other-side lines neither snapshot changes, each as the
   * other-side line it holds or, for a changed line, its text.
   */
  const between = (hunks: readonly ParsedHunk[], low: number, high: number) => {
    const start = low === 0 ? 0 : locate(hunks, other, low).other!;
    const end = locate(hunks, other, high).other!;
    const lines: { line: number; token: string }[] = [];
    for (let line = start + 1; line < end; line++) {
      const at = locate(hunks, side, line);
      lines.push({
        line,
        token: at.other === undefined ? `+${at.within!.row.text}` : `=${at.other}`,
      });
    }
    return lines;
  };
  /**
   * A line only this side of a changed hunk holds maps as the same line when every line between it
   * and the nearest unchanged line before or after it is the same in both snapshots. It must map to
   * one line read either way, and that line must map back to it read either way: beside an
   * identical line inserted or deleted, which one stayed is ambiguous.
   */
  const alignChanged = ({ hunk, row }: NonNullable<Located["within"]>) => {
    const index = hunk.rows.indexOf(row);
    const above = hunk.rows.slice(0, index).findLast((each) => each[other] !== undefined);
    // The changed line sits just before this other-side line.
    const gap = above === undefined ? hunk.starts[other] : above[other]! + 1;
    let low = gap - 1;
    while (low > 0 && changedOther.has(low)) low--;
    let high = gap;
    while (changedOther.has(high)) high++;
    const fromLines = between(parsedFrom, low, high);
    const toLines = between(parsedTo, low, high);
    const at = fromLines.findIndex(({ line }) => line === row[side]);
    let prefix = 0;
    while (
      prefix < Math.min(fromLines.length, toLines.length) &&
      fromLines[prefix]!.token === toLines[prefix]!.token
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < Math.min(fromLines.length, toLines.length) &&
      fromLines.at(-1 - suffix)!.token === toLines.at(-1 - suffix)!.token
    )
      suffix++;
    const grown = toLines.length - fromLines.length;
    /** Where the line at `position` of a segment `length` lines long stays, read from either end. */
    const readings = (position: number, length: number, shift: number) => [
      ...(position < prefix ? [position] : []),
      ...(position >= length - suffix ? [position + shift] : []),
    ];
    const [stays, ...others] = readings(at, fromLines.length, grown);
    if (stays === undefined || others.some((each) => each !== stays)) return undefined;
    const back = readings(stays, toLines.length, -grown);
    return back.every((each) => each === at) ? toLines[stays]!.line : undefined;
  };
  return (line) => {
    const at = locate(parsedFrom, side, line);
    const counterpart = at.within && matches.get(at.within.hunk.id);
    if (at.within && counterpart) return startsOf(counterpart)![side] + at.within.offset;
    if (!sameOther) return undefined;
    if (at.other !== undefined) return locate(parsedTo, other, at.other).other;
    return alignChanged(at.within!);
  };
}

/**
 * Whether the code `range`, pinned in `pinned`, stands for in `from` reads differently in `to`. In
 * `from` that is the lines `range` maps to, widened past lines that no longer map to the nearest
 * that do (or the file's start), so a reference that already changed is compared where it now
 * stands, never rebound. Undefined when nothing bounds it, so only its whole side can tell.
 */
export function contextChanged(
  pinned: SnapshotLines,
  from: SnapshotLines,
  to: SnapshotLines,
  range: CodeRange,
): boolean | undefined {
  const into = lineMapper(pinned, from, range);
  if (!into) return undefined;
  let low: number | undefined;
  for (let line = range.startLine; low === undefined && line > 0; line--) low = into(line);
  // Past either snapshot's hunks a line maps unless none outside them does, so the nearest line
  // that maps lies within as many lines as those hunks hold.
  const rows = [...pinned.hunks, ...from.hunks]
    .filter((hunk) => hunk.file === range.path)
    .reduce((count, hunk) => count + hunk.patch.split("\n").length, 0);
  let high: number | undefined;
  for (let line = range.endLine; high === undefined && line <= range.endLine + rows; line++)
    high = into(line);
  if (high === undefined || (low !== undefined && low > high)) return undefined;
  const across = lineMapper(from, to, range);
  if (!across) return true;
  // From the file's start, the lines must still start it.
  let previous = low === undefined ? 0 : across(low);
  for (let line = (low ?? 0) + 1; line <= high; line++) {
    const next = across(line);
    if (previous === undefined || next !== previous + 1) return true;
    previous = next;
  }
  return previous === undefined;
}

/**
 * `range`, read in `from`, as the same lines of `to`: every line must map, unchanged and
 * unambiguously, to one contiguous range of the same file and side. A side with identical bytes
 * maps to itself. Otherwise a line of a hunk maps through that hunk's exact counterpart; an
 * unchanged line only through the other side's identical bytes to an unchanged line of `to`; and a
 * changed line, with the other side's identical bytes, only where `to` holds the same text with
 * nothing else changed between them and an unchanged line on one side of it, both sides agreeing.
 * No similarity, rename or cross-file matching: anything else is undefined.
 */
export function mapRange(
  from: SnapshotLines,
  to: SnapshotLines,
  range: CodeRange,
): CodeRange | undefined {
  const map = lineMapper(from, to, range);
  if (!map) return undefined;
  let startLine: number | undefined;
  let previous: number | undefined;
  for (let line = range.startLine; line <= range.endLine; line++) {
    const next = map(line);
    if (next === undefined || (previous !== undefined && next !== previous + 1)) return undefined;
    startLine ??= next;
    previous = next;
  }
  return { path: range.path, side: range.side, startLine: startLine!, endLine: previous! };
}
