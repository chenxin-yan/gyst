import { Schema } from "effect";
import { CapturedRangeSchema, MarkdownSchema } from "./guidance.ts";

/** What a human message asks for: an explanation (the default) or a code change. */
export const MessageKindSchema = Schema.Literals(["question", "change"]);
export type MessageKind = typeof MessageKindSchema.Type;

/**
 * A note as a human reply was composed against it, kept however the note changes or moves later:
 * its text and the code it was anchored to then.
 */
export const WordingSchema = Schema.Struct({
  markdown: MarkdownSchema,
  references: Schema.Array(CapturedRangeSchema),
  anchor: CapturedRangeSchema,
});
export type Wording = typeof WordingSchema.Type;

/**
 * A human message. It is `pending` until the agent retrieves its body: only then is it read, and
 * frozen. `references` are its `gyst:` links, pinned to the snapshot current when it was written;
 * `wording` is the note text a note reply was composed against.
 */
export const HumanMessageSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.Literal("human"),
  kind: MessageKindSchema,
  pending: Schema.Boolean,
  markdown: MarkdownSchema,
  references: Schema.Array(CapturedRangeSchema),
  wording: Schema.optional(WordingSchema),
  createdAt: Schema.String,
});
export type HumanMessage = typeof HumanMessageSchema.Type;

/** An agent reply: free-form and immutable once posted, with no kind. */
export const AgentMessageSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.Literal("agent"),
  markdown: MarkdownSchema,
  references: Schema.Array(CapturedRangeSchema),
  createdAt: Schema.String,
});
export type AgentMessage = typeof AgentMessageSchema.Type;

export const MessageSchema = Schema.Union([HumanMessageSchema, AgentMessageSchema]);
export type Message = typeof MessageSchema.Type;

/**
 * The note a thread or draft belongs to. `removed` is set once that note is removed (its group
 * dissolved included) and never cleared: a later note, even with the same id, starts afresh.
 */
export const NoteLinkSchema = Schema.Struct({ id: Schema.String, removed: Schema.Boolean });
export type NoteLink = typeof NoteLinkSchema.Type;

/**
 * A flat conversation on one contiguous range of one side of one captured file: a code thread,
 * or a note's only thread. `anchor` is where it sits; refresh moves it only where every line maps
 * unchanged, and a note's thread follows its note. Only the human resolves or reopens it.
 */
export const ThreadSchema = Schema.Struct({
  id: Schema.String,
  anchor: CapturedRangeSchema,
  note: Schema.optional(NoteLinkSchema),
  resolved: Schema.Boolean,
  messages: Schema.Array(MessageSchema).check(Schema.isMinLength(1)),
});
export type Thread = typeof ThreadSchema.Type;

/**
 * The context of a message being composed, pinned so refresh cannot reclaim it: a new comment on
 * `anchor`, a reply in `thread`, or a reply to `note`, with the `wording` it was composed against.
 * `snapshotId` was current when it was begun: its message's `gyst:` links pin there. Its text
 * stays in the browser; the pin lasts until it is sent or discarded.
 */
export const DraftSchema = Schema.Struct({
  id: Schema.String,
  snapshotId: Schema.String,
  anchor: CapturedRangeSchema,
  thread: Schema.optional(Schema.String),
  note: Schema.optional(NoteLinkSchema),
  wording: Schema.optional(WordingSchema),
});
export type Draft = typeof DraftSchema.Type;

/** How many threads are open or resolved, and how many human messages are still Pending. */
export const ThreadCountsSchema = Schema.Struct({
  open: Schema.Natural,
  resolved: Schema.Natural,
  pending: Schema.Natural,
});
export type ThreadCounts = typeof ThreadCountsSchema.Type;

/** A browser's read of every conversation and draft pin, Pending bodies included; it freezes nothing. */
export const ConversationsPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: Schema.String,
  revision: Schema.Number,
  /** The `conversations` identity a subscription announces for these threads. */
  version: Schema.String,
  /** Each thread with its `version`, which a resolution or reopening names as what was read. */
  threads: Schema.Array(Schema.Struct({ ...ThreadSchema.fields, version: Schema.String })),
  drafts: Schema.Array(DraftSchema),
});
export type ConversationsPayload = typeof ConversationsPayloadSchema.Type;

/** The recorded answer to a human conversation action: the revision it produced and what it made. */
export const ConversationResultSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  draft: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type ConversationResult = typeof ConversationResultSchema.Type;

/** A thread's code as captured: its anchored lines, or why that side holds no captured text. */
export const ThreadCodeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), lines: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
]);
export type ThreadCode = typeof ThreadCodeSchema.Type;

/**
 * One retrieval of threads for the agent. Each thread carries its whole history and the captured
 * code of its anchor; `earlierCode` adds the code of each note anchor a reply was composed against
 * where the note has since moved. `unread` names the human messages this retrieval read, and so
 * froze. `progress` (Viewed of the current hunks) and `openThreads` tell an empty bundle from a
 * review still being read.
 */
export const ThreadsPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: Schema.String,
  revision: Schema.Number,
  progress: Schema.Struct({ viewed: Schema.Natural, total: Schema.Natural }),
  openThreads: Schema.Natural,
  threads: Schema.Array(
    Schema.Struct({
      ...ThreadSchema.fields,
      code: ThreadCodeSchema,
      earlierCode: Schema.Array(
        Schema.Struct({ anchor: CapturedRangeSchema, code: ThreadCodeSchema }),
      ),
      unread: Schema.Array(Schema.String),
    }),
  ),
});
export type ThreadsPayload = typeof ThreadsPayloadSchema.Type;
