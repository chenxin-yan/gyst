// The Vim cursor's logical model: every file's header, code lines and hidden ranges in reading
// order, derived from the diff metadata and which hidden lines are open, never from mounted rows.
// No React or DOM here, so movement is unit tested on its own.
import type { FileDiffMetadata, SelectionSide } from "@pierre/diffs";

export type Side = SelectionSide;

/**
 * Where the cursor is. `side` is the split column it walks; on a stacked line it is the line's own
 * side. A range is a hidden-line range, numbered as the renderer numbers them: range `i` sits above
 * hunk `i`, and range `hunks.length` trails the last hunk.
 */
export type Cursor =
  | { file: string; kind: "header"; side: Side }
  | { file: string; kind: "line"; side: Side; line: number }
  | { file: string; kind: "range"; side: Side; range: number };

/** How much of a hidden range is open: lines from its start and from its end, as the renderer counts. */
export type Opened = { fromStart: number; fromEnd: number };

/**
 * One row of a file in stacked reading order. `split` is its row in a split layout, where a
 * change's deletions and additions pair up; `block` numbers the file's changes; a line opened from
 * a hidden range keeps that range's number. A hidden range names its first hidden line on each side.
 */
export type Row =
  | { kind: "line"; old?: number; new?: number; split: number; block?: number; range?: number }
  | { kind: "range"; range: number; old: number; new: number; split: number };

/** A hidden range: its number, its first line on each side and its length. */
export type HiddenRange = { index: number; old: number; new: number; size: number };

// The renderer's side boundaries: a side with no lines in a hunk starts after its `@@` number.
const startBoundary = (start: number, count: number) => start - (count === 0 ? 0 : 1);

/**
 * The file's hidden ranges with their exact sizes. A partial diff (captured sides not loaded yet)
 * has no trailing range: its size is unknown until the sides load.
 */
export function hiddenRanges(diff: FileDiffMetadata): HiddenRange[] {
  const ranges: HiddenRange[] = [];
  for (const [index, hunk] of diff.hunks.entries())
    if (hunk.collapsedBefore > 0)
      ranges.push({
        index,
        old: startBoundary(hunk.deletionStart, hunk.deletionCount) + 1 - hunk.collapsedBefore,
        new: startBoundary(hunk.additionStart, hunk.additionCount) + 1 - hunk.collapsedBefore,
        size: hunk.collapsedBefore,
      });
  const last = diff.hunks.at(-1);
  if (last && !diff.isPartial && diff.additionLines.length > 0 && diff.deletionLines.length > 0) {
    const old = startBoundary(last.deletionStart, last.deletionCount) + last.deletionCount;
    const end = startBoundary(last.additionStart, last.additionCount) + last.additionCount;
    const size = Math.min(diff.additionLines.length - end, diff.deletionLines.length - old);
    if (size > 0) ranges.push({ index: diff.hunks.length, old: old + 1, new: end + 1, size });
  }
  return ranges;
}

/**
 * Every row of a file in stacked order. A loaded range of one line always shows, as the renderer
 * shows it; otherwise a range shows its opened lines from either end around what is still hidden.
 */
export function rowsOf(diff: FileDiffMetadata, opened: ReadonlyMap<number, Opened>): Row[] {
  const rows: Row[] = [];
  let split = 0;
  let block = 0;
  const context = (old: number, line: number, count: number, range?: number) => {
    for (let index = 0; index < count; index++)
      rows.push({
        kind: "line",
        old: old + index,
        new: line + index,
        split: split++,
        ...(range !== undefined && { range }),
      });
  };
  const ranges = new Map(hiddenRanges(diff).map((range) => [range.index, range]));
  const hidden = (index: number) => {
    const range = ranges.get(index);
    if (range === undefined) return;
    const { fromStart = 0, fromEnd = 0 } = opened.get(index) ?? {};
    const start = !diff.isPartial && range.size <= 1 ? range.size : Math.min(fromStart, range.size);
    const end = Math.min(fromEnd, range.size - start);
    context(range.old, range.new, start, index);
    if (start + end < range.size)
      rows.push({
        kind: "range",
        range: index,
        old: range.old + start,
        new: range.new + start,
        split: split++,
      });
    const after = range.size - end;
    context(range.old + after, range.new + after, end, index);
  };
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    hidden(hunkIndex);
    let old = startBoundary(hunk.deletionStart, hunk.deletionCount) + 1;
    let line = startBoundary(hunk.additionStart, hunk.additionCount) + 1;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        context(old, line, content.lines);
        old += content.lines;
        line += content.lines;
        continue;
      }
      for (let index = 0; index < content.deletions; index++)
        rows.push({ kind: "line", old: old + index, split: split + index, block });
      for (let index = 0; index < content.additions; index++)
        rows.push({ kind: "line", new: line + index, split: split + index, block });
      split += Math.max(content.deletions, content.additions);
      old += content.deletions;
      line += content.additions;
      block++;
    }
  }
  hidden(diff.hunks.length);
  return rows;
}

