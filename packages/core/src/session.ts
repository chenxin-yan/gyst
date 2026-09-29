import { Schema } from "effect";
import { metadataFields, NoteTextSchema } from "./metadata.ts";

export const HunkSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  header: Schema.String,
  patch: Schema.String,
  contentHash: Schema.String,
});
export type Hunk = typeof HunkSchema.Type;

export const GroupSchema = Schema.Struct({
  id: Schema.String,
  ...metadataFields,
  hunkIds: Schema.Array(Schema.String),
  accepted: Schema.Boolean,
});
export type Group = typeof GroupSchema.Type;

/**
 * What a session reviews, recorded as the caller wrote it. With the repository root it is the
 * session's identity: a moved ref or an equal resolved diff never makes it another session.
 */
export const ScopeSchema = Schema.Union([
  /** HEAD (or the empty tree) against the working tree, including untracked files. */
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  /** A Git range such as `main...feature`; its endpoints resolve again at each capture. */
  Schema.Struct({ kind: Schema.Literal("range"), range: Schema.String }),
]);
export type Scope = typeof ScopeSchema.Type;

const sessionSummaryFields = {
  id: Schema.String,
  repoRoot: Schema.String,
  scope: ScopeSchema,
  /** The published snapshot manifest's `snapshotIdOf`: every captured input, not only the diff. Refresh replaces it. */
  snapshotId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
export const SessionSummarySchema = Schema.Struct(sessionSummaryFields);
export type SessionSummary = typeof SessionSummarySchema.Type;
const cursorSchema = Schema.Struct({
  itemId: Schema.NullOr(Schema.String),
  pane: Schema.Literals(["queue", "diff"]),
  hunkId: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (cursor) =>
      (cursor.itemId === null
        ? cursor.pane === "queue" && cursor.hunkId === undefined
        : cursor.hunkId !== undefined) ||
      "active items require a member hunk; empty focus is in the queue",
  ),
);

const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
// Wire notes carry text; receipts carry indices into `receiptNoteTexts`.
const statusPayloadFields = <Text extends Schema.Top>(text: Text) => ({
  session: SessionSummarySchema,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  groups: Schema.Array(
    Schema.Struct({
      ...GroupSchema.fields,
      notes: Schema.Array(Schema.Struct({ hunkId: Schema.String, text })),
      count: Schema.Number,
    }),
  ),
  inbox: Schema.Array(HunkSummarySchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  ready: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export const StatusPayloadSchema = Schema.Struct(statusPayloadFields(NoteTextSchema));
export type StatusPayload = typeof StatusPayloadSchema.Type;
const ReceiptStatusSchema = Schema.Struct(statusPayloadFields(Schema.Natural));
export type ReceiptStatus = typeof ReceiptStatusSchema.Type;

// `digest` pins the receipt to the exact batch it answered, so a reused key cannot replay another.
const ApplyReceiptSchema = Schema.Struct({
  key: Schema.String,
  digest: Schema.String,
  status: ReceiptStatusSchema,
});
export type ApplyReceipt = typeof ApplyReceiptSchema.Type;
export const SessionSchema = Schema.Struct({
  ...sessionSummaryFields,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  hunks: Schema.Array(HunkSchema),
  groups: Schema.Array(GroupSchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  acceptHistory: Schema.Array(Schema.String),
  // Progressive publication stores each distinct historical note text once.
  receiptNoteTexts: Schema.Array(NoteTextSchema),
  applyReceipts: Schema.Array(ApplyReceiptSchema),
}).check(
  Schema.makeFilter(
    (session) =>
      session.applyReceipts.every(({ status }) =>
        status.groups.every(({ notes }) =>
          notes.every(({ text }) => text < session.receiptNoteTexts.length),
        ),
      ) || "receipt note reference is outside receiptNoteTexts",
  ),
);
export type Session = typeof SessionSchema.Type;
