import { Schema, Struct } from "effect";

export const HunkSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  header: Schema.String,
  patch: Schema.String,
  tldr: Schema.optional(Schema.String),
});
export type Hunk = typeof HunkSchema.Type;

export const GroupSchema = Schema.Struct({
  id: Schema.String,
  tldr: Schema.String,
  exemplarHunkId: Schema.String,
  hunkIds: Schema.Array(Schema.String),
});
export type Group = typeof GroupSchema.Type;

export const SourceSchema = Schema.Union([
  // `cwd` makes relative pathspecs in `args` replayable.
  Schema.Struct({
    kind: Schema.Literal("git"),
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
]);
export type Source = typeof SourceSchema.Type;

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  hunks: Schema.Array(HunkSchema),
  groups: Schema.Array(GroupSchema),
});
export type Session = typeof SessionSchema.Type;

const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
const GroupSummarySchema = Schema.Struct({
  ...GroupSchema.fields,
  count: Schema.Number,
  accepted: Schema.Boolean,
});
const SpotlightSummarySchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  tldr: Schema.String,
  accepted: Schema.Boolean,
});
export const StatusPayloadSchema = Schema.Struct({
  session: SessionSchema.mapFields(
    Struct.pick(["id", "repoRoot", "source", "createdAt", "updatedAt"]),
  ),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  groups: Schema.Array(GroupSummarySchema),
  spotlight: Schema.Array(SpotlightSummarySchema),
  inbox: Schema.Array(HunkSummarySchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;
