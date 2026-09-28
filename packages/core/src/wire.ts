import { Schema } from "effect";
import { ErrorPayloadSchema } from "./errors.ts";
import { HunkSchema, ScopeSchema, SessionSummarySchema } from "./session.ts";

export const DiffPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  hunks: Schema.Array(HunkSchema),
});
export type DiffPayload = typeof DiffPayloadSchema.Type;

export const SourceCheckPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  state: Schema.Literals(["unchanged", "changed", "unavailable"]),
  checkedAt: Schema.String,
  message: Schema.optional(Schema.String),
});
export type SourceCheckPayload = typeof SourceCheckPayloadSchema.Type;

export const OpenPayloadSchema = Schema.Struct({
  session: SessionSummarySchema,
  /** False when the saved session was returned as it was: reuse never refreshes it. */
  created: Schema.Boolean,
  /** The token-free command a human runs to view this session; open itself launches nothing. */
  launch: Schema.Struct({ argv: Schema.Array(Schema.String) }),
});
export type OpenPayload = typeof OpenPayloadSchema.Type;

export const ListPayloadSchema = Schema.Struct({ sessions: Schema.Array(SessionSummarySchema) });
export type ListPayload = typeof ListPayloadSchema.Type;

/** Also the recorded answer to every retry of the same delete request. */
export const DeletePayloadSchema = Schema.Struct({
  deleted: Schema.Literal(true),
  sessionId: Schema.String,
});
export type DeletePayload = typeof DeletePayloadSchema.Type;

/** An exact saved-session id; no operation falls back to the caller's directory. */
const exact = { session: Schema.String };

/**
 * The operations a browser may request: exact saved-session ids and read filters only. Checkout
 * paths, Git input, executables and caller roles are not expressible, so a bridge decodes browser
 * input with this schema and forwards it unchanged.
 */
export const BrowserRequestSchema = Schema.Union([
  Schema.Struct({ command: Schema.Literal("list") }),
  Schema.Struct({ command: Schema.Literal("open"), ...exact }),
  Schema.Struct({ command: Schema.Literal("status"), ...exact }),
  Schema.Struct({ command: Schema.Literal("check"), ...exact }),
  Schema.Struct({
    command: Schema.Literal("diff"),
    ...exact,
    hunk: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
    file: Schema.optional(Schema.String),
  }),
  /**
   * `requestId` is chosen by the caller before sending and reused for every retry of this delete,
   * so a lost reply cannot turn into a second operation.
   */
  Schema.Struct({ command: Schema.Literal("delete"), ...exact, requestId: Schema.String }),
]);
export type BrowserRequest = typeof BrowserRequestSchema.Type;

/** One validated operation per session command; CLI flags and argv never cross the socket. */
export const RequestSchema = Schema.Union([
  /**
   * Trusted local entry points only. `cwd` is the caller's directory, bound by the entry point, and
   * selects the repository; the recorded scope then creates or reuses that repository's session.
   */
  Schema.Struct({ command: Schema.Literal("open"), cwd: Schema.String, scope: ScopeSchema }),
  ...BrowserRequestSchema.members,
  /** `batch` is the JSON apply envelope text; the use case validates it against `ApplyEnvelopeSchema`. */
  Schema.Struct({ command: Schema.Literal("apply"), ...exact, batch: Schema.String }),
  Schema.Struct({ command: Schema.Literal("refresh"), ...exact }),
]);
export type Request = typeof RequestSchema.Type;

export const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
]);
export type Reply = typeof ReplySchema.Type;
