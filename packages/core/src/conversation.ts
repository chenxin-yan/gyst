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
  ThreadEntry,
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

const wordingKey = ({ markdown, references, anchor }: Wording) =>
  JSON.stringify([markdown, references.map(anchorKey), anchorKey(anchor)]);

/** A thread's `version`: an identity of its messages and resolution, the thread a human read. */
export const threadVersionOf = (thread: Pick<Thread, "resolved" | "messages">) =>
  hash(JSON.stringify([thread.resolved, thread.messages]));

const isPending = (message: Thread["messages"][number]) =>
  message.author === "human" && message.pending;
const hasPending = (thread: Thread) => thread.messages.some(isPending);

/** A thread as the browser's conversations listing names it, its messages left to `messages`. */
export const threadEntryOf = ({ messages, ...thread }: Thread): ThreadEntry => ({
  ...thread,
  version: threadVersionOf({ resolved: thread.resolved, messages }),
  messageCount: messages.length,
  pendingCount: messages.filter(isPending).length,
});

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

/** The captured ranges a retrieval returns code of: each thread's anchor, and the note anchors its replies were composed against. */
export const threadAnchorsOf = (thread: Thread): CapturedRange[] => [
  thread.anchor,
  ...thread.messages.flatMap((message) =>
    message.author === "human" && message.wording ? [message.wording.anchor] : [],
  ),
];

/**
 * One retrieval, all at once: the threads `mode` selected in `invoked`, the session as the
 * retrieval was asked for, each with its whole history and the captured code of its anchors
 * (`code`, by `anchorKey`), with exactly their Pending messages of then read and so frozen. A
 * message arriving since waits for the next retrieval; one edited since is returned as it is now,
 * and one deleted since is gone. The bundle and its receipt are recorded together, so a retry, even
 * after later arrivals, returns this bundle; nothing a retrieval leaves out is frozen. Viewed is
 * untouched.
 */
