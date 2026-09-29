import { Schema } from "effect";
import {
  ContentSideSchema,
  LogicalPathSchema,
  ManifestFileSchema,
  SnapshotIdSchema,
} from "./content.ts";
import { ErrorPayloadSchema } from "./errors.ts";
import { HunkSchema, ScopeSchema, SessionSummarySchema } from "./session.ts";

// `@gyst/core/wire` is the browser-safe entry: every contract a bridge or browser needs, without the
// Node-only snapshot parsing and hashing the root `@gyst/core` export pulls in.
export {
  BadArgs,
  DaemonError,
  DaemonUnreachable,
  ErrorCodeSchema,
  type ErrorPayload,
  ErrorPayloadSchema,
  InternalError,
  NoSession,
  StaleRevision,
  ValidationFailed,
} from "./errors.ts";
export { type ContentSide, type ManifestFile } from "./content.ts";
export {
  type Hunk,
  HunkSchema,
  type Scope,
  ScopeSchema,
  type SessionSummary,
  SessionSummarySchema,
  type StatusPayload,
  StatusPayloadSchema,
} from "./session.ts";

export const DiffPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  /** The snapshot these hunks came from; `files` and `code` name it to read its captured text. */
  snapshotId: Schema.String,
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

/**
 * Most captured bytes in one `code` page, and most JSON-encoded file entries in one `files` page
 * (a page always holds at least one entry). A delivery bound only: every byte stays readable
 * through continuation, and nothing is truncated or refused for its size.
 */
export const pageBytes = 64 * 1024;

/** 1-based. A line is the bytes up to and including its LF, or up to the end of content. */
const LineNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * A byte offset into one side's captured content and the line it falls in: 1 + the LFs before
 * `offset`. At the end of content that is one past the last line.
 */
export const CodePositionSchema = Schema.Struct({ line: LineNumberSchema, offset: Schema.Natural });
export type CodePosition = typeof CodePositionSchema.Type;

/** One page of the current snapshot's captured files, in path order; `next` is the next `after`. */
export const FilesPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  /** Every file in the snapshot, supporting unchanged files and unavailable sides included. */
  total: Schema.Natural,
  files: Schema.Array(ManifestFileSchema),
  next: Schema.NullOr(LogicalPathSchema),
});
export type FilesPayload = typeof FilesPayloadSchema.Type;

/**
 * One page of one side of a captured file. `text` is the exact captured bytes from `start` (CRLF,
 * lone CR, BOM and a missing final LF kept), so concatenating every page's text in order yields
 * the file byte for byte. Lines are LF-delimited; a final LF ends the last line rather than
 * starting another, so an empty file has zero lines. A page ends after its last whole line within
 * `pageBytes`; a line longer than that is split at a UTF-8 boundary and continues on the next page.
 * `next` is where the following page starts (send its `offset`), or null when the file or the
 * requested `endLine` is done. Sides without captured text say so instead of returning text.
 */
export const CodePayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  file: LogicalPathSchema,
  side: Schema.Literals(["old", "new"]),
  content: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("text"),
      size: Schema.Natural,
      start: CodePositionSchema,
      text: Schema.String,
      next: Schema.NullOr(CodePositionSchema),
    }),
    ContentSideSchema.members[1],
    ContentSideSchema.members[2],
  ]),
});
export type CodePayload = typeof CodePayloadSchema.Type;

/**
 * Real counts from one capture, each monotonic within its phase: `capture` counts inventoried paths
 * captured of all inventoried, `diff` counts changed text files diffed. `bytes` is the captured
 * text read into content so far. No estimate or percentage is ever reported.
 */
export const CaptureProgressSchema = Schema.Struct({
  phase: Schema.Literals(["capture", "diff"]),
  done: Schema.Natural,
  total: Schema.Natural,
  bytes: Schema.Natural,
});
export type CaptureProgress = typeof CaptureProgressSchema.Type;

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
   * Snapshot reads name the session's current snapshot (from `open`, `status` or `diff`); any
   * other snapshot is stale. `after` is the previous page's `next`.
   */
  Schema.Struct({
    command: Schema.Literal("files"),
    ...exact,
    snapshotId: SnapshotIdSchema,
    after: Schema.optional(LogicalPathSchema),
  }),
  /**
   * One page of one side of a file in the snapshot. Start at `startLine` (default: the beginning)
   * or continue at a previous page's `next.offset`; `endLine` (inclusive) stops paging early.
   */
  Schema.Struct({
    command: Schema.Literal("code"),
    ...exact,
    snapshotId: SnapshotIdSchema,
    file: LogicalPathSchema,
    side: Schema.Literals(["old", "new"]),
    startLine: Schema.optional(LineNumberSchema),
    offset: Schema.optional(Schema.Natural),
    endLine: Schema.optional(LineNumberSchema),
  }).check(
    Schema.makeFilter(
      ({ startLine, offset }) =>
        startLine === undefined || offset === undefined || "choose startLine or offset, not both",
    ),
    Schema.makeFilter(
      ({ startLine = 1, endLine }) =>
        endLine === undefined || endLine >= startLine || "endLine is before startLine",
    ),
  ),
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
