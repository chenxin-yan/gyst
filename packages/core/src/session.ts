import { Schema } from "effect";
import { metadataFields, OverviewSchema, TitleSchema } from "./metadata.ts";

export const SESSION_FORMAT_VERSION = 1;
export const FormatVersionSchema = Schema.Literal(SESSION_FORMAT_VERSION);

export const HunkSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  header: Schema.String,
  patch: Schema.String,
  contentHash: Schema.String,
  title: Schema.optional(TitleSchema),
  overview: Schema.optional(OverviewSchema),
  accepted: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (hunk) =>
      (hunk.title === undefined) === (hunk.overview === undefined) ||
      "hunk title and overview must be present together",
  ),
);
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
    // `cwd` makes relative pathspecs in `args` replayable.
    cwd: Schema.String,
    // A bare snapshot re-resolves HEAD and re-lists untracked files on refresh.
    includeUntracked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
]);
export type Source = typeof SourceSchema.Type;

const sessionSummaryFields = {
  formatVersion: FormatVersionSchema,
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
const cursorSchema = Schema.Struct({
  itemId: Schema.NullOr(Schema.String),
  expanded: Schema.Boolean,
  // Set while the human reads inside the item: one of its hunks, absent while the sidebar has focus.
  hunkId: Schema.optional(Schema.String),
});

const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
const GroupSummarySchema = Schema.Struct({
  ...GroupSchema.fields,
  count: Schema.Number,
  accepted: Schema.Boolean,
});
const SpotlightSummarySchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  ...metadataFields,
  accepted: Schema.Boolean,
});
export const StatusPayloadSchema = Schema.Struct({
  session: Schema.Struct(sessionSummaryFields),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  groups: Schema.Array(GroupSummarySchema),
  spotlight: Schema.Array(SpotlightSummarySchema),
  inbox: Schema.Array(HunkSummarySchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  ready: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;

// `digest` pins the receipt to the exact batch it answered, so a reused key cannot replay another.
const ApplyReceiptSchema = Schema.Struct({
  key: Schema.String,
  digest: Schema.String,
  status: StatusPayloadSchema,
});
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
  applyReceipts: Schema.Array(ApplyReceiptSchema),
});
export type Session = typeof SessionSchema.Type;
