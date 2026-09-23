import { Schema } from "effect";
import { ErrorPayloadSchema } from "./errors.ts";
import { HumanActionSchema } from "./human-action.ts";
import { FormatVersionSchema, HunkSchema } from "./session.ts";

export const DiffPayloadSchema = Schema.Struct({
  formatVersion: FormatVersionSchema,
  sessionId: Schema.String,
  revision: Schema.Number,
  hunks: Schema.Array(HunkSchema),
});
export type DiffPayload = typeof DiffPayloadSchema.Type;

export const ClosePayloadSchema = Schema.Struct({
  formatVersion: FormatVersionSchema,
  closed: Schema.Literal(true),
  sessionId: Schema.String,
});
export type ClosePayload = typeof ClosePayloadSchema.Type;

export const RequestSchema = Schema.Struct({
  command: Schema.Literals(["create", "status", "diff", "apply", "refresh", "close", "tui.action"]),
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
