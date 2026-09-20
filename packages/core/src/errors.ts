import { Schema, SchemaGetter } from "effect";

export const ErrorCodeSchema = Schema.Literals([
  "stale_revision",
  "validation_failed",
  "no_session",
  "session_exists",
  "daemon_unreachable",
  "bad_args",
  "internal_error",
]);

const errorFields = { message: Schema.String, detail: Schema.optional(Schema.Unknown) };

export class StaleRevision extends Schema.TaggedError<StaleRevision>()(
  "stale_revision",
  errorFields,
) {}
export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()(
  "validation_failed",
  errorFields,
) {}
export class NoSession extends Schema.TaggedError<NoSession>()("no_session", errorFields) {}
export class SessionExists extends Schema.TaggedError<SessionExists>()(
  "session_exists",
  errorFields,
) {}
export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()(
  "daemon_unreachable",
  errorFields,
) {}
export class BadArgs extends Schema.TaggedError<BadArgs>()("bad_args", errorFields) {}
/** A gyst defect, not a caller mistake: anything that is neither a domain error nor invalid input. */
export class InternalError extends Schema.TaggedError<InternalError>()(
  "internal_error",
  errorFields,
) {}

export const DaemonError = Schema.Union([
  StaleRevision,
  ValidationFailed,
  NoSession,
  SessionExists,
  DaemonUnreachable,
  BadArgs,
  InternalError,
]);
export type DaemonError = typeof DaemonError.Type;

/** Agents parse `code` on the wire; in-process the same error is a tagged class instance. */
export const ErrorPayloadSchema = Schema.Struct({ code: ErrorCodeSchema, ...errorFields }).pipe(
  Schema.decodeTo(DaemonError, {
    decode: SchemaGetter.transform(({ code, ...rest }) => ({ _tag: code, ...rest })),
    encode: SchemaGetter.transform(({ _tag, ...rest }) => ({ code: _tag, ...rest })),
  }),
);
