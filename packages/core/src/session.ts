import { Schema } from "effect";
import { metadataFields, OverviewSchema } from "./metadata.ts";

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
  pane: Schema.Literals(["queue", "diff", "overview"]),
  hunkId: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (cursor) =>
      (cursor.pane === "queue"
        ? cursor.hunkId === undefined
        : cursor.itemId !== null && cursor.hunkId !== undefined) ||
      "queue focus has no hunk; zoom requires an item and hunk",
  ),
);

const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
// The wire status carries overview text; a receipt status carries an index into `receiptOverviews`.
const statusPayloadFields = <Overview extends Schema.Top>(overview: Overview) => ({
  session: Schema.Struct(sessionSummaryFields),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  groups: Schema.Array(Schema.Struct({ ...GroupSchema.fields, overview, count: Schema.Number })),
  inbox: Schema.Array(HunkSummarySchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  ready: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export const StatusPayloadSchema = Schema.Struct(statusPayloadFields(OverviewSchema));
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
  // Every distinct overview a receipt ever recorded, once; receipts reference it by index so
  // progressive publication does not repeat all earlier Markdown in each new receipt.
  receiptOverviews: Schema.Array(OverviewSchema),
  applyReceipts: Schema.Array(ApplyReceiptSchema),
}).check(
  Schema.makeFilter(
    (session) =>
      session.applyReceipts.every(({ status }) =>
        status.groups.every(({ overview }) => overview < session.receiptOverviews.length),
      ) || "receipt overview reference is outside receiptOverviews",
  ),
);
export type Session = typeof SessionSchema.Type;
