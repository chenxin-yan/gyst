import { Schema } from "effect";
import {
  PullRequestContextSchema,
  PullRequestScopeSchema,
  PullRequestStatusSchema,
} from "./github.ts";
import {
  GuidanceTextSchema,
  guidanceTextFields,
  MarkdownSchema,
  NoteSchema,
  noteFields,
} from "./guidance.ts";
import { TitleSchema } from "./metadata.ts";

export const HunkSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  header: Schema.String,
  patch: Schema.String,
  contentHash: Schema.String,
});
export type Hunk = typeof HunkSchema.Type;

/** One review question. A session's `groups` array order is the walkthrough order. */
export const GroupSchema = Schema.Struct({
  id: Schema.String,
  title: TitleSchema,
  overview: Schema.NullOr(GuidanceTextSchema),
  hunkIds: Schema.Array(Schema.String),
  /** The member hunks' files, each once, in the order the group explains them. */
  files: Schema.Array(Schema.String),
  /** In code order: file order, then hunk order, old side first, then start line. */
  notes: Schema.Array(NoteSchema),
});
export type Group = typeof GroupSchema.Type;

/**
 * What a session reviews, recorded as the caller wrote it. With the repository root it is a local
 * session's identity, and a PR's alone is its repository plus PR: a moved ref, a new PR head or
 * stack position, or an equal resolved diff never makes it another session.
 */
export const ScopeSchema = Schema.Union([
  /** HEAD (or the empty tree) against the working tree, including untracked files. */
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  /** A Git range such as `main...feature`; its endpoints resolve again at each capture. */
  Schema.Struct({ kind: Schema.Literal("range"), range: Schema.String }),
  PullRequestScopeSchema,
]);
export type Scope = typeof ScopeSchema.Type;

const sessionSummaryFields = {
  id: Schema.String,
  repoRoot: Schema.String,
  scope: ScopeSchema,
  /** The published snapshot manifest's `snapshotIdOf`: every captured input, not only the diff. Refresh replaces it. */
  snapshotId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
export const SessionSummarySchema = Schema.Struct(sessionSummaryFields);
export type SessionSummary = typeof SessionSummarySchema.Type;
/**
 * How far an agent has prepared the walkthrough. `plain` has no guidance at all; `complete` puts
 * every current hunk in exactly one group, with the walkthrough and every group overview present
 * and no Outdated guidance. Anything between is `incomplete`: valid and readable, never refused.
 */
export const PreparationSchema = Schema.Struct({
  state: Schema.Literals(["plain", "incomplete", "complete"]),
  groupedHunks: Schema.Natural,
  totalHunks: Schema.Natural,
  overviewMissing: Schema.Boolean,
  groupsMissingOverview: Schema.Array(Schema.String),
  overviewOutdated: Schema.Boolean,
  /** Groups a refresh emptied, or whose overview is Outdated. */
  groupsOutdated: Schema.Array(Schema.String),
  notesOutdated: Schema.Array(Schema.String),
});
export type Preparation = typeof PreparationSchema.Type;

// Wire guidance carries Markdown; receipts carry indices into `receiptTexts`.
const statusPayloadFields = <Text extends Schema.Top>(text: Text) => ({
  session: SessionSummarySchema,
  revision: Schema.Number,
  overview: Schema.NullOr(Schema.Struct(guidanceTextFields(text))),
  groups: Schema.Array(
    Schema.Struct({
      ...GroupSchema.fields,
      overview: Schema.NullOr(Schema.Struct(guidanceTextFields(text))),
      notes: Schema.Array(Schema.Struct(noteFields(text))),
      count: Schema.Number,
    }),
  ),
  preparation: PreparationSchema,
  viewedHunkIds: Schema.Array(Schema.String),
  /** `viewed` is derived: every changed hunk of the file is Viewed. */
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, hunkCount: Schema.Number, viewed: Schema.Boolean }),
  ),
});
export const StatusPayloadSchema = Schema.Struct({
  ...statusPayloadFields(MarkdownSchema),
  /** A PR session's stack context; current, never part of a recorded receipt. */
  pullRequest: Schema.optional(PullRequestStatusSchema),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;
const ReceiptStatusSchema = Schema.Struct(statusPayloadFields(Schema.Natural));
export type ReceiptStatus = typeof ReceiptStatusSchema.Type;

// `digest` pins the receipt to the exact batch it answered, so a reused key cannot replay another.
const ApplyReceiptSchema = Schema.Struct({
  key: Schema.String,
  digest: Schema.String,
  status: ReceiptStatusSchema,
});
export type ApplyReceipt = typeof ApplyReceiptSchema.Type;

/** The recorded answer to a `viewed` request: the revision it produced, not current status. */
export const ViewedPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: Schema.String,
  revision: Schema.Number,
  hunkIds: Schema.Array(Schema.String),
  viewed: Schema.Boolean,
});
export type ViewedPayload = typeof ViewedPayloadSchema.Type;
const ViewedReceiptSchema = Schema.Struct({
  requestId: Schema.String,
  digest: Schema.String,
  result: ViewedPayloadSchema,
});
export type ViewedReceipt = typeof ViewedReceiptSchema.Type;

/**
 * The recorded answer to a `refresh` request. `replaced` is false when the capture was identical,
 * so the snapshot and review state stayed as they were.
 */
export const RefreshPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  previousSnapshotId: Schema.String,
  snapshotId: Schema.String,
  revision: Schema.Number,
  replaced: Schema.Boolean,
});
export type RefreshPayload = typeof RefreshPayloadSchema.Type;
const RefreshReceiptSchema = Schema.Struct({
  requestId: Schema.String,
  digest: Schema.String,
  result: RefreshPayloadSchema,
});
export type RefreshReceipt = typeof RefreshReceiptSchema.Type;

export const SessionSchema = Schema.Struct({
  ...sessionSummaryFields,
  revision: Schema.Number,
  hunks: Schema.Array(HunkSchema),
  /** The walkthrough overview. */
  overview: Schema.NullOr(GuidanceTextSchema),
  groups: Schema.Array(GroupSchema),
  /** Human reading progress, one bit per current hunk: the hunks marked Viewed. */
  viewedHunkIds: Schema.Array(Schema.String),
  // Progressive publication stores each distinct historical overview or note text once.
  receiptTexts: Schema.Array(MarkdownSchema),
  applyReceipts: Schema.Array(ApplyReceiptSchema),
  viewedReceipts: Schema.Array(ViewedReceiptSchema),
  refreshReceipts: Schema.Array(RefreshReceiptSchema),
  /** A PR session's GitHub context, apart from its snapshot: refresh re-reads only the range. */
  pullRequest: Schema.optional(PullRequestContextSchema),
}).check(
  Schema.makeFilter(
    (session) =>
      (session.scope.kind === "pr") === (session.pullRequest !== undefined) ||
      "a session has GitHub PR context exactly when its scope is a PR",
  ),
  Schema.makeFilter((session) => {
    const hunkIds = new Set(session.hunks.map(({ id }) => id));
    return (
      (new Set(session.viewedHunkIds).size === session.viewedHunkIds.length &&
        session.viewedHunkIds.every((id) => hunkIds.has(id))) ||
      "viewed hunks must be distinct current hunks"
    );
  }),
  Schema.makeFilter(
    (session) =>
      session.applyReceipts.every(({ status }) =>
        [
          status.overview,
          ...status.groups.flatMap(({ overview, notes }) => [overview, ...notes]),
        ].every((text) => text === null || text.markdown < session.receiptTexts.length),
      ) || "receipt text reference is outside receiptTexts",
  ),
);
export type Session = typeof SessionSchema.Type;