export function pickUp(
  session: Session,
  request: ThreadsRequest,
  code: ReadonlyMap<string, ThreadCode>,
  updatedAt: string,
  invoked: Session = session,
): Result.Result<PickupOutcome, BadArgs | ValidationFailed> {
  if (!request.requestId)
    return Result.fail(new BadArgs({ message: "threads needs a request id" }));
  const recorded = recordedPickup(session, request);
  if (Result.isFailure(recorded)) return Result.fail(recorded.failure);
  if (recorded.success) return Result.succeed({ result: recorded.success });
  const draft = draftOf(session);
  const chosen = threadsFor(invoked, request.mode);
  const bound = new Set(
    chosen.flatMap(({ messages }) =>
      messages.flatMap((message) =>
        message.author === "human" && message.pending ? [message.id] : [],
      ),
    ),
  );
  const selected = new Set(chosen.map(({ id }) => id));
  const codeOf = (anchor: CapturedRange): ThreadCode =>
    code.get(anchorKey(anchor)) ?? {
      kind: "unavailable",
      reason: "its captured content could not be read",
    };
  const later = (message: Thread["messages"][number]) =>
    message.author === "human" && message.pending && !bound.has(message.id);
  const threads: ThreadsPayload["threads"][number][] = [];
  for (const thread of draft.threads) {
    if (!selected.has(thread.id) || thread.resolved) continue;
    const unread: string[] = [];
    const messages = thread.messages.map((message) => {
      if (message.author !== "human" || !message.pending || !bound.has(message.id)) return message;
      unread.push(message.id);
      return { ...message, pending: false };
    });
    // Its Pending messages of then were all deleted since: nothing is left to pick up.
    if (request.mode === "pending" && unread.length === 0) continue;
    const history = messages.filter((message) => !later(message));
    // Every message it held then was deleted since, so all it has arrived since and waits.
    if (history.length === 0) continue;
    thread.messages = messages;
    const returned = { ...thread, messages: history };
    const earlier = new Map(
      threadAnchorsOf(returned)
        .slice(1)
        .filter((anchor) => anchorKey(anchor) !== anchorKey(thread.anchor))
        .map((anchor) => [anchorKey(anchor), anchor]),
    );
    threads.push({
      ...returned,
      code: codeOf(thread.anchor),
      earlierCode: [...earlier.values()].map((anchor) => ({ anchor, code: codeOf(anchor) })),
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
 * range, and the `gyst:` references of a message it writes, which pin to the snapshot current
 * when its draft was begun, or for an edit to the current one.
 */
export function conversationTargetsOf(
  request: ConversationRequest,
  session: Session,
): { readonly snapshotId: string; readonly range: CodeRange }[] {
  if (request.command === "draft" && request.target.kind === "comment")
    return [{ snapshotId: request.target.anchor.snapshotId, range: request.target.anchor }];
  const snapshotId =
    request.command === "send"
      ? session.drafts.find(({ id }) => id === request.draft)?.snapshotId
      : session.snapshotId;
  if ((request.command === "send" || request.command === "edit") && request.markdown !== undefined)
    return inspectMarkdown(request.markdown).references.map((range) => ({
      snapshotId: snapshotId ?? session.snapshotId,
      range,
    }));
  return [];
}

const idOf = (kind: string, requestId: string) => hash(`${kind}\0${requestId}`);

/**
 * One human conversation action, all or nothing, with its receipt. A recorded `requestId` answers
 * first, so a retry after a lost reply gets its original result however the session moved on.
 * Actions name their targets, never a revision; an edit or deletion also names the message as
 * the human read it, and a resolution or reopening the thread. `captured` indexes the snapshots `conversationTargetsOf` names. Viewed is
 * never touched.
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
  /**
   * The Markdown of a human message, each reference pinned to `snapshotId` unless it is one of
   * `kept`, the references it already had, which keep their pins: a correction rebinds nothing.
   */
  const written = (
    markdown: string,
    snapshotId: string,
    kept: readonly CapturedRange[] = [],
  ): Result.Result<Omit<Wording, "anchor">, StaleRevision | ValidationFailed> => {
    const { references, problems } = inspectMarkdown(markdown);
    if (problems.length) return invalid("the message breaks the rich-content policy", problems);
    const keptOf = (range: CodeRange) =>
      kept.find(
        (pin) =>
          pin.path === range.path &&
          pin.side === range.side &&
          pin.startLine === range.startLine &&
          pin.endLine === range.endLine,
      );
    const fresh = references.filter((range) => !keptOf(range));
    const index = indexOf(snapshotId);
    if (fresh.length && !index)
      return Result.fail(
        new StaleRevision({
          message: "the snapshot changed while the message was checked; send it again",
          detail: { snapshotId: session.snapshotId },
        }),
      );
    const problemsOf = fresh.flatMap((range) => {
      const problem = capturedProblem(index!, range);
      return problem ? [`reference gyst:${range.side}/${range.path}: ${problem}`] : [];
    });
    if (problemsOf.length)
      return invalid("the message has references outside captured text", problemsOf);
    return Result.succeed({
      markdown,
      references: references.map((range) => keptOf(range) ?? { snapshotId, ...range }),
    });
  };
  /**
   * The note as the human sees it; `seen` must still be its text, links and code, so nothing
   * rebinds unseen, not even a note moved with its words unchanged.
   */
  const wordingOf = (id: string, seen: Wording | undefined) => {
    const { markdown, references, anchor } = noteOf(id)!;
    const wording = { markdown, references, anchor };
    if (seen === undefined || wordingKey(seen) !== wordingKey(wording))
      return Result.fail(
        new StaleRevision({
          message: `note ${id} changed since it was read; read the session again`,
          detail: { snapshotId: session.snapshotId, revision: session.revision },
        }),
      );
    return Result.succeed(wording);
  };
  const reopenFirst = (id: string) =>
    invalid(`thread ${id} is resolved; reopen it before replying`, { thread: id });
  /** A Pending human message, still as the human last read it (`seen`), so no edit overwrites unseen. */
  const pendingOnly = (
    id: string,
    seen: Pick<HumanMessage, "markdown" | "kind">,
  ): Result.Result<
    { thread: MutableThread; index: number; message: HumanMessage },
    StaleRevision | ValidationFailed
  > => {
    const found = messageOf(id);
    if (!found) return invalid(`message ${id} does not exist`, { message: id });
    const { message } = found;
    if (message.author !== "human")
      return invalid("agent replies cannot be changed", { message: id });
    if (!message.pending)
      return invalid(`message ${id} was already read; send a correction as a new reply`, {
        message: id,
      });
    if (message.markdown !== seen.markdown || message.kind !== seen.kind)
      return Result.fail(
        new StaleRevision({
          message: `message ${id} changed since it was read; read it again`,
          detail: { snapshotId: session.snapshotId, revision: session.revision },
        }),
      );
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
        draft.drafts.push({ id, snapshotId: session.snapshotId, anchor });
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
          snapshotId: session.snapshotId,
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
        snapshotId: session.snapshotId,
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
      const text = written(request.markdown, pinned.snapshotId);
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
      const found = pendingOnly(request.message, request.seen);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { thread, index, message } = found.success;
      let edited: HumanMessage = { ...message, ...(request.kind && { kind: request.kind }) };
      if (request.markdown !== undefined) {
        const text = written(request.markdown, session.snapshotId, message.references);
        if (Result.isFailure(text)) return Result.fail(text.failure);
        edited = { ...edited, ...text.success };
      }
      thread.messages[index] = edited;
      changed();
      return Result.succeed({ thread: thread.id, message: message.id });
    }
    case "retract": {
      const found = pendingOnly(request.message, request.seen);
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
      if (threadVersionOf(thread) !== request.seen)
        return Result.fail(
          new StaleRevision({
            message: `thread ${thread.id} changed since it was read; read it again`,
            detail: { snapshotId: session.snapshotId, revision: session.revision },
          }),
        );
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
