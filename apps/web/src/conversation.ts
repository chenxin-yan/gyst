// Conversations in the reader: where each thread and draft shows, which replies are Outdated, what
// changed under a draft, and the draft texts kept while the reader is open. No React or DOM here,
// so the placement and memory rules are unit tested on their own.
import type {
  CapturedRange,
  Draft,
  HumanMessage,
  Message,
  MessageKind,
  StatusPayload,
  Thread,
} from "@gyst/core/wire";
import type { NotePlace, StatusNote } from "./walkthrough.ts";

/** Every current note of the session by id, whatever the view shows. */
export const notesById = (status: StatusPayload): ReadonlyMap<string, StatusNote> =>
  new Map(status.groups.flatMap(({ notes }) => notes.map((note) => [note.id, note] as const)));

/** The note a thread or draft still belongs to: one that exists and was never removed under it. */
export const liveNote = (
  item: Pick<Thread, "note">,
  notes: ReadonlyMap<string, StatusNote>,
): StatusNote | undefined =>
  item.note && !item.note.removed ? notes.get(item.note.id) : undefined;

/**
 * Where an open thread shows in the reader: under its note when the note is shown, else on its own
 * at the last line of its range, when that range is on the snapshot and a file the panel shows.
 */
export type ThreadPlace = {
  thread: Thread;
  /** The note it shows under, or undefined for a code thread (its note's removal included). */
  note: string | undefined;
  file: string;
  fileIndex: number;
  side: "deletions" | "additions";
  line: number;
};

const sideOf = (range: CapturedRange) => (range.side === "old" ? "deletions" : "additions");

/**
 * The open threads the panel shows, in code order: file, then line. `files` are the shown paths and
 * `snapshotId` the snapshot their code is read from; `notes` are the view's placed notes.
 */
export function threadPlaces(
  threads: readonly Thread[],
  files: readonly string[],
  snapshotId: string,
  notes: readonly NotePlace[],
  all: ReadonlyMap<string, StatusNote>,
): ThreadPlace[] {
  const places: ThreadPlace[] = [];
  for (const thread of threads) {
    if (thread.resolved) continue;
    const note = liveNote(thread, all);
    if (note) {
      const at = notes.find((place) => place.note.id === note.id);
      if (at)
        places.push({
          thread,
          note: note.id,
          file: at.file,
          fileIndex: at.fileIndex,
          side: at.side,
          line: at.line,
        });
      continue;
    }
    const { anchor } = thread;
    const fileIndex = files.indexOf(anchor.path);
    if (anchor.snapshotId !== snapshotId || fileIndex < 0) continue;
    places.push({
      thread,
      note: undefined,
      file: anchor.path,
      fileIndex,
      side: sideOf(anchor),
      line: anchor.endLine,
    });
  }
  return places.sort((a, b) => a.fileIndex - b.fileIndex || a.line - b.line);
}

/** The kept draft of a new comment on exactly `anchor`, its snapshot included, which `c` resumes. */
export const commentDraftOn = (drafts: readonly Draft[], anchor: CapturedRange) =>
  drafts.find(
    (draft) =>
      draft.thread === undefined &&
      draft.note === undefined &&
      draft.anchor.snapshotId === anchor.snapshotId &&
      draft.anchor.path === anchor.path &&
      draft.anchor.side === anchor.side &&
      draft.anchor.startLine === anchor.startLine &&
      draft.anchor.endLine === anchor.endLine,
  );

/**
 * Where a new comment's composer shows: at the last line of its range, when the panel shows that
 * code. A reply's composer shows in its thread or note instead.
 */
export function draftPlace(
  draft: Draft,
  files: readonly string[],
  snapshotId: string,
): Pick<ThreadPlace, "file" | "side" | "line"> | undefined {
  if (draft.thread !== undefined || draft.note !== undefined) return undefined;
  const { anchor } = draft;
  if (anchor.snapshotId !== snapshotId || !files.includes(anchor.path)) return undefined;
  return { file: anchor.path, side: sideOf(anchor), line: anchor.endLine };
}

/**
 * Whether a human note reply refers to wording the note no longer has: it changed or the note was
 * removed. The reply keeps that wording either way.
 */
export const replyOutdated = (
  message: Message,
  thread: Pick<Thread, "note">,
  notes: ReadonlyMap<string, StatusNote>,
): message is HumanMessage & { wording: NonNullable<HumanMessage["wording"]> } => {
  if (message.author !== "human" || message.wording === undefined) return false;
  const note = liveNote(thread, notes);
  return note === undefined || note.markdown !== message.wording.markdown;
};

/**
 * What changed under a draft since it was begun, said beside its composer: its thread went or was
 * resolved (which `blocks` sending), its note changed or went, or a refresh left its code behind.
 * Sending never rebinds it.
 */
export function draftChange(
  draft: Draft,
  threads: readonly Thread[],
  notes: ReadonlyMap<string, StatusNote>,
  snapshotId: string,
): { message: string; blocks: boolean } | undefined {
  const thread =
    draft.thread === undefined ? undefined : threads.find(({ id }) => id === draft.thread);
  if (thread?.resolved)
    return { message: "This thread was resolved. Reopen it to send your reply.", blocks: true };
  if (draft.thread !== undefined && thread === undefined && draft.note === undefined)
    return { message: "This thread no longer exists, so the reply can't be sent.", blocks: true };
  const note = liveNote(draft, notes);
  const message = draft.note?.removed
    ? "The note was removed. Your reply keeps the wording you began it against."
    : note && draft.wording && note.markdown !== draft.wording.markdown
      ? "The note changed since you began. Your reply keeps the wording you began it against."
      : draft.anchor.snapshotId !== snapshotId
        ? "A refresh changed this code. Your comment stays on the code you began it against."
        : undefined;
  return message === undefined ? undefined : { message, blocks: false };
}

/** A thread's place in words: its file, lines and side, and whether its code is earlier. */
export const threadLocation = (anchor: CapturedRange, snapshotId: string) => {
  const lines =
    anchor.startLine === anchor.endLine
      ? `L${anchor.startLine}`
      : `L${anchor.startLine}–${anchor.endLine}`;
  return `${anchor.path}:${lines} · ${anchor.side}${anchor.snapshotId === snapshotId ? "" : " · earlier code"}`;
};

/** How many human messages of a thread are still Pending. */
export const pendingCount = (thread: Thread) =>
  thread.messages.filter((message) => message.author === "human" && message.pending).length;

/** Comments in list order: open threads first, then resolved, each in the order they began. */
export const commentsOrder = (threads: readonly Thread[]) => [
  ...threads.filter(({ resolved }) => !resolved),
  ...threads.filter(({ resolved }) => resolved),
];

/** A message being written: its text and kind. */
export type DraftText = { markdown: string; kind: MessageKind };

// Draft texts by session and draft id, for the page's life: they survive closing the composer,
// switching sessions and losing the connection. The pin that protects their context is the daemon's.
const texts = new Map<string, DraftText>();
const textKey = (sessionId: string, draftId: string) => `${sessionId}\0${draftId}`;

export const draftText = (sessionId: string, draftId: string): DraftText =>
  texts.get(textKey(sessionId, draftId)) ?? { markdown: "", kind: "question" };

export const keepDraftText = (sessionId: string, draftId: string, text: DraftText) =>
  void texts.set(textKey(sessionId, draftId), text);

export const forgetDraftText = (sessionId: string, draftId: string) =>
  void texts.delete(textKey(sessionId, draftId));
