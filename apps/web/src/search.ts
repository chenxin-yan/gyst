// Search over the current view's diff lines: what each line says, literal smart-case matching, and
// stepping from a place with wrap. It reads captured content, never the rendered page, so rows the
// renderer has not drawn are found. No React or DOM here, so each piece is unit tested on its own.
import type { FileDiffMetadata } from "@pierre/diffs";
import { type Cursor, lineOn, type Row, type Side, startBoundary } from "./cursor.ts";

/** A matched line of one file: its place in the file's reading order and its line numbers. */
export type Hit = { order: number; old?: number; new?: number };

/** Whether a line contains the query: literal, and case-sensitive only when the query has a capital. */
export function matcher(query: string): (text: string) => boolean {
  if (query !== query.toLowerCase()) return (text) => text.includes(query);
  return (text) => text.toLowerCase().includes(query);
}

/** A line's text by side and line number, if the content holds it. */
export type LineText = (side: Side, line: number) => string | undefined;

/**
 * A diff's line text. A loaded diff holds each side whole; a partial one only its hunks' lines,
 * which are all a partial diff shows.
 */
export function diffText(diff: FileDiffMetadata): LineText {
  if (!diff.isPartial)
    return (side, line) =>
      (side === "deletions" ? diff.deletionLines : diff.additionLines)[line - 1];
  const deleted = new Map<number, number>();
  const added = new Map<number, number>();
  for (const hunk of diff.hunks) {
    let old = startBoundary(hunk.deletionStart, hunk.deletionCount) + 1;
    let line = startBoundary(hunk.additionStart, hunk.additionCount) + 1;
    for (const content of hunk.hunkContent) {
      const deletions = content.type === "context" ? content.lines : content.deletions;
      const additions = content.type === "context" ? content.lines : content.additions;
      for (let index = 0; index < deletions; index++)
        deleted.set(old + index, content.deletionLineIndex + index);
      for (let index = 0; index < additions; index++)
        added.set(line + index, content.additionLineIndex + index);
      old += deletions;
      line += additions;
    }
  }
  return (side, line) => {
    const index = (side === "deletions" ? deleted : added).get(line);
    return index === undefined
      ? undefined
      : (side === "deletions" ? diff.deletionLines : diff.additionLines)[index];
  };
}

/** A captured side shown whole: one column of lines, numbered from 1. */
export const wholeText =
  (lines: readonly string[]): LineText =>
  (_side, line) =>
    lines[line - 1];

/**
 * A file's rows in the order the panel draws them top to bottom: stacked as listed, split by split
 * row, where a change's deletions and additions sit side by side.
 */
export const readingOrder = (rows: readonly Row[], layout: "split" | "stacked"): readonly Row[] =>
  layout === "stacked" ? rows : rows.toSorted((a, b) => a.split - b.split);

/**
 * The lines among a file's rows, in reading order, that contain a match. A line on both sides reads
 * its new side; collapsed hidden ranges are not lines and are never read.
 */
export function hitsOf(
  rows: readonly Row[],
  text: LineText,
  test: (text: string) => boolean,
): Hit[] {
  const hits: Hit[] = [];
  for (const [order, row] of rows.entries()) {
    if (row.kind !== "line") continue;
    const line = row.new === undefined ? text("deletions", row.old!) : text("additions", row.new);
    if (line !== undefined && test(line))
      hits.push({
        order,
        ...(row.old !== undefined && { old: row.old }),
        ...(row.new !== undefined && { new: row.new }),
      });
  }
  return hits;
}

/** Where a cursor stands in a file's reading order: -1 on its header or a row no longer shown. */
export function orderOf(rows: readonly Row[], cursor: Cursor): number {
  if (cursor.kind === "header") return -1;
  if (cursor.kind === "range")
    return rows.findIndex((row) => row.kind === "range" && row.range === cursor.range);
  return rows.findIndex((row) => row.kind === "line" && lineOn(row, cursor.side) === cursor.line);
}

/** A view's matches: each shown file's hits, in the view's file order. */
export type SearchResult = {
  files: readonly string[];
  hits: readonly (readonly Hit[])[];
  /** How many hits come before each file. */
  offsets: readonly number[];
  total: number;
};

export function resultOf(
  files: readonly string[],
  hits: readonly (readonly Hit[])[],
): SearchResult {
  const offsets: number[] = [];
  let total = 0;
  for (const fileHits of hits) {
    offsets.push(total);
    total += fileHits.length;
  }
  return { files, hits, offsets, total };
}

/** A match: its file's index in the view and its index among that file's hits. */
export type MatchAt = { fileIndex: number; hit: number };

/** A place in the view: a file's index and an order in its rows, -1 for its header. */
export type SearchPlace = { fileIndex: number; order: number };

/** The match's number in the whole view, counting from 0. */
export const indexOf = (result: SearchResult, at: MatchAt) =>
  result.offsets[at.fileIndex]! + at.hit;

/** The match with this number in the whole view. */
export function matchAt(result: SearchResult, index: number): MatchAt {
  // The last file starting at or before it; files without hits share their successor's offset.
  let low = 0;
  let high = result.offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (result.offsets[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return { fileIndex: low, hit: index - result.offsets[low]! };
}

/** How many matches come before a place, and with `atPlace` the one on it too. */
function countBefore(result: SearchResult, place: SearchPlace, atPlace: boolean) {
  const hits = result.hits[place.fileIndex] ?? [];
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const order = hits[middle]!.order;
    if (order < place.order || (atPlace && order === place.order)) low = middle + 1;
    else high = middle;
  }
  return (result.offsets[place.fileIndex] ?? result.total) + low;
}

/**
 * The next or previous match from a place, wrapping around the view's ends. A match on the place
 * itself is skipped unless `inclusive`. Undefined without matches.
 */
export function searchStep(
  result: SearchResult,
  from: SearchPlace,
  direction: 1 | -1,
  inclusive = false,
): MatchAt | undefined {
  if (result.total === 0) return undefined;
  const index =
    direction === 1
      ? countBefore(result, from, !inclusive)
      : countBefore(result, from, inclusive) - 1;
  return matchAt(result, (index + result.total) % result.total);
}
