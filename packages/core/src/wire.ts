import { Schema } from "effect";
import {
  ContentSideSchema,
  LogicalPathSchema,
  ManifestFileSchema,
  SnapshotIdSchema,
} from "./content.ts";
import { ErrorPayloadSchema } from "./errors.ts";
import { PullRequestNumberSchema, PullRequestStatusSchema } from "./github.ts";
import { CodeSideSchema, LineNumberSchema } from "./guidance.ts";
import { AddonDiscoverySchema, AddonStateSchema } from "./navigation.ts";
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
  SourceUnavailable,
  type SourceUnavailableReason,
  SourceUnavailableReasonSchema,
  StaleRevision,
  ValidationFailed,
} from "./errors.ts";
export {
  type GitHubUnavailableReason,
  GitHubUnavailableReasonSchema,
  parsePullRequestUrl,
  type PullRequest,
  type PullRequestContext,
  PullRequestContextSchema,
  PullRequestNumberSchema,
  PullRequestSchema,
  type PullRequestScope,
  PullRequestScopeSchema,
  PullRequestStateSchema,
  type PullRequestStatus,
  PullRequestStatusSchema,
  pullRequestUrlOf,
  type Repository,
  RepositorySchema,
  type StackLayer,
  StackLayerSchema,
  type StackMembership,
  StackMembershipSchema,
} from "./github.ts";
export { type ContentSide, type ManifestFile } from "./content.ts";
export {
  anchoredHunkIds,
  type CapturedRange,
  CapturedRangeSchema,
  changedLinesOf,
  type CodeRange,
  CodeRangeSchema,
  type CodeSide,
  CodeSideSchema,
  diagramProblems,
  type GuidanceText,
  GuidanceTextSchema,
  isWebUrl,
  LineNumberSchema,
  MarkdownSchema,
  type Note,
  NoteSchema,
  parseReferenceHref,
} from "./guidance.ts";
export {
  type AddonDiscovery,
  AddonDiscoverySchema,
  type AddonState,
  AddonStateSchema,
  navigationAddon,
  navigationInstallCommand,
} from "./navigation.ts";
export {
  type Hunk,
  HunkSchema,
  type Scope,
  ScopeSchema,
  type SessionSummary,
  SessionSummarySchema,
  type StatusPayload,
  StatusPayloadSchema,
  type ViewedPayload,
  ViewedPayloadSchema,
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

/**
 * A byte offset into one side's captured content and the line it falls in: 1 + the LFs before
 * `offset`. At the end of content that is one past the last line only when the content is empty or
 * ends with LF; after an unterminated last line it is that last line.
 */
export const CodePositionSchema = Schema.Struct({ line: LineNumberSchema, offset: Schema.Natural });
export type CodePosition = typeof CodePositionSchema.Type;

/**
 * A point in one side's captured text: an LF-delimited line as in `CodePositionSchema`, and UTF-16
 * code units from that line's start (a CR, lone or before the LF, and a BOM each count as one).
 */
export const TextPointSchema = Schema.Struct({ line: LineNumberSchema, character: Schema.Natural });
export type TextPoint = typeof TextPointSchema.Type;

export const TextRangeSchema = Schema.Struct({ start: TextPointSchema, end: TextPointSchema });
export type TextRange = typeof TextRangeSchema.Type;

/**
 * A known reason navigation over one side's captured files may be incomplete. Gaps are named
 * evidence, never a completeness claim: no gaps does not mean every input was present.
 */
export const NavigationGapSchema = Schema.Union([
  /** This captured `package.json` declares packages; installed packages are never captured. */
  Schema.Struct({ kind: Schema.Literal("dependencies"), file: LogicalPathSchema }),
  /** A path on this side whose bytes were not captured: a symlink, submodule or non-text source. */
  Schema.Struct({
    kind: Schema.Literal("uncaptured"),
    file: LogicalPathSchema,
    reason: ContentSideSchema.members[2].fields.reason,
  }),
  /** No `tsconfig.json` or `jsconfig.json` on this side, so the engine infers a project. */
  Schema.Struct({ kind: Schema.Literal("no-project-config") }),
  /** An import or configuration (`extends`) in this file whose target the capture lacks. */
  Schema.Struct({
    kind: Schema.Literal("unresolved-import"),
    file: LogicalPathSchema,
    message: Schema.String,
  }),
]);
export type NavigationGap = typeof NavigationGapSchema.Type;

const SideSchema = Schema.Literals(["old", "new"]);

/** A place in one side's captured text; navigation never names anything outside the capture. */
export const NavigationLocationSchema = Schema.Struct({
  file: LogicalPathSchema,
  range: TextRangeSchema,
});
export type NavigationLocation = typeof NavigationLocationSchema.Type;

/** An identifier in captured text: the queried symbol, or one offered on a line. */
const NavigationSymbolSchema = Schema.Struct({ text: Schema.String, range: TextRangeSchema });

/** Why navigation did not run; review itself is unaffected by every one of these. */
export const NavigationUnavailableSchema = Schema.Union([
  /** The launcher found no usable add-on of this release; `addon` carries the install command. */
  Schema.Struct({ kind: Schema.Literal("addon"), addon: AddonStateSchema }),
  /** The snapshot is not (or stopped being) the session's current one; only it is analysed. */
  Schema.Struct({ kind: Schema.Literal("historical") }),
  /** That side of the file has no captured TS/JS text to analyse. */
  Schema.Struct({ kind: Schema.Literal("not-source"), detail: Schema.String }),
  /** The engine failed to start, answer or stay up. */
  Schema.Struct({ kind: Schema.Literal("engine"), message: Schema.String }),
]);
export type NavigationUnavailable = typeof NavigationUnavailableSchema.Type;

/**
 * A definition or references answer. The identity fields restate the request, so a reply that
 * arrives after the reader moved on can be recognised and dropped. `locations` are on the queried
 * side only; `outside` counts results beyond the captured files, which are never named. Gaps make
 * any result, an empty one included, potentially incomplete.
 */
export const NavigationResultPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  side: SideSchema,
  file: LogicalPathSchema,
  query: Schema.Literals(["definition", "references"]),
  position: TextPointSchema,
  outcome: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("locations"),
      symbol: NavigationSymbolSchema,
      locations: Schema.Array(NavigationLocationSchema),
      outside: Schema.Natural,
      gaps: Schema.Array(NavigationGapSchema),
    }),
    /** No identifier at the position, so nothing was asked of the engine. */
    Schema.Struct({ kind: Schema.Literal("no-symbol") }),
    Schema.Struct({ kind: Schema.Literal("unavailable"), reason: NavigationUnavailableSchema }),
  ]),
});
export type NavigationResultPayload = typeof NavigationResultPayloadSchema.Type;

