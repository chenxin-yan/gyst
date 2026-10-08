import { Result } from "effect";
import { type CapturedIndex, capturedProblem } from "./apply.ts";
import { draftOf, type MutableSession, type MutableThread } from "./draft.ts";
import { BadArgs, StaleRevision, ValidationFailed } from "./errors.ts";
import type { CapturedRange, CodeRange } from "./guidance.ts";
import { hash } from "./hash.ts";
import { inspectMarkdown } from "./markdown.ts";
import { pinnedSnapshotIds } from "./refresh.ts";
import type { Session } from "./session.ts";
import type {
  ConversationResult,
  HumanMessage,
  Thread,
  ThreadCode,
  ThreadsPayload,
  Wording,
} from "./thread.ts";
import type { BrowserRequest, Request } from "./wire.ts";

export type ConversationRequest = Extract<
  BrowserRequest,
  { readonly command: "draft" | "send" | "edit" | "retract" | "resolve" | "discard" }
>;
export type ThreadsRequest = Extract<Request, { readonly command: "threads" }>;
/** A replayed request returns its recorded result and no session to persist. */
export type ConversationOutcome = {
  readonly result: ConversationResult;
  readonly session?: Session;
};
/** A replayed retrieval returns its recorded bundle and no session to persist. */
export type PickupOutcome = { readonly result: ThreadsPayload; readonly session?: Session };

/** A key naming one captured range, for the code a retrieval returns with its thread. */
export const anchorKey = ({ snapshotId, path, side, startLine, endLine }: CapturedRange) =>
  `${snapshotId}\0${side}\0${path}\0${startLine}\0${endLine}`;

const hasPending = (thread: Thread) =>
  thread.messages.some((message) => message.author === "human" && message.pending);

/**
 * The threads a retrieval in `mode` returns: open ones only, and for `pending` only those holding a
 * Pending message now. A resolved thread waits, its Pending messages included, until reopened.
 */
export const threadsFor = (session: Session, mode: ThreadsRequest["mode"]) =>
  session.threads.filter((thread) => !thread.resolved && (mode === "open" || hasPending(thread)));

const reused = (requestId: string) =>
  new ValidationFailed({
    message: "request id reused with a different payload",
    detail: { requestId },
  });

/** A retrieval's recorded bundle, or undefined when `request.requestId` has none. */
export function recordedPickup(
  session: Session,
  request: ThreadsRequest,
): Result.Result<ThreadsPayload | undefined, ValidationFailed> {
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the request.
  const digest = hash(JSON.stringify(request));
  const receipt = session.pickupReceipts.find(({ requestId }) => requestId === request.requestId);
  if (!receipt) return Result.succeed(undefined);
  return receipt.digest === digest
    ? Result.succeed(receipt.result)
    : Result.fail(reused(request.requestId));
}

/**
 * One retrieval, all at once: the threads `mode` selects now, each with its whole history and the
 * captured code of its anchor (`code`, by `anchorKey`), with exactly their Pending messages read and
 * so frozen. The bundle and its receipt are recorded together, so a retry, even after later
 * arrivals, returns this bundle; nothing a retrieval leaves out is frozen. Viewed is untouched.
 */