/**
 * The rows of a captured file shown whole, without a diff: lines 1 to `count` of its one `side`,
 * so the cursor and a selection on them stay on that side in every layout.
 */
export function capturedRows(count: number, side: Side): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "line",
    [side === "deletions" ? "old" : "new"]: index + 1,
    split: index,
  }));
}

/** A place the cursor can stop, with the row it stands on (-1 for the header). */
export type Stop = Cursor & { row: number };

const lineOn = (row: Row, side: Side) => (side === "deletions" ? row.old : row.new);

/**
 * Where the cursor can stop in one file: its header, then (unless folded) each row. Stacked stops
 * on every line; split walks one column, or the other when the file has no lines on that side.
 */
export function stopsOf(
  file: string,
  rows: readonly Row[],
  layout: "split" | "stacked",
  side: Side,
): Stop[] {
  const stops: Stop[] = [{ file, kind: "header", side, row: -1 }];
  const column =
    rows.some((row) => row.kind === "line" && lineOn(row, side) !== undefined) ||
    layout === "stacked"
      ? side
      : side === "deletions"
        ? "additions"
        : "deletions";
  for (const [index, row] of rows.entries()) {
    if (row.kind === "range") {
      stops.push({ file, kind: "range", side, range: row.range, row: index });
      continue;
    }
    const lineSide =
      layout === "stacked" ? (row.new === undefined ? "deletions" : "additions") : column;
    const line = lineOn(row, lineSide);
    if (line !== undefined) stops.push({ file, kind: "line", side: lineSide, line, row: index });
  }
  return stops;
}

/** The row a cursor stands on, or -1 for its header or a line that is no longer shown. */
function rowOf(rows: readonly Row[], cursor: Cursor) {
  if (cursor.kind === "header") return -1;
  if (cursor.kind === "range") {
    const index = rows.findIndex((row) => row.kind === "range" && row.range === cursor.range);
    // An opened range leaves its lines: the cursor stands on the first of them.
    return index >= 0
      ? index
      : rows.findIndex((row) => row.kind === "line" && row.range === cursor.range);
  }
  return rows.findIndex((row) => row.kind === "line" && lineOn(row, cursor.side) === cursor.line);
}

/**
 * The stop the cursor stands on: the same row, or in split the nearest row of the walked column,
 * so a stacked deletion lands beside itself. A cursor whose row is gone stands on its header.
 */
export function locate(stops: readonly Stop[], rows: readonly Row[], cursor: Cursor): number {
  const row = rowOf(rows, cursor);
  if (row < 0) return 0;
  const exact = stops.findIndex((stop) => stop.row === row);
  if (exact >= 0) return exact;
  const split = rows[row]!.split;
  let best = 0;
  for (const [index, stop] of stops.entries()) {
    if (stop.row < 0) continue;
    const distance = Math.abs(rows[stop.row]!.split - split);
    if (best === 0 || distance < Math.abs(rows[stops[best]!.row]!.split - split)) best = index;
  }
  return best;
}

/** The shown files in order, and each file's rows and stops under the current layout and side. */
export type Model = {
  files: readonly string[];
  rows: (file: string) => readonly Row[];
  stops: (file: string, side: Side) => readonly Stop[];
};

const stripped = (stop: Stop): Cursor => {
  const cursor: Partial<Stop> = { ...stop };
  delete cursor.row;
  return cursor as Cursor;
};

/** The stop a cursor stands on under the model's layout, as a cursor. */
export function place(model: Model, cursor: Cursor): Cursor {
  const stops = model.stops(cursor.file, cursor.side);
  return stripped(stops[locate(stops, model.rows(cursor.file), cursor)]!);
}

/**
 * The cursor `delta` stops away, across files. `withinLines` keeps it on code lines of its own file,
 * as while selecting lines.
 */
