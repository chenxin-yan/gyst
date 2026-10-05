import type { Cursor, Opened, Side } from "./cursor.ts";
import type { InputMode } from "./keymap.ts";

/** Where the reader is: a file and, inside its diff, the side and line at the top of the panel. */
export type ReadingPosition = { file: string; side: Side | undefined; line: number | undefined };

/**
 * Where a reader left a session: its file selection, input mode, Vim cursor, the hidden lines it
 * opened (a place inside them exists only once they open again) and the position at the panel's top.
 */
export type ReadingPlace = {
  selection: string;
  inputMode: InputMode;
  cursor: Cursor | undefined;
  opened: Map<string, Map<number, Opened>>;
  top: ReadingPosition | undefined;
};

/**
 * Each session's reading place for this page's lifetime, so switching between stack layers (or any
 * sessions) and back resumes where the reader was. Kept per session ID, so one session's place never
 * leaks into another; a place belongs to the snapshot it was read in, and a refresh starts afresh.
 */
const places = new Map<string, { snapshotId: string; place: ReadingPlace }>();

export const remember = (sessionId: string, snapshotId: string, place: ReadingPlace) => {
  places.set(sessionId, { snapshotId, place });
};

export const recall = (sessionId: string, snapshotId: string): ReadingPlace | undefined => {
  const saved = places.get(sessionId);
  return saved?.snapshotId === snapshotId ? saved.place : undefined;
};
