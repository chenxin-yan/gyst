import { Schema } from "effect";
import {
  BlobIdSchema,
  type ContentSide,
  ContentSideSchema,
  type ManifestFile,
  ManifestFileSchema,
  type Provenance,
  ProvenanceSchema,
  type SnapshotManifest,
  SnapshotIdSchema,
} from "./content.ts";
import {
  type CapturedRange,
  CapturedRangeSchema,
  type CodeSide,
  CodeSideSchema,
  GuidanceTextSchema,
  LogicalPathSchema,
} from "./guidance.ts";
import {
  GroupSchema,
  HunkSchema,
  type Preparation,
  PreparationSchema,
  type Scope,
  ScopeSchema,
  type Session,
} from "./session.ts";
import { preparationOf } from "./status.ts";

/** One side of a file in a snapshot older than the walkthrough's that its guidance pins. */
export const PinnedSideSchema = Schema.Struct({
  snapshotId: SnapshotIdSchema,
  path: LogicalPathSchema,
  side: CodeSideSchema,
  content: ContentSideSchema,
});
export type PinnedSide = typeof PinnedSideSchema.Type;

/**
 * What a walkthrough export discloses, apart from its bytes and stamp: the recorded scope and the
 * Git identities resolved when the snapshot was captured, the ordered guidance and diff, and the
 * captured sides it includes. Of the current snapshot those are every changed file (both sides,
 * recorded renames and mode changes included) and every file guidance names (an unchanged one has
 * equal sides); of an earlier snapshot, only the sides guidance pins. Nothing else of the session
 * is here: no conversations, drafts, Viewed, checkout path, session id, times or stack metadata.
 */
export const WalkthroughSchema = Schema.Struct({
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
  snapshotId: SnapshotIdSchema,
  overview: GuidanceTextSchema,
  groups: Schema.Array(GroupSchema),
  hunks: Schema.Array(HunkSchema),
  files: Schema.Array(ManifestFileSchema),
  pinned: Schema.Array(PinnedSideSchema),
});
export type Walkthrough = typeof WalkthroughSchema.Type;

/** Every side a walkthrough discloses, in the order an export preview lists them. */
export function disclosedSides(walkthrough: Walkthrough): PinnedSide[] {
  return [
    ...walkthrough.files.flatMap(({ path, old, new: current }) => [
      { snapshotId: walkthrough.snapshotId, path, side: "old" as const, content: old },
      { snapshotId: walkthrough.snapshotId, path, side: "new" as const, content: current },
    ]),
    ...walkthrough.pinned,
  ];
}

/**
 * The standalone file's data: a walkthrough with the exact captured text of each text side it
 * discloses, by content identity, and when and by which gyst it was exported.
 */
export const WalkthroughExportSchema = Schema.Struct({
  gyst: Schema.String,
  exportedAt: Schema.String,
  walkthrough: WalkthroughSchema,
  contents: Schema.Record(BlobIdSchema, Schema.String),
}).check(
  Schema.makeFilter(({ walkthrough, contents }) => {
    const blobs = new Set(
      disclosedSides(walkthrough).flatMap(({ content }) =>
        content.kind === "text" ? [content.blob] : [],
      ),
    );
    const named = Object.keys(contents);
    return (
      (named.length === blobs.size && named.every((blob) => blobs.has(blob))) ||
      "an export carries the text of exactly the text sides it discloses"
    );
  }),
);
export type WalkthroughExport = typeof WalkthroughExportSchema.Type;

/** Why a side or a guidance target has no captured text to show. */
export const noTextReason = (
  side: CodeSide,
  content: Exclude<ContentSide, { kind: "text" }> | undefined,
) =>
  content === undefined
    ? "not in its snapshot"
    : content.kind === "absent"
      ? `absent on the ${side} side`
      : `${side} side not captured: ${content.reason}`;

/** A guidance target an export discloses without text, and why. */
export const UnavailableTargetSchema = Schema.Struct({
  target: CapturedRangeSchema,
  reason: Schema.String,
});
export type UnavailableTarget = typeof UnavailableTargetSchema.Type;

/**
 * What exporting the session would share, for a human to approve. `approval` identifies exactly
 * this walkthrough and its included content; it is null when the walkthrough is not ready, which
 * `preparation` explains.
 */
export const ExportPreviewPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  revision: Schema.Number,
  preparation: PreparationSchema,
  approval: Schema.NullOr(Schema.String),
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
  included: Schema.Array(PinnedSideSchema),
  unavailable: Schema.Array(UnavailableTargetSchema),
});
export type ExportPreviewPayload = typeof ExportPreviewPayloadSchema.Type;

/** A generated export: the approved state it shows and the standalone HTML file's text. */
export const ExportPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  snapshotId: SnapshotIdSchema,
  approval: Schema.String,
  exportedAt: Schema.String,
  /** A file name for it, unique to the snapshot. */
  name: Schema.String,
  html: Schema.String,
});
export type ExportPayload = typeof ExportPayloadSchema.Type;

/**
 * The recorded scope and what each side was captured from, one line each, as both export surfaces
 * state them. Uncommitted content is the working tree as captured, which no commit identifies; an
 * unborn repository's old side is an empty baseline, not a commit.
 */
