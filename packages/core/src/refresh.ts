import { Result } from "effect";
import { draftOf, type MutableSession } from "./draft.ts";
import { StaleRevision, ValidationFailed } from "./errors.ts";
import {
  anchoredHunkIds,
  type CapturedRange,
  type GuidanceText,
  type OutdatedReason,
  OutdatedReasonSchema,
} from "./guidance.ts";
import { hash } from "./hash.ts";
import {
  contextChanged,
  mapRange,
  matchHunks,
  sideChanged,
  type SnapshotLines,
  survivingHunkIds,
} from "./mapping.ts";
import type { RefreshPayload, Session } from "./session.ts";
import type { Wording } from "./thread.ts";
import type { BrowserRequest } from "./wire.ts";

export type RefreshRequest = Extract<BrowserRequest, { readonly command: "refresh" }>;
/** A captured snapshot a refresh moves to: its id and the lines its manifest describes. */
export type FreshSnapshot = { readonly snapshotId: string; readonly snapshot: SnapshotLines };
/** A replayed or identical refresh has no snapshot change; `session` is what to persist, if any. */
export type RefreshOutcome = { readonly result: RefreshPayload; readonly session?: Session };

const withReasons = <Text extends GuidanceText>(
  text: Text,
  reasons: readonly OutdatedReason[],
): Text => {
  const all = new Set([...(text.outdated ?? []), ...reasons]);
  if (all.size === 0) return text;
  return { ...text, outdated: OutdatedReasonSchema.literals.filter((reason) => all.has(reason)) };
};

/**
 * The session reconciled onto `fresh`. Hunks keep their id, Viewed and group only through an exact
 * counterpart (`matchHunks`); new hunks start unviewed and ungrouped. Groups keep their place, an
 * emptied one included. Guidance is kept and marked Outdated rather than dropped: a note when its
 * anchored hunks or range changed, an overview when its group's or the review's hunks changed, and
 * any text whose references no longer map unchanged from their pinned snapshot. A note whose range
 * maps within its group moves with it; any other keeps its old anchor. References stay pinned. A
 * reference whose code reads differently than in the replaced snapshot unviews its note's anchored
 * hunks, never the target's.
 *
 * `retained` holds the lines of the session's current snapshot and of every snapshot its guidance
 * pins; a pin whose snapshot is missing cannot be verified, so its guidance is Outdated.
 */