export function pickUp(
  session: Session,
  request: ThreadsRequest,
  code: ReadonlyMap<string, ThreadCode>,
  updatedAt: string,
): Result.Result<PickupOutcome, BadArgs | ValidationFailed> {
  if (!request.requestId)
    return Result.fail(new BadArgs({ message: "threads needs a request id" }));
  const recorded = recordedPickup(session, request);
  if (Result.isFailure(recorded)) return Result.fail(recorded.failure);
  if (recorded.success) return Result.succeed({ result: recorded.success });
  const draft = draftOf(session);
  const selected = new Set(threadsFor(session, request.mode).map(({ id }) => id));
  const threads: ThreadsPayload["threads"][number][] = [];
  for (const thread of draft.threads) {
    if (!selected.has(thread.id)) continue;
    const unread: string[] = [];
    thread.messages = thread.messages.map((message) => {
      if (message.author !== "human" || !message.pending) return message;
      unread.push(message.id);
      return { ...message, pending: false };
    });
    threads.push({
      ...thread,
      code: code.get(anchorKey(thread.anchor)) ?? {
        kind: "unavailable",
        reason: "its captured content could not be read",
      },
      unread,
    });
  }
  if (threads.some(({ unread }) => unread.length > 0)) {
    draft.revision++;
    draft.updatedAt = updatedAt;
  }
  const result: ThreadsPayload = {
    sessionId: session.id,
    snapshotId: session.snapshotId,
    revision: draft.revision,
    progress: { viewed: session.viewedHunkIds.length, total: session.hunks.length },
    openThreads: draft.threads.filter(({ resolved }) => !resolved).length,
    threads,
  };
  draft.pickupReceipts.push({
    requestId: request.requestId,
    digest: hash(JSON.stringify(request)),
    result,
  });
  return Result.succeed({ result, session: draft });
}

/**
 * The captured sides a conversation action needs line counts of, by snapshot: a new comment's
 * range, and the `gyst:` references of a message it writes, which pin to the current snapshot.
 */
export function conversationTargetsOf(
  request: ConversationRequest,
  session: Session,
): { readonly snapshotId: string; readonly range: CodeRange }[] {
  if (request.command === "draft" && request.target.kind === "comment")
    return [{ snapshotId: request.target.anchor.snapshotId, range: request.target.anchor }];
  if ((request.command === "send" || request.command === "edit") && request.markdown !== undefined)
    return inspectMarkdown(request.markdown).references.map((range) => ({
      snapshotId: session.snapshotId,
      range,
    }));
  return [];
}

const idOf = (kind: string, requestId: string) => hash(`${kind}\0${requestId}`);

/**
 * One human conversation action, all or nothing, with its receipt. A recorded `requestId` answers
 * first, so a retry after a lost reply gets its original result however the session moved on.
 * Actions name their targets, never a revision. `captured` indexes the snapshots
 * `conversationTargetsOf` names. Viewed is never touched.
 */
export function converse(
  session: Session,
  request: ConversationRequest,
  captured: readonly CapturedIndex[],
  updatedAt: string,
): Result.Result<ConversationOutcome, BadArgs | StaleRevision | ValidationFailed> {
  const { requestId } = request;
  if (!requestId)
    return Result.fail(new BadArgs({ message: `${request.command} needs a request id` }));
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the request.
  const digest = hash(JSON.stringify(request));
  const receipt = session.conversationReceipts.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (receipt)
    return receipt.digest === digest
      ? Result.succeed({ result: receipt.result })
      : Result.fail(reused(requestId));
  const draft = draftOf(session);
  const acted = act(draft, session, request, captured, updatedAt);
  if (Result.isFailure(acted)) return Result.fail(acted.failure);
  const result: ConversationResult = {
    sessionId: session.id,
    revision: draft.revision,
    ...acted.success,
  };
  draft.conversationReceipts.push({ requestId, digest, result });
  return Result.succeed({ result, session: draft });
}

const invalid = (message: string, detail?: unknown): Result.Result<never, ValidationFailed> =>
  Result.fail(new ValidationFailed({ message, ...(detail !== undefined && { detail }) }));

type Made = Omit<ConversationResult, "sessionId" | "revision">;

