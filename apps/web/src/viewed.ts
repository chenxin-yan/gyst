// Viewed progress in the reader: one set of Viewed hunk ids that every view reads, and the human's
// writes to it. No React or DOM here, so derivation and retry rules are unit tested on their own.
import type { ViewedPayload } from "@gyst/core/wire";
import { isUncertain } from "./api.ts";

/** Whether a file section reads as Viewed: every hunk in it is. An empty section never is. */
export const sectionViewed = (hunkIds: readonly string[], viewed: ReadonlySet<string>) =>
  hunkIds.length > 0 && hunkIds.every((id) => viewed.has(id));

/**
 * One human change to a file section's Viewed state. Its request id is minted when the human acts
 * and reused for every retry, against the revision they saw, so a lost reply never applies twice.
 */
export type ViewedIntent = {
  file: string;
  requestId: string;
  hunkIds: readonly string[];
  viewed: boolean;
  revision: number;
  /** How many times it has been sent; past one, its reply may replay an earlier answer. */
  attempts: number;
  failure?: unknown;
};

export type ViewedState = {
  /** The snapshot the reader shows; a status read naming another means a refresh replaced it. */
  snapshotId: string;
  viewed: ReadonlySet<string>;
  revision: number;
  /** The write being sent, or the failed one awaiting a retry; one at a time. */
  intent?: ViewedIntent | undefined;
  /** A file's write is on the wire, or status is being read again before any new write. */
  busy?: { kind: "sending" | "rereading"; file: string } | undefined;
  /**
   * Why the last write did not apply as asked, said in that file's header: progress changed
   * elsewhere (state was read again), or only a session reload can bring it up to date.
   */
  notice?: { file: string; kind: "conflict" | "reload"; failure?: unknown } | undefined;
};

export type ViewedEvent =
  | { type: "send"; intent: ViewedIntent }
  | { type: "applied"; result: ViewedPayload }
  | { type: "failed"; error: unknown }
  | { type: "status"; status: StatusRead }
  | { type: "unread"; error: unknown };

/** What a status read says about Viewed progress. */
export type StatusRead = { snapshotId: string; revision: number; viewedHunkIds: readonly string[] };

/**
 * A reader's first reads, all of one snapshot. Diff and status are separate reads, so a refresh
 * between them can pair the shown hunks with another snapshot's progress, which no write could
 * then match. Such a pair is read once more, then refused rather than shown.
 */
export async function readOneSnapshot<
  T extends { snapshotId: string; status: { session: { snapshotId: string } } },
>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await read();
    if (loaded.status.session.snapshotId === loaded.snapshotId) return loaded;
  }
  throw new Error(
    "This session was refreshed while it loaded, so its diff and Viewed progress disagree. Try again.",
  );
}

export const initialViewed = (status: StatusRead): ViewedState => ({
  snapshotId: status.snapshotId,
  viewed: new Set(status.viewedHunkIds),
  revision: status.revision,
});

/**
 * The write for a human's change, or undefined while another write or a status read is under way,
 * or until a reread succeeds after one failed or named another snapshot.
 * The same change after a failure is that intent's retry, with its request id and revision; any
 * other change is a new intent against the current revision.
 */
export function intentFor(
  state: ViewedState,
  change: { file: string; hunkIds: readonly string[]; viewed: boolean },
  mint: () => string,
): ViewedIntent | undefined {
  if (state.busy || state.notice?.kind === "reload") return undefined;
  const { intent } = state;
  if (
    intent?.failure !== undefined &&
    intent.file === change.file &&
    intent.viewed === change.viewed &&
    intent.hunkIds.length === change.hunkIds.length &&
    intent.hunkIds.every((id, index) => change.hunkIds[index] === id)
  )
    return { ...intent, attempts: intent.attempts + 1, failure: undefined };
  return { ...change, requestId: mint(), revision: state.revision, attempts: 1 };
}

/**
 * The resend of a write whose reply was lost, so it may already be applied: the same request id,
 * hunks, Viewed state and revision, which the daemon answers from its receipt if it was. Undefined
 * while busy, and for a write that failed for certain.
 */
export function replayOf(state: ViewedState): ViewedIntent | undefined {
  const { intent } = state;
  if (state.busy || intent?.failure === undefined || !isUncertain(intent.failure)) return undefined;
  return { ...intent, attempts: intent.attempts + 1, failure: undefined };
}

const isTagged = (error: unknown, ...tags: string[]) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  tags.includes(String(error._tag));

/**
 * The next state after an event. A first send's answer is current: it applies and its revision
 * becomes the one seen. A retried send's answer may replay history, and a stale or reused intent
 * conflicts, so both read status again before any new write, never overwriting. Other failures keep
 * the intent for its retry.
 */
export function viewedReducer(state: ViewedState, event: ViewedEvent): ViewedState {
  switch (event.type) {
    case "send":
      return {
        ...state,
        intent: event.intent,
        busy: { kind: "sending", file: event.intent.file },
        notice: undefined,
      };
    case "applied": {
      const { intent } = state;
      if (intent === undefined) return state;
      if (intent.attempts > 1)
        return { ...state, intent: undefined, busy: { kind: "rereading", file: intent.file } };
      const viewed = new Set(state.viewed);
      for (const id of event.result.hunkIds)
        if (event.result.viewed) viewed.add(id);
        else viewed.delete(id);
      return { snapshotId: state.snapshotId, viewed, revision: event.result.revision };
    }
    case "failed": {
      const { intent } = state;
      if (intent === undefined) return state;
      if (isTagged(event.error, "stale_revision", "validation_failed"))
        return {
          ...state,
          intent: undefined,
          busy: { kind: "rereading", file: intent.file },
          notice: { file: intent.file, kind: "conflict" },
        };
      return { ...state, intent: { ...intent, failure: event.error }, busy: undefined };
    }
    case "status": {
      // A refresh replaced the snapshot: these hunks are gone, and only a reload reads the new ones.
      if (event.status.snapshotId !== state.snapshotId)
        return { ...state, busy: undefined, notice: { file: noticeFile(state), kind: "reload" } };
      // A late reply read before progress already shown; it never moves the reader back.
      if (event.status.revision < state.revision)
        return state.busy ? { ...state, busy: undefined } : state;
      // A successful read recovers from a reload notice; a conflict stays said. Progress read
      // elsewhere says nothing of a failed write, so it keeps its Retry until resent.
      return {
        snapshotId: state.snapshotId,
        viewed: new Set(event.status.viewedHunkIds),
        revision: event.status.revision,
        ...(state.intent?.failure !== undefined && { intent: state.intent }),
        ...(state.notice?.kind === "conflict" && { notice: state.notice }),
      };
    }
    case "unread":
      return {
        ...state,
        busy: undefined,
        notice: { file: noticeFile(state), kind: "reload", failure: event.error },
      };
  }
}

const noticeFile = (state: ViewedState) => state.busy?.file ?? state.notice?.file ?? "";

/**
 * What a file header's checkbox shows: the section's Viewed state, or while its write is sent the
 * state asked for; whether a write or reread is pending there; its failure; and its notice.
 */
export function checkboxOf(state: ViewedState, file: string, hunkIds: readonly string[]) {
  const { intent, notice } = state;
  const pending = state.busy?.file === file ? state.busy.kind : undefined;
  return {
    checked: pending === "sending" && intent ? intent.viewed : sectionViewed(hunkIds, state.viewed),
    pending,
    failure: intent?.file === file ? intent.failure : undefined,
    notice: notice?.file === file ? notice : undefined,
  };
}