export function refreshSession(
  session: Session,
  fresh: FreshSnapshot,
  retained: ReadonlyMap<string, SnapshotLines>,
  updatedAt: string,
): MutableSession {
  const draft = draftOf(session);
  const matches = matchHunks(session.hunks, fresh.snapshot.hunks);
  const survivorOf = new Map([...matches].map(([oldId, hunk]) => [hunk.id, oldId]));
  draft.hunks = fresh.snapshot.hunks.map((hunk) => ({
    ...hunk,
    id: survivorOf.get(hunk.id) ?? hunk.id,
  }));
  draft.snapshotId = fresh.snapshotId;

  const linesOf = (snapshotId: string) =>
    snapshotId === fresh.snapshotId ? fresh.snapshot : retained.get(snapshotId);
  const mapped = (range: CapturedRange, snapshotId: string) => {
    const from = linesOf(range.snapshotId);
    const to = linesOf(snapshotId);
    return from && to ? mapRange(from, to, range) : undefined;
  };
  const previous = linesOf(session.snapshotId);
  /**
   * Whether the pinned references still read the same lines in the fresh snapshot, and whether
   * any reads differently than in the replaced one, where the reader last read it.
   */
  const referencesOf = (text: GuidanceText) => ({
    changed: text.references.some((range) => !mapped(range, fresh.snapshotId)),
    changedNow: text.references.some((range) => {
      if (!previous) return true;
      const pinned = linesOf(range.snapshotId);
      const changed = pinned && contextChanged(pinned, previous, fresh.snapshot, range);
      return changed ?? sideChanged(previous, fresh.snapshot, range);
    }),
  });
  const overviewOf = (overview: GuidanceText | null, codeChanged: boolean) => {
    if (!overview) return overview;
    const reasons: OutdatedReason[] = [];
    if (codeChanged) reasons.push("code");
    if (referencesOf(overview).changed) reasons.push("references");
    return withReasons(overview, reasons);
  };

  const unviewed = new Set<string>();
  const reviewChanged =
    matches.size !== session.hunks.length || matches.size !== fresh.snapshot.hunks.length;
  draft.overview = overviewOf(draft.overview, reviewChanged);
  const fileOf = new Map(draft.hunks.map(({ id, file }) => [id, file]));
  draft.groups = draft.groups.map((group) => {
    const hunkIds = group.hunkIds.filter((id) => matches.has(id));
    const files = new Set(hunkIds.map((id) => fileOf.get(id)));
    const notes = group.notes.map((note) => {
      const range = mapped(note.anchor, fresh.snapshotId);
      const moved = range && { ...range, snapshotId: fresh.snapshotId };
      const after = moved ? anchoredHunkIds(draft.hunks, moved) : [];
      // A note reads beside its group's code, so one whose range maps only outside the group
      // stays on its earlier code, where the group still discloses it.
      const anchor = moved && after.some((id) => hunkIds.includes(id)) ? moved : undefined;
      const earlier = note.anchor.snapshotId !== session.snapshotId;
      const before = earlier ? [] : anchoredHunkIds(session.hunks, note.anchor);
      // A note kept on earlier code still reads beside its anchored hunks that survived since:
      // its pinned snapshot's, through their exact counterparts in the replaced one.
      const pinned = earlier ? linesOf(note.anchor.snapshotId) : undefined;
      const surviving = pinned
        ? survivingHunkIds(pinned.hunks, session.hunks, note.anchor)
        : before;
      const references = referencesOf(note);
      const reasons: OutdatedReason[] = [];
      if (
        !anchor ||
        before.some((id) => !matches.has(id)) ||
        before.length !== after.length ||
        after.some((id) => !before.includes(id))
      )
        reasons.push("code");
      if (references.changed) reasons.push("references");
      // Surviving hunks keep their id, so this reaches the note's former hunks that still exist.
      if (references.changedNow)
        for (const id of [...surviving, ...(anchor ? after : [])]) unviewed.add(id);
      return withReasons({ ...note, anchor: anchor ?? note.anchor }, reasons);
    });
    return {
      ...group,
      hunkIds,
      files: group.files.filter((file) => files.has(file)),
      overview: overviewOf(group.overview, hunkIds.length !== group.hunkIds.length),
      notes,
    };
  });
  // A note's thread and drafts follow the note, wherever it now sits. Any other thread or draft moves
  // only where every line of its range maps unchanged, independently of hunk identity; otherwise it
  // keeps its original code, pinned. Messages, Pending, resolution and wording are never touched.
  const notesNow = new Map(
    draft.groups.flatMap(({ notes }) => notes.map((note) => [note.id, note] as const)),
  );
  for (const item of [...draft.threads, ...draft.drafts]) {
    const note = item.note && !item.note.removed ? notesNow.get(item.note.id) : undefined;
    const range = note ? undefined : mapped(item.anchor, fresh.snapshotId);
    if (note) item.anchor = note.anchor;
    else if (range) item.anchor = { ...range, snapshotId: fresh.snapshotId };
  }
  draft.viewedHunkIds = draft.viewedHunkIds.filter((id) => matches.has(id) && !unviewed.has(id));
  draft.revision++;
  draft.updatedAt = updatedAt;
  return draft;
}

/**
 * The captured files the session still needs, by snapshot, its current one first. Of the current
 * snapshot and of each snapshot a live draft was begun on (its message's links, written in the
 * browser, may name any file) it keeps every file (`"all"`). Of any other it keeps both sides of
 * each file its guidance anchors or references, conversations (resolved ones included), messages,
 * reply wording and its note's code, and drafts name; the manifest stays whole, so a pin still maps
 * on refresh. Reads may name exactly these, and storage reclaims the rest.
 */
