import type {
  BrowserRequest,
  CapturedRange,
  ConversationResult,
  ConversationsPayload,
  Draft,
  Message,
  MessageKind,
  Thread,
} from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { isExpectedFailure, isUncertain, newRequestId, operation } from "./api.ts";
import { Dialog } from "./commands.tsx";
import { PillButton, useMounted } from "./components.tsx";
import {
  commentsOrder,
  type DraftText,
  type draftChange,
  draftText,
  forgetDraftText,
  keepDraftText,
  liveNote,
  pendingCount,
  replyOutdated,
  threadLocation,
} from "./conversation.ts";
import { RichText } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";
import type { StatusNote } from "./walkthrough.ts";

type HumanAction = Extract<
  BrowserRequest,
  { command: "draft" | "send" | "edit" | "retract" | "resolve" | "discard" }
>;
/**
 * A human action as the reader asks for it: the session is the reader's own, and the request id
 * the intent's (see `useConversations`).
 */
export type Act = (
  request: HumanAction extends infer Request
    ? Request extends HumanAction
      ? Omit<Request, "session" | "requestId">
      : never
    : never,
) => Promise<ConversationResult>;

/**
 * The session's threads and draft pins, read again whenever the live link announces other
 * conversations and after each action of this reader. A late read never replaces a newer one. An
 * action whose reply was lost keeps its request id, so doing the same again is its retry.
 */
export function useConversations(sessionId: string, announced: string | undefined) {
  const [read, setRead] = useState<ConversationsPayload>();
  const latest = useRef<ConversationsPayload>(undefined);
  const known = useRef(announced);
  known.current = announced;
  const mounted = useMounted();
  // One read at a time, each skipped once a read already shows what was announced, so the first
  // announcement after the mount's read costs nothing. An action's own read always runs: a draft
  // pin changes no conversation.
  const queue = useRef(Promise.resolve());
  const load = useCallback(
    (always: boolean) =>
      (queue.current = queue.current.then(async () => {
        if (!always && latest.current !== undefined && known.current === latest.current.version)
          return;
        try {
          const answer = await operation({ command: "conversations", session: sessionId });
          if (!mounted.current || (latest.current && answer.revision < latest.current.revision))
            return;
          latest.current = answer;
          setRead(answer);
        } catch (error) {
          // The live link reports an outage; the next announcement reads again.
          if (!isExpectedFailure(error)) console.error(error);
        }
      })),
    [sessionId, mounted],
  );
  useEffect(() => void load(false), [load, announced]);
  const uncertain = useRef(new Map<string, string>());
  const act = useCallback<Act>(
    async (request) => {
      const intent = JSON.stringify(request);
      const requestId = uncertain.current.get(intent) ?? newRequestId();
      uncertain.current.set(intent, requestId);
      try {
        const result = await operation({ ...request, requestId, session: sessionId });
        uncertain.current.delete(intent);
        await load(true);
        return result;
      } catch (error) {
        if (!isUncertain(error)) uncertain.current.delete(intent);
        throw error;
      }
    },
    [sessionId, load],
  );
  return { threads: read?.threads ?? [], drafts: read?.drafts ?? [], act };
}

const kindLabel: Record<MessageKind, string> = { question: "Question", change: "Change request" };

/** Why an action failed, in words, for the line under its control. */
const failureText = (error: unknown) =>
  isUncertain(error)
    ? "gyst didn't answer. Try again; it won't be sent twice."
    : error instanceof Error && error.message
      ? error.message
      : "That didn't work.";

/**
 * A message's text and kind being written: Enter sends, Shift+Enter adds a line, Escape leaves it
 * as it is. Review keys never fire from inside it.
 */
function MessageField(props: {
  label: string;
  text: DraftText;
  onText: (text: DraftText) => void;
  onSubmit: () => void;
  onEscape: () => void;
  submit: string;
  busy: boolean;
  disabled?: string | undefined;
  children?: ReactNode;
}) {
  const { text } = props;
  const empty = text.markdown.trim() === "";
  return (
    <div {...stylex.props(styles.field)}>
      <textarea
        aria-label={props.label}
        autoFocus
        rows={3}
        value={text.markdown}
        placeholder="Write in Markdown…"
        onChange={(event) => props.onText({ ...text, markdown: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!empty && !props.busy && props.disabled === undefined) props.onSubmit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onEscape();
          }
        }}
        {...stylex.props(styles.textarea)}
      />
      <div {...stylex.props(styles.row)}>
        <select
          aria-label="Kind"
          value={text.kind}
          onChange={(event) => props.onText({ ...text, kind: event.target.value as MessageKind })}
          {...stylex.props(styles.select)}
        >
          <option value="question">Question</option>
          <option value="change">Change request</option>
        </select>
        <PillButton
          disabled={empty || props.busy || props.disabled !== undefined}
          title={props.disabled}
          onClick={props.onSubmit}
        >
          {props.submit}
        </PillButton>
        {props.children}
      </div>
    </div>
  );
}