/** The identifiers on one line the engine resolves, in line order, with the line's identity. */
export const IdentifiersPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  side: SideSchema,
  file: LogicalPathSchema,
  line: LineNumberSchema,
  outcome: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("identifiers"),
      identifiers: Schema.Array(NavigationSymbolSchema),
      gaps: Schema.Array(NavigationGapSchema),
    }),
    Schema.Struct({ kind: Schema.Literal("unavailable"), reason: NavigationUnavailableSchema }),
  ]),
});
export type IdentifiersPayload = typeof IdentifiersPayloadSchema.Type;

/**
 * The daemon's analysis of one side, as last tracked: never started by asking. `queued` waits for
 * an engine slot, `preparing` lays out the side and starts its engine, `ready` reports that
 * layout's cost and known gaps, and `unavailable` is why the side cannot be analysed, or the last
 * failure, which the next query retries.
 */
export const NavigationSideStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stopped") }),
  Schema.Struct({ kind: Schema.Literal("queued") }),
  Schema.Struct({ kind: Schema.Literal("preparing") }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    files: Schema.Natural,
    bytes: Schema.Natural,
    gaps: Schema.Array(NavigationGapSchema),
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: NavigationUnavailableSchema }),
]);
export type NavigationSideState = typeof NavigationSideStateSchema.Type;

/** Navigation readiness for one snapshot: the launcher's add-on and each side's analysis. */
export const NavigationStatusPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  addon: AddonStateSchema,
  sides: Schema.Struct({ old: NavigationSideStateSchema, new: NavigationSideStateSchema }),
});
export type NavigationStatusPayload = typeof NavigationStatusPayloadSchema.Type;

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
  side: CodeSideSchema,
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

/** A PR session's stack context after an explicit metadata recheck. */
export const StackPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  pullRequest: PullRequestStatusSchema,
});
export type StackPayload = typeof StackPayloadSchema.Type;

/** Also the recorded answer to every retry of the same delete request. */
export const DeletePayloadSchema = Schema.Struct({
  deleted: Schema.Literal(true),
  sessionId: Schema.String,
});
export type DeletePayload = typeof DeletePayloadSchema.Type;

/** An exact saved-session id; no operation falls back to the caller's directory. */
const exact = { session: Schema.String };
const navigationTarget = {
  ...exact,
  snapshotId: SnapshotIdSchema,
  side: SideSchema,
  file: LogicalPathSchema,
};
const navigationStatus = {
  command: Schema.Literal("navigation"),
  ...exact,
  snapshotId: SnapshotIdSchema,
};
const definitionQuery = {
  command: Schema.Literal("definition"),
  ...navigationTarget,
  position: TextPointSchema,
};
const referencesQuery = {
  command: Schema.Literal("references"),
  ...navigationTarget,
  position: TextPointSchema,
};
const identifiersQuery = {
  command: Schema.Literal("identifiers"),
  ...navigationTarget,
  line: LineNumberSchema,
};

