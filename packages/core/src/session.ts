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

export const SourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    args: Schema.Array(Schema.String),
    patchHash: Schema.String,
    // `cwd` makes relative pathspecs in `args` replayable.
    cwd: Schema.String,
    // A bare snapshot re-resolves HEAD and re-lists untracked files on refresh.
    includeUntracked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
]);
export type Source = typeof SourceSchema.Type;

const sessionSummaryFields = {
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
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
  session: Schema.Struct(sessionSummaryFields),
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
