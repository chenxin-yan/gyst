import { Schema, SchemaGetter } from "effect";
import { GitHubUnavailableReasonSchema } from "./github.ts";

export const ErrorCodeSchema = Schema.Literals([
  "stale_revision",
  "validation_failed",
  "no_session",
  "daemon_unreachable",
  "bad_args",
  "source_unavailable",
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
export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()(
  "daemon_unreachable",
  errorFields,
) {}
export class BadArgs extends Schema.TaggedError<BadArgs>()("bad_args", errorFields) {}

/**
 * Why a source could not be captured: the host's `gh` is missing, unauthenticated or denied, GitHub
 * failed, the checkout has no matching remote, required Git objects could not be fetched, the PR
 * head moved while it was being read (retry), the reviewed files exceed the configured snapshot
 * quota, or gyst's data directory ran out of space.
 */
export const SourceUnavailableReasonSchema = Schema.Literals([
  ...GitHubUnavailableReasonSchema.literals,
  "checkout_mismatch",
  "objects_missing",
  "head_moved",
  "quota_exceeded",
  "storage_full",
]);
export type SourceUnavailableReason = typeof SourceUnavailableReasonSchema.Type;
/** An environment problem on the gyst host, not a caller mistake; `message` says what to do. */
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "source_unavailable",
  {
    message: Schema.String,
    /** `diagnostic` is the failing tool's bounded output, when there is one. */
    detail: Schema.Struct({
      reason: SourceUnavailableReasonSchema,
      diagnostic: Schema.optional(Schema.String),
    }),
  },
) {}
/** A gyst defect, not a caller mistake: anything that is neither a domain error nor invalid input. */
export class InternalError extends Schema.TaggedError<InternalError>()(
  "internal_error",
  errorFields,
) {}

export const DaemonError = Schema.Union([
  StaleRevision,
  ValidationFailed,
  NoSession,
  DaemonUnreachable,
  BadArgs,
  SourceUnavailable,
  InternalError,
]);
export type DaemonError = typeof DaemonError.Type;

/** Agents parse `code` on the wire; in-process the same error is a tagged class instance. */
export const ErrorPayloadSchema = Schema.Struct({ code: ErrorCodeSchema, ...errorFields }).pipe(
  Schema.decodeTo(DaemonError, {
    // `DaemonError` then validates the error's own fields, such as `source_unavailable`'s detail.
    decode: SchemaGetter.transform(
      ({ code, ...rest }) => ({ _tag: code, ...rest }) as typeof DaemonError.Encoded,
    ),
    encode: SchemaGetter.transform(({ _tag, ...rest }) => ({ code: _tag, ...rest })),
  }),
);
export type ErrorPayload = typeof ErrorPayloadSchema.Encoded;
