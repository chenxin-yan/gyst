import { type CapturedRange, counterpartLine, type Hunk } from "@gyst/core/wire";
import type { RangeCommits } from "./author.tsx";
import type { Cursor, Opened, Side } from "./cursor.ts";
import type { InputMode } from "./keymap.ts";
import type { BackStack, Peek, ReadingPosition, Restore } from "./navigation.ts";
import type { ReviewView } from "./walkthrough.ts";

/**
 * Where a reader left a session: its view, the captured target expanded over it with that file's
 * opened lines, the open peek and the places Back returns to, its input mode, Vim cursor, the hidden
 * lines it opened (a place inside them exists only once they open again), its folded files (a
 * place inside a file exists only while it is unfolded), whether it showed the author's explanation
 * with the range commits read for it (an offset into the panel's header counts them) and what was at
 * the panel's top: a reading position, or an offset above the first file.
 */
export type ReadingPlace = {
  review: ReviewView;
  captured: CapturedRange | undefined;
  expandedOpened: Map<string, Map<number, Opened>>;
  peek: Peek | undefined;
  back: BackStack;
  inputMode: InputMode;
  cursor: Cursor | undefined;
  opened: Map<string, Map<number, Opened>>;
  folded: ReadonlySet<string>;
  author: { shown: boolean; commits: RangeCommits["read"] };
  top: Restore | undefined;
};

/**
 * Each session's reading place for this page's lifetime, so switching between stack layers (or any
 * sessions) and back resumes where the reader was. Kept per session ID, so one session's place never
 * leaks into another. After a refresh the view and the input mode carry over, and everything in a
 * file whose hunks the refresh left exactly as they were, its fold included. In another file the top
 * position and the cursor move with a hunk that survived exactly, whatever its line numbers; else
 * only the file at the top, and a cursor on its header, are kept, and the file is folded exactly when
 * the new snapshot records it Generated and no kept position is on one of its lines. An expanded
 * reference, Back and the author's explanation belong to the snapshot they were read in, and so does
 * an offset taken while that explanation was shown.
 */
const places = new Map<
  string,
  { snapshotId: string; hunks: readonly Hunk[]; place: ReadingPlace }
>();

export const remember = (
  sessionId: string,
  snapshotId: string,
  hunks: readonly Hunk[],
  place: ReadingPlace,
) => {
  places.set(sessionId, { snapshotId, hunks, place });
};

/** Each file's hunks as one text: identical exactly when the file's diff reads the same. */
const diffsOf = (hunks: readonly Hunk[]) => {
  const diffs = new Map<string, string>();
  for (const { file, id, patch } of hunks)
    diffs.set(file, `${diffs.get(file) ?? ""}${id}\0${patch}\0`);
  return diffs;
};

export const recall = (
  sessionId: string,
  snapshotId: string,
  hunks: readonly Hunk[],
  generated: ReadonlySet<string>,
): ReadingPlace | undefined => {
  const saved = places.get(sessionId);
  if (saved === undefined || saved.snapshotId === snapshotId) return saved?.place;
  const before = diffsOf(saved.hunks);
  const after = diffsOf(hunks);
  const unchanged = (file: string) => before.has(file) && before.get(file) === after.get(file);
  // A surviving hunk keeps its id and body, so a line in it is found again by its offset.
  const now = new Map(hunks.map((hunk) => [hunk.id, hunk]));
  const lineNow = (file: string, side: Side, line: number) => {
    for (const hunk of saved.hunks) {
      const survivor = now.get(hunk.id);
      if (hunk.file !== file || survivor?.contentHash !== hunk.contentHash) continue;
      const moved = counterpartLine(hunk, survivor, side === "deletions" ? "old" : "new", line);
      if (moved !== undefined) return moved;
    }
    return undefined;
  };
  const cursorNow = (cursor: Cursor): Cursor | undefined => {
    if (unchanged(cursor.file)) return cursor;
    if (cursor.kind === "header") return after.has(cursor.file) ? cursor : undefined;
    if (cursor.kind === "range") return undefined;
    const line = lineNow(cursor.file, cursor.side, cursor.line);
    return line === undefined ? undefined : { ...cursor, line };
  };
  const topNow = ({ file, side, line }: ReadingPosition): ReadingPosition => {
    if (unchanged(file) || side === undefined || line === undefined) return { file, side, line };
    const moved = lineNow(file, side, line);
    return moved === undefined
      ? { file, side: undefined, line: undefined }
      : { file, side, line: moved };
  };
  const { review, inputMode, cursor, opened, folded, author, top } = saved.place;
  const cursorAfter = cursor && cursorNow(cursor);
  const topAfter =
    top !== undefined && "position" in top
      ? { position: topNow(top.position) }
      : author.shown
        ? undefined
        : top;
  // A folded file has no lines, so a file still holding the reader's line stays unfolded.
  const reading = new Set<string>();
  if (cursorAfter?.kind === "line") reading.add(cursorAfter.file);
  if (topAfter !== undefined && "position" in topAfter && topAfter.position.line !== undefined)
    reading.add(topAfter.position.file);
  return {
    review,
    captured: undefined,
    expandedOpened: new Map(),
    peek: undefined,
    back: [],
    inputMode,
    cursor: cursorAfter,
    opened: new Map([...opened].filter(([file]) => unchanged(file))),
    folded: new Set([
      ...[...folded].filter(unchanged),
      ...[...generated].filter((file) => !unchanged(file) && !reading.has(file)),
    ]),
    author: { shown: false, commits: undefined },
    top: topAfter,
  };
};