export function retainedFiles(session: Session): ReadonlyMap<string, ReadonlySet<string> | "all"> {
  const kept = new Map<string, Set<string> | "all">([[session.snapshotId, "all"]]);
  const pinRange = ({ snapshotId, path }: CapturedRange) => {
    const paths = kept.get(snapshotId) ?? new Set<string>();
    if (paths === "all") return;
    paths.add(path);
    kept.set(snapshotId, paths);
  };
  const pin = (text: Pick<GuidanceText, "references"> | null | undefined) => {
    for (const range of text?.references ?? []) pinRange(range);
  };
  const pinWording = (wording: Wording | undefined) => {
    pin(wording);
    if (wording) pinRange(wording.anchor);
  };
  for (const draft of session.drafts) kept.set(draft.snapshotId, "all");
  for (const thread of session.threads) {
    pinRange(thread.anchor);
    for (const message of thread.messages) {
      pin(message);
      if (message.author === "human") pinWording(message.wording);
    }
  }
  for (const draft of session.drafts) {
    pinRange(draft.anchor);
    pinWording(draft.wording);
  }
  pin(session.overview);
  for (const group of session.groups) {
    pin(group.overview);
    for (const note of group.notes) {
      pinRange(note.anchor);
      pin(note);
    }
  }
  return kept;
}

/** Whether the session still keeps `path` of `snapshotId` (see `retainedFiles`). */
export function keepsFile(session: Session, snapshotId: string, path: string): boolean {
  const paths = retainedFiles(session).get(snapshotId);
  return paths === "all" || (paths?.has(path) ?? false);
}

/** The snapshots `retainedFiles` keeps anything of, the current one first. */
export function pinnedSnapshotIds(session: Session): string[] {
  return [...retainedFiles(session).keys()];
}

/**
 * A refresh's recorded answer for `request.requestId`, or undefined when it has none and the
 * request still names the current snapshot. Receipts answer first, so a retry after a lost reply
 * gets its original result however the session moved on; the same id with another payload, or a
 * new request for a replaced snapshot, fails.
 */
export function recordedRefresh(
  session: Session,
  request: RefreshRequest,
): Result.Result<RefreshPayload | undefined, StaleRevision | ValidationFailed> {
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the request.
  const digest = hash(JSON.stringify(request));
  const receipt = session.refreshReceipts.find(({ requestId }) => requestId === request.requestId);
  if (receipt) {
    if (receipt.digest === digest) return Result.succeed(receipt.result);
    return Result.fail(
      new ValidationFailed({
        message: "request id reused with a different payload",
        detail: { requestId: request.requestId },
      }),
    );
  }
  if (request.snapshotId !== session.snapshotId)
    return Result.fail(
      new StaleRevision({
        message: `refresh was requested for snapshot ${request.snapshotId}, which a refresh already replaced; read the session again`,
        detail: { snapshotId: session.snapshotId, revision: session.revision },
      }),
    );
  return Result.succeed(undefined);
}

/**
 * Commits one refresh of `session` onto `fresh`, all or nothing, with its receipt. An identical
 * capture keeps the snapshot, revision and review state and records only the receipt.
 */
export function refresh(
  session: Session,
  request: RefreshRequest,
  fresh: FreshSnapshot,
  retained: ReadonlyMap<string, SnapshotLines>,
  updatedAt: string,
): Result.Result<RefreshOutcome, StaleRevision | ValidationFailed> {
  const recorded = recordedRefresh(session, request);
  if (Result.isFailure(recorded)) return Result.fail(recorded.failure);
  if (recorded.success) return Result.succeed({ result: recorded.success });
  const replaced = fresh.snapshotId !== session.snapshotId;
  const draft = replaced ? refreshSession(session, fresh, retained, updatedAt) : draftOf(session);
  const result: RefreshPayload = {
    sessionId: session.id,
    previousSnapshotId: session.snapshotId,
    snapshotId: draft.snapshotId,
    revision: draft.revision,
    replaced,
  };
  draft.refreshReceipts.push({
    requestId: request.requestId,
    digest: hash(JSON.stringify(request)),
    result,
  });
  return Result.succeed({ result, session: draft });
}
