import { Schema } from "effect";
import { ErrorPayloadSchema } from "./errors.ts";
import { HumanActionSchema } from "./human-action.ts";
import { HunkSchema } from "./session.ts";

export const DiffPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  hunks: Schema.Array(HunkSchema),
});
export type DiffPayload = typeof DiffPayloadSchema.Type;

export const SourceCheckPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  state: Schema.Literals(["unchanged", "changed", "stdin", "unavailable"]),
  checkedAt: Schema.String,
  message: Schema.optional(Schema.String),
});
export type SourceCheckPayload = typeof SourceCheckPayloadSchema.Type;

export const ClosePayloadSchema = Schema.Struct({
  closed: Schema.Literal(true),
  sessionId: Schema.String,
});
export type ClosePayload = typeof ClosePayloadSchema.Type;

export const RequestSchema = Schema.Struct({
  command: Schema.Literals([
    "create",
    "status",
    "check",
    "diff",
    "apply",
    "refresh",
    "close",
    "tui.action",
  ]),
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.optional(Schema.String),
  action: Schema.optional(HumanActionSchema),
});
export type Request = typeof RequestSchema.Type;

export const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
]);
export type Reply = typeof ReplySchema.Type;