function act(
  draft: MutableSession,
  session: Session,
  request: ConversationRequest,
  captured: readonly CapturedIndex[],
  updatedAt: string,
): Result.Result<Made, StaleRevision | ValidationFailed> {
  const indexOf = (snapshotId: string) => captured.find((index) => index.snapshotId === snapshotId);
  const noteOf = (id: string) =>
    draft.groups.flatMap(({ notes }) => notes).find((note) => note.id === id);
  const threadOf = (id: string) => draft.threads.find((thread) => thread.id === id);
  const noteThreadOf = (id: string) =>
    draft.threads.find(({ note }) => note?.id === id && !note.removed);
  const messageOf = (id: string) => {
    for (const thread of draft.threads) {
      const index = thread.messages.findIndex((message) => message.id === id);
      if (index >= 0) return { thread, index, message: thread.messages[index]! };
    }
    return undefined;
  };
  const changed = () => {
    draft.revision++;
    draft.updatedAt = updatedAt;
  };
  /** The Markdown of a human message, its references pinned to the current snapshot. */
  const written = (markdown: string): Result.Result<Wording, StaleRevision | ValidationFailed> => {
    const { references, problems } = inspectMarkdown(markdown);
    if (problems.length) return invalid("the message breaks the rich-content policy", problems);
    if (references.length === 0) return Result.succeed({ markdown, references: [] });
    const index = indexOf(session.snapshotId);
    if (!index)
      return Result.fail(
        new StaleRevision({
          message: "the snapshot changed while the message was checked; send it again",
          detail: { snapshotId: session.snapshotId },
        }),
      );
    const problemsOf = references.flatMap((range) => {
      const problem = capturedProblem(index, range);
      return problem ? [`reference gyst:${range.side}/${range.path}: ${problem}`] : [];
    });
    if (problemsOf.length)
      return invalid("the message has references outside captured text", problemsOf);
    return Result.succeed({
      markdown,
      references: references.map((range) => ({ snapshotId: session.snapshotId, ...range })),
    });
  };
  /** The note's text as the human sees it; `seen` must still be it, so nothing rebinds unseen. */
  const wordingOf = (id: string, seen: string | undefined) => {
    const note = noteOf(id)!;
    if (seen !== note.markdown)
      return Result.fail(
        new StaleRevision({
          message: `note ${id} changed since it was read; read the session again`,
          detail: { snapshotId: session.snapshotId, revision: session.revision },
        }),
      );
    return Result.succeed({ markdown: note.markdown, references: note.references });
  };
  const reopenFirst = (id: string) =>
    invalid(`thread ${id} is resolved; reopen it before replying`, { thread: id });
  const pendingOnly = (id: string) => {
    const found = messageOf(id);
    if (!found) return invalid(`message ${id} does not exist`, { message: id });
    const { message } = found;
    if (message.author !== "human")
      return invalid("agent replies cannot be changed", { message: id });
    if (!message.pending)
      return invalid(`message ${id} was already read; send a correction as a new reply`, {
        message: id,
      });
    return Result.succeed({ ...found, message });
  };

  switch (request.command) {
    case "draft": {
      const id = idOf("draft", request.requestId);
      const { target } = request;
      if (target.kind === "comment") {
        const { anchor } = target;
        if (!pinnedSnapshotIds(session).includes(anchor.snapshotId))
          return Result.fail(
            new StaleRevision({
              message: `snapshot ${anchor.snapshotId} is not the current snapshot of session ${session.id}, nor one it still pins; read the session again`,
              detail: { snapshotId: session.snapshotId, revision: session.revision },
            }),
          );
        const index = indexOf(anchor.snapshotId);
        const problem = index ? capturedProblem(index, anchor) : "its captured lines were not read";
        if (problem) return invalid(`cannot comment there: ${problem}`, { anchor });
        draft.drafts.push({ id, anchor });
        return Result.succeed({ draft: id });
      }
      if (target.kind === "thread") {
        const thread = threadOf(target.thread);
        if (!thread) return invalid(`thread ${target.thread} does not exist`, target);
        if (thread.resolved) return reopenFirst(thread.id);
        const live = thread.note && !thread.note.removed ? thread.note : undefined;
        const wording = live ? wordingOf(live.id, request.wording) : undefined;
        if (wording && Result.isFailure(wording)) return Result.fail(wording.failure);
        draft.drafts.push({
          id,
          anchor: thread.anchor,
          thread: thread.id,
          ...(thread.note && { note: thread.note }),
          ...(wording && { wording: wording.success }),
        });
        return Result.succeed({ draft: id });
      }
      const note = noteOf(target.note);
      if (!note) return invalid(`note ${target.note} does not exist`, target);
      const thread = noteThreadOf(note.id);
      if (thread?.resolved) return reopenFirst(thread.id);
      const wording = wordingOf(note.id, request.wording);
      if (Result.isFailure(wording)) return Result.fail(wording.failure);
      draft.drafts.push({
        id,
        anchor: note.anchor,
        ...(thread && { thread: thread.id }),
        note: { id: note.id, removed: false },
        wording: wording.success,
      });
      return Result.succeed({ draft: id });
    }
    case "send": {
      const at = draft.drafts.findIndex(({ id }) => id === request.draft);
      if (at < 0)
        return invalid(`draft ${request.draft} does not exist; it was sent or discarded`, {
          draft: request.draft,
        });
      const pinned = draft.drafts[at]!;
      const text = written(request.markdown);
      if (Result.isFailure(text)) return Result.fail(text.failure);
      const message: HumanMessage = {
        id: idOf("message", request.requestId),
        author: "human",
        kind: request.kind,
        pending: true,
        ...text.success,
        ...(pinned.wording && { wording: pinned.wording }),
        createdAt: updatedAt,
      };
      // A reply goes where it was composed: its thread, else its note's thread, made on first reply.
      let thread: MutableThread | undefined = pinned.thread ? threadOf(pinned.thread) : undefined;
      if (!thread && pinned.note && !pinned.note.removed) thread = noteThreadOf(pinned.note.id);
      if (!thread && pinned.thread && !pinned.note)
        return invalid(`thread ${pinned.thread} no longer exists`, { thread: pinned.thread });
      if (thread?.resolved) return reopenFirst(thread.id);
      if (thread) thread.messages.push(message);
      else {
        thread = {
          id: idOf("thread", request.requestId),
          anchor: pinned.anchor,
          ...(pinned.note && { note: pinned.note }),
          resolved: false,
          messages: [message],
        };
        draft.threads.push(thread);
      }
      draft.drafts.splice(at, 1);
      changed();
      return Result.succeed({ thread: thread.id, message: message.id });
    }
    case "edit": {
      const found = pendingOnly(request.message);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { thread, index, message } = found.success;
      let edited: HumanMessage = { ...message, ...(request.kind && { kind: request.kind }) };
      if (request.markdown !== undefined) {
        const text = written(request.markdown);
        if (Result.isFailure(text)) return Result.fail(text.failure);
        edited = { ...edited, ...text.success };
      }
      thread.messages[index] = edited;
      changed();
      return Result.succeed({ thread: thread.id, message: message.id });
    }
    case "retract": {
      const found = pendingOnly(request.message);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { thread, index, message } = found.success;
      thread.messages.splice(index, 1);
      // An empty thread disappears; its note, if any, stays as it is.
      if (thread.messages.length === 0) draft.threads.splice(draft.threads.indexOf(thread), 1);
      changed();
      return Result.succeed({ thread: thread.id, message: message.id });
    }
    case "resolve": {
      const thread = threadOf(request.thread);
      if (!thread)
        return invalid(`thread ${request.thread} does not exist`, { thread: request.thread });
      if (thread.resolved !== request.resolved) {
        thread.resolved = request.resolved;
        changed();
      }
      return Result.succeed({ thread: thread.id });
    }
    case "discard": {
      // Discarding a draft already gone is done already.
      draft.drafts = draft.drafts.filter(({ id }) => id !== request.draft);
      return Result.succeed({ draft: request.draft });
    }
  }
}