export function moved(model: Model, cursor: Cursor, delta: number, withinLines = false): Cursor {
  if (withinLines) {
    const stops = model.stops(cursor.file, cursor.side);
    const lines = stops.filter((stop) => stop.kind === "line");
    const row = stops[locate(stops, model.rows(cursor.file), cursor)]!.row;
    const at = lines.findIndex((stop) => stop.row === row);
    const next = lines[Math.min(lines.length - 1, Math.max(0, at + delta))];
    return next ? stripped(next) : cursor;
  }
  let fileIndex = model.files.indexOf(cursor.file);
  if (fileIndex < 0) return cursor;
  let stops = model.stops(cursor.file, cursor.side);
  let at = locate(stops, model.rows(cursor.file), cursor) + delta;
  while (at < 0 && fileIndex > 0) {
    stops = model.stops(model.files[--fileIndex]!, cursor.side);
    at += stops.length;
  }
  while (at >= stops.length && fileIndex < model.files.length - 1) {
    at -= stops.length;
    stops = model.stops(model.files[++fileIndex]!, cursor.side);
  }
  return stripped(stops[Math.min(stops.length - 1, Math.max(0, at))]!);
}

/** The first or last stop of the shown files. */
export function edge(model: Model, end: "first" | "last", side: Side): Cursor | undefined {
  const file = end === "first" ? model.files[0] : model.files.at(-1);
  if (file === undefined) return undefined;
  const stops = model.stops(file, side);
  return stripped(end === "first" ? stops[0]! : stops.at(-1)!);
}

/** The same row on the other split column, or the nearest one there. */
export function switched(model: Model, cursor: Cursor, side: Side): Cursor {
  if (cursor.kind !== "line") return { ...cursor, side };
  const rows = model.rows(cursor.file);
  const from = rows[rowOf(rows, cursor)];
  const stops = model.stops(cursor.file, side).filter((stop) => stop.kind === "line");
  if (from === undefined || stops.length === 0) return { ...cursor, side };
  const nearest = stops.reduce((best, stop) =>
    Math.abs(rows[stop.row]!.split - from.split) < Math.abs(rows[best.row]!.split - from.split)
      ? stop
      : best,
  );
  return stripped(nearest);
}

// Each change's first stop, in reading order. In split a change with no lines on the walked
// column starts on the other one; a folded file has none.
function changeStarts(file: string, rows: readonly Row[], stops: readonly Stop[]) {
  const starts = new Map<number, { cursor: Cursor; split: number }>();
  if (stops.length === 1) return [];
  for (const stop of stops) {
    const row = rows[stop.row];
    if (stop.kind === "line" && row?.kind === "line" && row.block !== undefined)
      if (!starts.has(row.block))
        starts.set(row.block, { cursor: stripped(stop), split: row.split });
  }
  for (const row of rows)
    if (row.kind === "line" && row.block !== undefined && !starts.has(row.block)) {
      const side = row.old === undefined ? "additions" : "deletions";
      const line = lineOn(row, side)!;
      starts.set(row.block, { cursor: { file, kind: "line", side, line }, split: row.split });
    }
  return [...starts.values()].sort((a, b) => a.split - b.split);
}

/** The next or previous change's first line after or before the cursor, across files. */
export function change(model: Model, cursor: Cursor, direction: 1 | -1): Cursor | undefined {
  const start = model.files.indexOf(cursor.file);
  for (let at = start; at >= 0 && at < model.files.length; at += direction) {
    const file = model.files[at]!;
    const rows = model.rows(file);
    const stops = model.stops(file, cursor.side);
    // The cursor's own file searches from its row; later files from their edge.
    const row = at === start ? stops[locate(stops, rows, cursor)]!.row : undefined;
    const from = row === undefined ? undefined : row < 0 ? -1 : rows[row]!.split;
    const starts = changeStarts(file, rows, stops);
    const found =
      direction === 1
        ? starts.find((target) => from === undefined || target.split > from)
        : starts.findLast((target) => from === undefined || target.split < from);
    if (found) return found.cursor;
  }
  return undefined;
}

/** The next file's header, or the previous header before the cursor: its own file's, then the one before. */
export function fileStep(model: Model, cursor: Cursor, direction: 1 | -1): Cursor | undefined {
  const index = model.files.indexOf(cursor.file);
  const target = direction === 1 ? index + 1 : cursor.kind === "header" ? index - 1 : index;
  const file = model.files[target];
  return file === undefined ? undefined : { file, kind: "header", side: cursor.side };
}
