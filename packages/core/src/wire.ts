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

// `cwd` is the caller's directory, bound by the entry point; `session` selects an exact id, else
// the session of the repository containing `cwd`.
const selection = { cwd: Schema.String, session: Schema.optional(Schema.String) };
/** A supplied unified diff with repository-root-relative paths, replacing Git acquisition. */
const patch = Schema.optional(Schema.String);

/** One validated operation per session command; CLI flags and argv never cross the socket. */
export const RequestSchema = Schema.Union([
  Schema.Struct({
    command: Schema.Literal("create"),
    cwd: Schema.String,
    /** Git revisions; when `pathspecs` is present Git sees `<revisions> -- <pathspecs>`. */
    revisions: Schema.Array(Schema.String),
    pathspecs: Schema.optional(Schema.Array(Schema.String)),
    patch,
  }),
  Schema.Struct({ command: Schema.Literal("status"), ...selection }),
  Schema.Struct({ command: Schema.Literal("check"), ...selection }),
  Schema.Struct({
    command: Schema.Literal("diff"),
    ...selection,
    hunk: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
    file: Schema.optional(Schema.String),
  }),
  /** `batch` is the JSON apply envelope text; the use case validates it against `ApplyEnvelopeSchema`. */
  Schema.Struct({ command: Schema.Literal("apply"), ...selection, batch: Schema.String }),
  Schema.Struct({ command: Schema.Literal("refresh"), ...selection, patch }),
  Schema.Struct({ command: Schema.Literal("close"), ...selection }),
  Schema.Struct({
    command: Schema.Literal("tui.action"),
    cwd: Schema.String,
    action: HumanActionSchema,
  }),
]);
export type Request = typeof RequestSchema.Type;

export const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
]);
export type Reply = typeof ReplySchema.Type;