/**
 * The composer of one draft, shown only for a new comment or an explicit reply. Its text is kept
 * for the page's life, so closing it, switching sessions or losing the connection loses nothing;
 * nothing is sent while gyst can't be reached, and a send whose reply was lost is sent again under
 * its own request id.
 */
export function Composer(props: {
  sessionId: string;
  draft: Draft;
  /** What changed under the draft since it was begun, said beside it. */
  change: ReturnType<typeof draftChange>;
  /** Why nothing can be sent now, such as a lost connection. */
  offline: string | undefined;
  act: Act;
  onClose: () => void;
}) {
  const { sessionId, draft } = props;
  const [text, setText] = useState(() => draftText(sessionId, draft.id));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const mounted = useMounted();
  const write = (next: DraftText) => {
    setText(next);
    keepDraftText(sessionId, draft.id, next);
  };
  const send = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await props.act({
        command: "send",
        draft: draft.id,
        markdown: text.markdown,
        kind: text.kind,
      });
      forgetDraftText(sessionId, draft.id);
      if (mounted.current) props.onClose();
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(failureText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await props.act({ command: "discard", draft: draft.id });
      forgetDraftText(sessionId, draft.id);
      if (mounted.current) props.onClose();
    } catch (error) {
      if (mounted.current) setFailure(failureText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const blocked = props.offline ?? (props.change?.blocks ? props.change.message : undefined);
  return (
    <div data-composer={draft.id} {...stylex.props(styles.composer)}>
      <p {...stylex.props(styles.meta)}>
        {draft.thread !== undefined || draft.note !== undefined ? "Reply" : "Comment"} on{" "}
        {threadLocation(draft.anchor, draft.anchor.snapshotId)}
      </p>
      {props.change && (
        <p role="note" {...stylex.props(styles.flag)}>
          {props.change.message}
        </p>
      )}
      <MessageField
        label={draft.thread !== undefined || draft.note !== undefined ? "Reply" : "Comment"}
        text={text}
        onText={write}
        onSubmit={() => void send()}
        onEscape={props.onClose}
        submit="Send"
        busy={busy}
        disabled={blocked}
      >
        <PillButton onClick={props.onClose}>Close</PillButton>
        <PillButton disabled={busy} onClick={() => void discard()}>
          Discard
        </PillButton>
      </MessageField>
      {(failure ?? props.offline) && (
        <p role="alert" {...stylex.props(styles.alert)}>
          {failure ?? props.offline}
        </p>
      )}
    </div>
  );
}

/** One message of a thread: its author, kind, Pending and Outdated marks, and for its author's Pending ones, edits. */
function MessageItem(props: {
  message: Message;
  thread: Thread;
  notes: ReadonlyMap<string, StatusNote>;
  act: Act;
  onReference: (target: CapturedRange) => void;
}) {
  const { message } = props;
  const [editing, setEditing] = useState<DraftText>();
  const [wording, setWording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const mounted = useMounted();
  const human = message.author === "human" ? message : undefined;
  const outdated = replyOutdated(message, props.thread, props.notes) ? message.wording : undefined;
  const run = async (request: Parameters<Act>[0], then?: () => void) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await props.act(request);
      if (mounted.current) then?.();
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(failureText(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <li data-message={message.id} {...stylex.props(styles.message)}>
      <p {...stylex.props(styles.meta)}>
        <span {...stylex.props(styles.author)}>{human ? "You" : "Agent"}</span>
        {human && <span> · {kindLabel[human.kind]}</span>}
        {human?.pending && <span {...stylex.props(styles.pending)}>Pending</span>}
        {outdated && (
          <button
            type="button"
            aria-expanded={wording}
            onClick={() => setWording(!wording)}
            {...stylex.props(styles.outdated)}
          >
            Outdated
          </button>
        )}
      </p>
      {outdated && wording && (
        <blockquote aria-label="The note as this reply read it" {...stylex.props(styles.wording)}>
          {liveNote(props.thread, props.notes) ? "" : "The note was removed. "}It read:
          <RichText
            markdown={outdated.markdown}
            references={outdated.references}
            onReference={props.onReference}
          />
        </blockquote>
      )}
      {editing ? (
        <MessageField
          label="Edit message"
          text={editing}
          onText={setEditing}
          onSubmit={() => {
            const markdown = editing.markdown !== message.markdown ? editing.markdown : undefined;
            const kind = editing.kind !== human?.kind ? editing.kind : undefined;
            if (markdown === undefined && kind === undefined) return setEditing(undefined);
            void run(
              {
                command: "edit",
                message: message.id,
                ...(markdown !== undefined && { markdown }),
                ...(kind !== undefined && { kind }),
              },
              () => setEditing(undefined),
            );
          }}
          onEscape={() => setEditing(undefined)}
          submit="Save"
          busy={busy}
        >
          <PillButton onClick={() => setEditing(undefined)}>Cancel</PillButton>
        </MessageField>
      ) : (
        <RichText
          markdown={message.markdown}
          references={message.references}
          onReference={props.onReference}
        />
      )}
      {human?.pending && !editing && (
        <div {...stylex.props(styles.row)}>
          <PillButton onClick={() => setEditing({ markdown: human.markdown, kind: human.kind })}>
            Edit
          </PillButton>
          <PillButton
            disabled={busy}
            onClick={() => void run({ command: "retract", message: message.id })}
          >
            Delete
          </PillButton>
        </div>
      )}
      {failure && (
        <p role="alert" {...stylex.props(styles.alert)}>
          {failure}
        </p>
      )}
    </li>
  );
}

/**
 * A thread where it is read: collapsed to a chip naming its messages and whether any is Pending,
 * or open with every message, a composer while a reply is written, and Reply and Resolve.
 */
export function ThreadCard(props: {
  thread: Thread;
  snapshotId: string;
  notes: ReadonlyMap<string, StatusNote>;
  expanded: boolean;
  onToggle: () => void;
  onReply: () => void;
  onResolve: () => void;
  act: Act;
  onReference: (target: CapturedRange) => void;
  /** The open composer of a reply in this thread. */
  composer?: ReactNode;
  /** Shows the thread's place, as the Comments list does. */
  located?: boolean;
  /** Goes to the thread where the panel shows it. */
  onShow?: (() => void) | undefined;
}) {
  const { thread } = props;
  const pending = pendingCount(thread);
  const removed = thread.note?.removed === true;
  return (
    <div data-thread={thread.id} data-annotation {...stylex.props(styles.slot)}>
      <div {...stylex.props(styles.box)}>
        <button
          type="button"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
          {...stylex.props(styles.chip)}
        >
          <span {...stylex.props(styles.chevron, props.expanded && styles.chevronOpen)} />
          {props.located ? threadLocation(thread.anchor, props.snapshotId) : "Thread"} ·{" "}
          {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}
          {pending > 0 && <span {...stylex.props(styles.pending)}>Pending</span>}
          {thread.resolved && <span {...stylex.props(styles.resolved)}>Resolved</span>}
        </button>
        {props.expanded && (
          <div {...stylex.props(styles.body)}>
            {removed && (
              <p role="note" {...stylex.props(styles.flag)}>
                Its note was removed; the conversation stays on the code it was about.
              </p>
            )}
            {thread.anchor.snapshotId !== props.snapshotId && (
              <p role="note" {...stylex.props(styles.flag)}>
                On earlier code a refresh changed; it stays there.
              </p>
            )}
            <ol {...stylex.props(styles.messages)}>
              {thread.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  thread={thread}
                  notes={props.notes}
                  act={props.act}
                  onReference={props.onReference}
                />
              ))}
            </ol>
            {props.composer}
            {!props.composer && (
              <div {...stylex.props(styles.row)}>
                {!thread.resolved && <PillButton onClick={props.onReply}>Reply</PillButton>}
                <PillButton onClick={props.onResolve}>
                  {thread.resolved ? "Reopen" : "Resolve"}
                </PillButton>
                {props.onShow && <PillButton onClick={props.onShow}>Show in the diff</PillButton>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * C: every conversation, open ones first and resolved ones after, where resolved threads are
 * reopened and threads whose code is no longer shown are read; and the drafts not being written.
 */
export function CommentsList(props: {
  threads: readonly Thread[];
  drafts: readonly Draft[];
  snapshotId: string;
  renderThread: (thread: Thread) => ReactNode;
  /** The composer of a draft written here rather than in the panel, or undefined. */
  renderDraft: (draft: Draft) => ReactNode;
  onResume: (draft: Draft) => void;
  onDiscard: (draft: Draft) => void;
  onClose: () => void;
}) {
  const threads = commentsOrder(props.threads);
  return (
    <Dialog label="Comments" onClose={props.onClose}>
      <div {...stylex.props(styles.list)}>
        <div {...stylex.props(styles.listHead)}>
          <h2 {...stylex.props(styles.title)}>Comments</h2>
          <button type="button" autoFocus onClick={props.onClose} {...stylex.props(styles.close)}>
            Close
          </button>
        </div>
        {threads.length === 0 && props.drafts.length === 0 && (
          <p {...stylex.props(styles.meta)}>No comments yet. Press c on code to start one.</p>
        )}
        {threads.map((thread) => (
          <div key={thread.id}>{props.renderThread(thread)}</div>
        ))}
        {props.drafts.length > 0 && (
          <>
            <h3 {...stylex.props(styles.subtitle)}>Drafts</h3>
            {props.drafts.map(
              (draft) =>
                props.renderDraft(draft) ?? (
                  <div key={draft.id} data-draft={draft.id} {...stylex.props(styles.row)}>
                    <span {...stylex.props(styles.meta)}>
                      {draft.thread !== undefined || draft.note !== undefined ? "Reply" : "Comment"}{" "}
                      on {threadLocation(draft.anchor, props.snapshotId)}
                    </span>
                    <PillButton onClick={() => props.onResume(draft)}>Resume</PillButton>
                    <PillButton onClick={() => props.onDiscard(draft)}>Discard</PillButton>
                  </div>
                ),
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// Annotations pad rather than keep a margin, so the element's top is where its row begins.
const styles = stylex.create({
  slot: { padding: "4px 10px 6px" },
  box: {
    padding: "6px 10px 8px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `inset 2px 0 0 ${theme.faint}`,
    fontFamily: theme.sans,
    whiteSpace: "normal",
  },
  composer: {
    margin: "4px 10px 6px",
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
    fontFamily: theme.sans,
    whiteSpace: "normal",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: { default: theme.muted, ":hover": theme.ink },
    fontFamily: theme["--mono"],
    fontSize: "11.5px",
  },
  chevron: {
    width: "5px",
    height: "5px",
    borderRightWidth: "1.5px",
    borderRightStyle: "solid",
    borderRightColor: theme.faint,
    borderBottomWidth: "1.5px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.faint,
    transform: "rotate(-45deg)",
  },
  chevronOpen: { transform: "rotate(45deg)" },
  body: { display: "grid", gap: "6px", marginTop: "6px" },
  messages: { display: "grid", gap: "8px", margin: 0, padding: 0, listStyle: "none" },
  message: {
    paddingTop: "6px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: theme.line,
  },
  meta: { display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: theme.muted },
  author: { color: theme.ink, fontWeight: 500 },
  pending: { marginLeft: "6px", fontSize: "12px", color: theme.changed },
  resolved: { marginLeft: "6px", fontSize: "12px", color: theme.add },
  outdated: {
    marginLeft: "6px",
    fontSize: "12px",
    color: { default: theme.hunkHeader, ":hover": theme.ink },
    textDecoration: "underline",
  },
  wording: {
    margin: "4px 0",
    paddingLeft: "8px",
    borderLeftWidth: "2px",
    borderLeftStyle: "solid",
    borderLeftColor: theme.hunkHeader,
    fontSize: "12px",
    color: theme.muted,
  },
  flag: { fontSize: "12px", color: theme.hunkHeader },
  alert: { fontSize: "12px", color: theme.del },
  field: { display: "grid", gap: "6px", marginTop: "4px" },
  textarea: {
    width: "100%",
    minHeight: "60px",
    padding: "6px 8px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: theme.line, ":focus": theme["--accent"] },
    outline: "none",
    backgroundColor: theme.panelBg,
    color: theme.ink,
    font: "inherit",
    fontSize: "13px",
    resize: "vertical",
  },
  select: {
    height: "28px",
    padding: "0 6px",
    borderRadius: "7px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: theme.line,
    backgroundColor: theme.panelBg,
    color: theme.ink,
    font: "inherit",
    fontSize: "12.5px",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" },
  list: { display: "grid", gap: "8px", padding: "20px 22px" },
  listHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: "14px", fontWeight: 500 },
  subtitle: { marginTop: "6px", fontSize: "13px", fontWeight: 500, color: theme.muted },
  close: {
    height: "28px",
    padding: "0 10px",
    borderRadius: "7px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
});