/** Browser operations a bridge forwards to the daemon exactly as decoded. */
const reviewRequests = [
  Schema.Struct({ command: Schema.Literal("list") }),
  Schema.Struct({ command: Schema.Literal("open"), ...exact }),
  Schema.Struct({ command: Schema.Literal("status"), ...exact }),
  Schema.Struct({ command: Schema.Literal("check"), ...exact }),
  /**
   * Explicitly rechecks a PR session's native stack metadata: membership, order, PR states and
   * verification only. It never refreshes code or changes review state.
   */
  Schema.Struct({ command: Schema.Literal("stack"), ...exact }),
  /**
   * Opens, or resumes as it is, one layer of the PR session's known stack. The checkout and
   * repository are the session's own, so a browser can name neither.
   */
  Schema.Struct({ command: Schema.Literal("layer"), ...exact, number: PullRequestNumberSchema }),
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
    side: CodeSideSchema,
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
  /**
   * The human marks exactly `hunkIds` Viewed (or not), against the snapshot and revision they
   * observed. `requestId` is chosen before sending and reused for every retry, like `delete`.
   * No CLI command sends it: agents cannot mark Viewed.
   */
  Schema.Struct({
    command: Schema.Literal("viewed"),
    ...exact,
    snapshotId: SnapshotIdSchema,
    revision: Schema.Number,
    requestId: Schema.String,
    hunkIds: Schema.Array(Schema.String),
    viewed: Schema.Boolean,
  }),
] as const;

/**
 * The operations a browser may request: exact saved-session ids and read filters only. Checkout
 * paths, Git input, executables, add-on locations and caller roles are not expressible. A bridge
 * decodes browser input with this schema and forwards it unchanged, except that it binds its own
 * add-on discovery into navigation operations.
 */
export const BrowserRequestSchema = Schema.Union([
  ...reviewRequests,
  /**
   * Navigation readiness of the session's current snapshot. `recheck` (Check again) has the
   * launcher look for the add-on on its launch PATH again first.
   */
  Schema.Struct({ ...navigationStatus, recheck: Schema.optional(Schema.Boolean) }),
  /** Definitions or references of the symbol at `position` on one side of a snapshot file. */
  Schema.Struct(definitionQuery),
  Schema.Struct(referencesQuery),
  /** The identifiers on one line that can be queried. */
  Schema.Struct(identifiersQuery),
]);
export type BrowserRequest = typeof BrowserRequestSchema.Type;

/** One validated operation per session command; CLI flags and argv never cross the socket. */
export const RequestSchema = Schema.Union([
  /**
   * Trusted local entry points only. `cwd` is the caller's directory, bound by the entry point, and
   * selects the repository; the recorded scope then creates or reuses that repository's session.
   */
  Schema.Struct({ command: Schema.Literal("open"), cwd: Schema.String, scope: ScopeSchema }),
  ...reviewRequests,
  /** `batch` is the JSON apply envelope text; the use case validates it against `ApplyEnvelopeSchema`. */
  Schema.Struct({ command: Schema.Literal("apply"), ...exact, batch: Schema.String }),
  Schema.Struct({ command: Schema.Literal("refresh"), ...exact }),
  /**
   * The browser's navigation operations over the session's current snapshot, with `addon`: what
   * the launcher discovered on its own PATH, bound by that trusted entry point like `open.cwd`.
   */
  Schema.Struct({ ...navigationStatus, addon: AddonDiscoverySchema }),
  Schema.Struct({ ...definitionQuery, addon: AddonDiscoverySchema }),
  Schema.Struct({ ...referencesQuery, addon: AddonDiscoverySchema }),
  Schema.Struct({ ...identifiersQuery, addon: AddonDiscoverySchema }),
]);
export type Request = typeof RequestSchema.Type;

/** What a subscriber compares with what it shows; `revision` only grows within a session. */
export const SessionVersionSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: Schema.String,
  revision: Schema.Number,
  /**
   * A PR session's stack context as its status reports it: an opaque identity of its PR and stack
   * metadata and its other layers' sessions, which change without the revision. Differs whenever
   * that context does; absent for any other session.
   */
  context: Schema.optional(Schema.String),
});
export type SessionVersion = typeof SessionVersionSchema.Type;

/** A subscription names one exact saved session, like every other browser operation. */
export const SubscribeRequestSchema = Schema.Struct(exact);
export type SubscribeRequest = typeof SubscribeRequestSchema.Type;

/**
 * One frame of a session subscription: committed-state invalidations, never history, so a
 * subscriber rereads state rather than replaying frames. `ready` comes first; its version is read
 * atomically with registration, so every later commit arrives as `changed`. `daemon` is the
 * announcing daemon's instance id, its generation. `deleted` is terminal. `failed` means the
 * subscription could not start or the daemon's stream broke. Any end other than `deleted` means
 * resynchronize.
 */
export const SubscriptionEventSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    daemon: Schema.String,
    ...SessionVersionSchema.fields,
  }),
  Schema.Struct({ kind: Schema.Literal("changed"), ...SessionVersionSchema.fields }),
  Schema.Struct({ kind: Schema.Literal("deleted"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), error: ErrorPayloadSchema }),
]);
export type SubscriptionEvent = typeof SubscriptionEventSchema.Type;

export const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
]);
export type Reply = typeof ReplySchema.Type;