export function provenanceLines(scope: Scope, provenance: Provenance): string[] {
  switch (provenance.kind) {
    case "uncommitted":
      return [
        "Scope: uncommitted changes, untracked files included",
        provenance.head === null
          ? "Old side: an empty baseline; the repository had no commits"
          : `Old side: HEAD ${provenance.head}`,
        "New side: the working tree as captured, which no commit identifies",
      ];
    case "range":
      return [
        `Scope: Git range ${scope.kind === "range" ? scope.range : ""}`,
        provenance.mergeBase === null
          ? `Old side: ${provenance.base}`
          : `Old side: merge base ${provenance.mergeBase} of ${provenance.base}`,
        `New side: ${provenance.head}`,
      ];
    case "pr":
      return [
        `Scope: GitHub PR ${scope.kind === "pr" ? `${scope.repository}#${scope.number}` : ""}`,
        `Old side: merge base ${provenance.mergeBase} of base ${provenance.base}`,
        `New side: head ${provenance.head}`,
      ];
  }
}

/** Why a walkthrough cannot be exported yet; empty when it is ready. */
export function readinessProblems(preparation: Preparation): string[] {
  if (preparation.state === "complete") return [];
  if (preparation.state === "plain") return ["the session has no walkthrough"];
  const problems: string[] = [];
  if (preparation.groupedHunks < preparation.totalHunks)
    problems.push(
      `${preparation.totalHunks - preparation.groupedHunks} of ${preparation.totalHunks} changed hunks are in no group`,
    );
  if (preparation.overviewMissing) problems.push("the walkthrough overview is missing");
  if (preparation.groupsMissingOverview.length > 0)
    problems.push(`groups without an overview: ${preparation.groupsMissingOverview.join(", ")}`);
  if (preparation.overviewOutdated) problems.push("the walkthrough overview is Outdated");
  if (preparation.groupsOutdated.length > 0)
    problems.push(`Outdated or emptied groups: ${preparation.groupsOutdated.join(", ")}`);
  if (preparation.notesOutdated.length > 0)
    problems.push(`Outdated notes: ${preparation.notesOutdated.join(", ")}`);
  // Every hunk is grouped and nothing else is missing, so some hunk is in two groups.
  if (problems.length === 0) problems.push("a changed hunk is in more than one group");
  return problems;
}

/** Every captured range guidance names: overview and group references, note anchors and references. */
const guidanceTargets = (session: Session): CapturedRange[] => [
  ...(session.overview?.references ?? []),
  ...session.groups.flatMap(({ overview, notes }) => [
    ...(overview?.references ?? []),
    ...notes.flatMap(({ anchor, references }) => [anchor, ...references]),
  ]),
];

/** The snapshots an export of the session reads manifests of: its current one first. */
export const exportSnapshotIds = (session: Session) => [
  ...new Set([session.snapshotId, ...guidanceTargets(session).map(({ snapshotId }) => snapshotId)]),
];

const sameSide = (a: ContentSide, b: ContentSide) =>
  a.kind === "text"
    ? b.kind === "text" && a.blob === b.blob
    : a.kind === "absent"
      ? b.kind === "absent"
      : b.kind === "unavailable" && a.reason === b.reason;

/** A file the snapshot changes: its sides differ, or a mode change or rename is recorded. */
const isChanged = (file: ManifestFile) =>
  file.modeChange !== undefined || file.renamedFrom !== undefined || !sameSide(file.old, file.new);

/** An export of the session: its readiness, and when ready what it would disclose. */
export type ExportPlan = {
  readonly preparation: Preparation;
  readonly walkthrough: Walkthrough | undefined;
  readonly unavailable: readonly UnavailableTarget[];
};

/**
 * What exporting the session would share, read from `manifests` (`exportSnapshotIds`) alone: never
 * the checkout. Each target keeps its pinned snapshot, path, side and lines; one whose side has no
 * captured text, or whose file its snapshot lacks, is listed as unavailable rather than dropped or
 * read elsewhere. A walkthrough that is not ready (`readinessProblems`) has none.
 */
export function exportPlanOf(
  session: Session,
  manifests: ReadonlyMap<string, SnapshotManifest>,
): ExportPlan {
  const preparation = preparationOf(session);
  const current = manifests.get(session.snapshotId);
  if (preparation.state !== "complete" || session.overview === null || current === undefined)
    return { preparation, walkthrough: undefined, unavailable: [] };
  const targets = guidanceTargets(session);
  const named = new Set(
    targets.flatMap(({ snapshotId, path }) => (snapshotId === session.snapshotId ? [path] : [])),
  );
  const files = current.files.filter((file) => isChanged(file) || named.has(file.path));
  const pinned = new Map<string, PinnedSide>();
  const unavailable = new Map<string, UnavailableTarget>();
  for (const target of targets) {
    const file = manifests.get(target.snapshotId)?.files.find(({ path }) => path === target.path);
    const content = file?.[target.side];
    if (content !== undefined && target.snapshotId !== session.snapshotId) {
      const side = { snapshotId: target.snapshotId, path: target.path, side: target.side, content };
      pinned.set(JSON.stringify([side.snapshotId, side.path, side.side]), side);
    }
    if (content?.kind !== "text")
      unavailable.set(JSON.stringify(target), {
        target,
        reason: noTextReason(target.side, content),
      });
  }
  const order = (a: PinnedSide, b: PinnedSide) =>
    a.snapshotId !== b.snapshotId
      ? a.snapshotId < b.snapshotId
        ? -1
        : 1
      : a.path !== b.path
        ? a.path < b.path
          ? -1
          : 1
        : a.side === b.side
          ? 0
          : a.side === "old"
            ? -1
            : 1;
  return {
    preparation,
    walkthrough: {
      scope: session.scope,
      provenance: current.provenance,
      snapshotId: session.snapshotId,
      overview: session.overview,
      groups: session.groups,
      hunks: session.hunks,
      files,
      pinned: [...pinned.values()].sort(order),
    },
    unavailable: [...unavailable.values()],
  };
}
