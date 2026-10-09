import { Result, Schema } from "effect";
import type { ContentSide } from "./content.ts";
import { draftOf, type MutableGroup, type MutableSession } from "./draft.ts";
import { StaleRevision, ValidationFailed } from "./errors.ts";
import {
  anchoredHunkIds,
  type CapturedRange,
  type CodeRange,
  CodeRangeSchema,
  type CodeSide,
  type GuidanceText,
  MarkdownSchema,
  type Note,
} from "./guidance.ts";
import { hash } from "./hash.ts";
import { survivingHunkIds } from "./mapping.ts";
import { inspectMarkdown } from "./markdown.ts";
import { TitleSchema } from "./metadata.ts";
import type { Hunk, ReceiptStatus, Session, StatusPayload } from "./session.ts";
import { statusOf } from "./status.ts";

export const WalkthroughUpdateSchema = Schema.Struct({
  type: Schema.Literal("walkthrough.update"),
  /** `null` removes the walkthrough overview. */
  overview: Schema.optional(Schema.NullOr(MarkdownSchema)),
  /** Every current group id, once each, in the new walkthrough order. */
  groupOrder: Schema.optional(Schema.Array(Schema.String)),
});
export const GroupCreateSchema = Schema.Struct({
  type: Schema.Literal("group.create"),
  id: Schema.String,
  title: TitleSchema,
  overview: MarkdownSchema,
  memberHunkIds: Schema.Array(Schema.String),
  /** Defaults to the members' files in snapshot order. */
  files: Schema.optional(Schema.Array(Schema.String)),
});
export const GroupUpdateSchema = Schema.Struct({
  type: Schema.Literal("group.update"),
  id: Schema.String,
  title: Schema.optional(TitleSchema),
  /** `null` removes the group overview. */
  overview: Schema.optional(Schema.NullOr(MarkdownSchema)),
  memberHunkIds: Schema.optional(Schema.Array(Schema.String)),
  /** Omitted with new members: kept files stay in order and new files follow in snapshot order. */
  files: Schema.optional(Schema.Array(Schema.String)),
});
export const GroupDissolveSchema = Schema.Struct({
  type: Schema.Literal("group.dissolve"),
  id: Schema.String,
});
export const NoteCreateSchema = Schema.Struct({
  type: Schema.Literal("note.create"),
  id: Schema.String,
  group: Schema.String,
  /** Pinned to the batch's snapshot. */
  anchor: CodeRangeSchema,
  markdown: MarkdownSchema,
});
export const NoteUpdateSchema = Schema.Struct({
  type: Schema.Literal("note.update"),
  id: Schema.String,
  /** A new anchor re-anchors the note and keeps its identity. */
  anchor: Schema.optional(CodeRangeSchema),
  markdown: Schema.optional(MarkdownSchema),
});
export const NoteRemoveSchema = Schema.Struct({
  type: Schema.Literal("note.remove"),
  id: Schema.String,
});
/**
 * Explicit revalidation of Outdated guidance with its wording unchanged, after checking it against
 * the batch's snapshot: its references are pinned again to that snapshot, each of which must be
 * captured text there. A note must already be anchored to that snapshot (re-anchor it with
 * `note.update` first). Viewed is untouched.
 */
export const WalkthroughRevalidateSchema = Schema.Struct({
  type: Schema.Literal("walkthrough.revalidate"),
});
export const GroupRevalidateSchema = Schema.Struct({
  type: Schema.Literal("group.revalidate"),
  id: Schema.String,
});
export const NoteRevalidateSchema = Schema.Struct({
  type: Schema.Literal("note.revalidate"),
  id: Schema.String,
});
export const ApplyOpSchema = Schema.Union([
  WalkthroughUpdateSchema,
  WalkthroughRevalidateSchema,
  GroupCreateSchema,
  GroupUpdateSchema,
  GroupRevalidateSchema,
  GroupDissolveSchema,
  NoteCreateSchema,
  NoteUpdateSchema,
  NoteRevalidateSchema,
  NoteRemoveSchema,
]);
export type ApplyOp = typeof ApplyOpSchema.Type;
export const ApplyEnvelopeSchema = Schema.Struct({
  revision: Schema.Number,
  /** The snapshot the agent read; a batch for any other snapshot is stale. */
  snapshotId: Schema.String,
  idempotencyKey: Schema.String,
  ops: Schema.Array(ApplyOpSchema),
});
export type ApplyEnvelope = typeof ApplyEnvelopeSchema.Type;
export type ValidationDetail = { opIndex: number; message: string };
/** A replayed idempotency key returns the recorded status and no session to persist. */
export type ApplyOutcome = { readonly status: StatusPayload; readonly session?: Session };

/** What one side of a snapshot file holds; `missing` means the snapshot has no such path. */
export type CapturedSide =
  | { readonly kind: "text"; readonly lines: number }
  | Exclude<ContentSide, { readonly kind: "text" }>
  | { readonly kind: "missing" };
/**
 * What the caller reads for a batch from captured content, as apply itself never reads content:
 * the line counts of `snapshotId`'s sides its written ranges are checked against, and the hunks
 * of each earlier snapshot a note it may change is still anchored on (see `earlierAnchorsOf`).
 */
export type CapturedIndex = {
  readonly snapshotId: string;
  readonly sides: ReadonlyMap<string, CapturedSide>;
  readonly earlierHunks: ReadonlyMap<string, readonly Hunk[]>;
};
export const capturedSideKey = (side: CodeSide, path: string) => `${side}\0${path}`;

/**
 * The file sides whose captured lines `applyBatch` needs for this envelope's written ranges: note
 * anchors, the references inside every Markdown text it writes, and those of every stored text it
 * revalidates in `session`.
 */
export function capturedTargetsOf(
  envelope: ApplyEnvelope,
  session: Session,
): { readonly path: string; readonly side: CodeSide }[] {
  const targets = new Map<string, { path: string; side: CodeSide }>();
  const target = ({ path, side }: CodeRange) =>
    targets.set(capturedSideKey(side, path), { path, side });
  for (const op of envelope.ops) {
    if ((op.type === "note.create" || op.type === "note.update") && op.anchor) target(op.anchor);
    const markdown =
      "markdown" in op
        ? op.markdown
        : "overview" in op
          ? op.overview
          : revalidatedText(session, op)?.markdown;
    if (typeof markdown === "string") inspectMarkdown(markdown).references.forEach(target);
  }
  return [...targets.values()];
}

/**
 * The earlier snapshots whose hunks `applyBatch` needs for this envelope: those the notes it may
 * edit, re-anchor or remove, a dissolved group's included, are still anchored on.
 */
export function earlierAnchorsOf(envelope: ApplyEnvelope, session: Session): string[] {
  const named = new Set(
    envelope.ops.flatMap((op) =>
      op.type === "note.update" || op.type === "note.remove"
        ? [op.id]
        : op.type === "group.dissolve"
          ? (session.groups.find(({ id }) => id === op.id)?.notes.map(({ id }) => id) ?? [])
          : [],
    ),
  );
  const snapshotIds = session.groups
    .flatMap(({ notes }) => notes)
    .filter(({ id, anchor }) => named.has(id) && anchor.snapshotId !== session.snapshotId)
    .map(({ anchor }) => anchor.snapshotId);
  return [...new Set(snapshotIds)];
}

/** The stored text a revalidation op names, if it exists. */
function revalidatedText(session: Session, op: ApplyOp): GuidanceText | null | undefined {
  if (op.type === "walkthrough.revalidate") return session.overview;
  if (op.type === "group.revalidate")
    return session.groups.find(({ id }) => id === op.id)?.overview;
  if (op.type === "note.revalidate")
    return session.groups.flatMap(({ notes }) => notes).find(({ id }) => id === op.id);
  return undefined;
}

// Receipts intern Markdown while preserving exact historical anchors and status.
function receiptStatusOf(draft: MutableSession, status: StatusPayload): ReceiptStatus {
  // ponytail: linear indexOf over distinct texts; a hash index if a session publishes thousands.
  const intern = <T extends { readonly markdown: string }>(text: T) => {
    const index = draft.receiptTexts.indexOf(text.markdown);
    return { ...text, markdown: index >= 0 ? index : draft.receiptTexts.push(text.markdown) - 1 };
  };
  return {
    ...status,
    overview: status.overview && intern(status.overview),
    groups: status.groups.map((group) => ({
      ...group,
      overview: group.overview && intern(group.overview),
      notes: group.notes.map(intern),
    })),
  };
}
function recordedStatusOf(session: Session, status: ReceiptStatus): StatusPayload {
  const text = <T extends { readonly markdown: number }>(recorded: T) => ({
    ...recorded,
    markdown: session.receiptTexts[recorded.markdown]!,
  });
  return {
    ...status,
    overview: status.overview && text(status.overview),
    groups: status.groups.map((group) => ({
      ...group,
      overview: group.overview && text(group.overview),
      notes: group.notes.map(text),
    })),
  };
}

/** A text's own fields, without the identity and anchor a note carries beside them. */
const textOf = ({ markdown, references, outdated }: GuidanceText): GuidanceText => ({
  markdown,
  references,
  ...(outdated && { outdated }),
});

const sameRange = (a: CapturedRange, b: CapturedRange) =>
  a.snapshotId === b.snapshotId &&
  a.path === b.path &&
  a.side === b.side &&
  a.startLine === b.startLine &&
  a.endLine === b.endLine;

function capturedProblem(captured: CapturedIndex, range: CodeRange): string | undefined {
  const side = captured.sides.get(capturedSideKey(range.side, range.path));
  const target = `${range.side} side of ${range.path}`;
  if (!side || side.kind === "missing") return `${range.path} is not in the captured snapshot`;
  if (side.kind === "absent") return `the ${target} does not exist`;
  if (side.kind === "unavailable") return `the ${target} is ${side.reason}, not captured text`;
  if (range.endLine > side.lines)
    return `lines ${range.startLine}-${range.endLine} are outside the ${target}, which has ${side.lines} lines`;
  return undefined;
}

/**
 * Viewed is unset on the hunks whose guidance changed between `before` and `after`: a note added,
 * removed, edited or re-anchored unviews the hunks of both anchors (of one kept on earlier code,
 * those that survived since, read in `earlierHunks`); a group or walkthrough overview edited or
 * removed unviews that group's or every grouped hunk. A first overview, reordering, titles and
 * membership alone change nothing, and agents never set Viewed.
 */
function invalidatedHunkIds(
  before: Session,
  after: MutableSession,
  earlierHunks: CapturedIndex["earlierHunks"],
): Set<string> {
  const unviewed = new Set<string>();
  const unview = (ids: Iterable<string>) => {
    for (const id of ids) unviewed.add(id);
  };
  const anchored = (note: Note | undefined) => {
    if (!note) return [];
    if (note.anchor.snapshotId === before.snapshotId)
      return anchoredHunkIds(before.hunks, note.anchor);
    const pinned = earlierHunks.get(note.anchor.snapshotId);
    return pinned ? survivingHunkIds(pinned, before.hunks, note.anchor) : [];
  };
  const notesOf = (groups: Session["groups"]) =>
    new Map(groups.flatMap(({ notes }) => notes.map((note) => [note.id, note] as const)));
  const notesBefore = notesOf(before.groups);
  const notesAfter = notesOf(after.groups);
  for (const id of new Set([...notesBefore.keys(), ...notesAfter.keys()])) {
    const old = notesBefore.get(id);
    const current = notesAfter.get(id);
    if (
      old &&
      current &&
      old.markdown === current.markdown &&
      sameRange(old.anchor, current.anchor)
    )
      continue;
    unview([...anchored(old), ...anchored(current)]);
  }
  for (const group of before.groups) {
    if (!group.overview) continue;
    const current = after.groups.find(({ id }) => id === group.id);
    if (current?.overview?.markdown !== group.overview.markdown) unview((current ?? group).hunkIds);
  }
  if (before.overview && after.overview?.markdown !== before.overview.markdown)
    unview([...before.groups, ...after.groups].flatMap(({ hunkIds }) => hunkIds));
  return unviewed;
}

const sides: Record<CodeSide, number> = { old: 0, new: 1 };
function sortNotes(draft: MutableSession, group: MutableGroup) {
  const hunkIndex = new Map(draft.hunks.map(({ id }, index) => [id, index]));
  const position = ({ anchor }: Note) => {
    const file = group.files.indexOf(anchor.path);
    const hunks =
      anchor.snapshotId === draft.snapshotId
        ? anchoredHunkIds(draft.hunks, anchor).map((id) => hunkIndex.get(id)!)
        : [];
    return [
      file < 0 ? Infinity : file,
      Math.min(...hunks),
      sides[anchor.side],
      anchor.startLine,
    ] as const;
  };
  group.notes.sort((a, b) => {
    const [x, y] = [position(a), position(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || 0;
  });
}

const stale = (message: string) =>
  Result.fail(
    new StaleRevision({
      message,
      detail: [{ opIndex: -1, message }] satisfies ValidationDetail[],
    }),
  );

/**
 * Applies every op of `envelope` or none. A recorded idempotency key answers first; otherwise the
 * batch must name the session's current snapshot and revision, and `captured` must index that
 * snapshot. The resulting state is validated as a whole, so op order only matters where one op
 * names what another creates.
 */
export function applyBatch(
  session: Session,
  envelope: ApplyEnvelope,
  captured: CapturedIndex,
  updatedAt: string,
): Result.Result<ApplyOutcome, StaleRevision | ValidationFailed> {
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the batch.
  const digest = hash(JSON.stringify(envelope));
  const receipt = session.applyReceipts.find(({ key }) => key === envelope.idempotencyKey);
  if (receipt) {
    if (receipt.digest === digest)
      return Result.succeed({ status: recordedStatusOf(session, receipt.status) });
    return Result.fail(
      new ValidationFailed({
        message: "idempotency key reused with a different batch",
        detail: [
          {
            opIndex: -1,
            message: `idempotency key ${envelope.idempotencyKey} answered another batch`,
          },
        ] satisfies ValidationDetail[],
      }),
    );
  }
  const current = `current snapshot is ${session.snapshotId} at revision ${session.revision}`;
  if (envelope.snapshotId !== session.snapshotId)
    return stale(`apply snapshot ${envelope.snapshotId} is stale; ${current}`);
  if (envelope.revision !== session.revision)
    return stale(`apply revision ${envelope.revision} is stale; ${current}`);
  if (captured.snapshotId !== session.snapshotId)
    return stale(`the snapshot changed while the batch was checked; ${current}`);

  const draft = draftOf(session);
  const errors: ValidationDetail[] = [];
  const fail = (opIndex: number, message: string) => errors.push({ opIndex, message });
  const hunkIds = new Set(draft.hunks.map(({ id }) => id));
  const groupOf = (id: string) => draft.groups.find((group) => group.id === id);
  const noteOf = (id: string) => {
    for (const group of draft.groups) {
      const index = group.notes.findIndex((note) => note.id === id);
      if (index >= 0) return { group, index };
    }
    return undefined;
  };
  const membersProblem = (members: readonly string[]) =>
    members.length === 0 || new Set(members).size !== members.length
      ? "group members must be non-empty and unique"
      : members.some((id) => !hunkIds.has(id))
        ? "group member does not exist"
        : undefined;
  const filesOf = (members: readonly string[]) => [
    ...new Set(draft.hunks.filter(({ id }) => members.includes(id)).map(({ file }) => file)),
  ];
  // The last op that wrote each group or note, so whole-state problems name a cause.
  const touched = new Map<string, number>();
  const touch = (kind: "group" | "note", id: string, opIndex: number) =>
    touched.set(`${kind}\0${id}`, opIndex);
  const touchedBy = (kind: "group" | "note", id: string) => touched.get(`${kind}\0${id}`);
  // Notes whose anchor this batch wrote; only those are checked against captured lines.
  const anchorsWritten = new Set<string>();
  /**
   * Every text the batch writes must pass the rich-content policy. Unchanged text keeps its stored
   * pins, even to an older snapshot; changed text pins its references to this snapshot.
   */
  const guidanceText = (
    opIndex: number,
    markdown: string,
    stored: GuidanceText | null,
  ): GuidanceText => {
    const { references, problems } = inspectMarkdown(markdown);
    for (const problem of problems) fail(opIndex, problem);
    if (stored?.markdown === markdown) return textOf(stored);
    for (const reference of references) {
      const problem = capturedProblem(captured, reference);
      if (!problem) continue;
      const { side, path, startLine, endLine } = reference;
      const lines = endLine === startLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
      fail(opIndex, `reference gyst:${side}/${path}#${lines}: ${problem}`);
    }
    return {
      markdown,
      references: references.map((reference) => ({ snapshotId: draft.snapshotId, ...reference })),
    };
  };
  /** The same wording checked again against this snapshot: pins re-derived, Outdated cleared. */
  const revalidated = (
    opIndex: number,
    text: GuidanceText | null | undefined,
    what: string,
  ): GuidanceText | undefined => {
    if (!text) {
      fail(opIndex, `${what} does not exist`);
      return undefined;
    }
    if (!text.outdated) {
      fail(opIndex, `${what} is not Outdated`);
      return undefined;
    }
    return guidanceText(opIndex, text.markdown, null);
  };

  for (const [opIndex, op] of envelope.ops.entries()) {
    if (op.type === "walkthrough.revalidate") {
      draft.overview = revalidated(opIndex, draft.overview, "the walkthrough overview") ?? null;
      continue;
    }
    if (op.type === "group.revalidate") {
      const group = groupOf(op.id);
      const overview = revalidated(
        opIndex,
        group ? group.overview : undefined,
        group ? `the overview of group ${op.id}` : `group ${op.id}`,
      );
      if (group && overview) {
        group.overview = overview;
        touch("group", op.id, opIndex);
      }
      continue;
    }
    if (op.type === "note.revalidate") {
      const found = noteOf(op.id);
      const note = found?.group.notes[found.index];
      const text = revalidated(opIndex, note, `note ${op.id}`);
      if (found && note && text) {
        found.group.notes[found.index] = { id: note.id, anchor: note.anchor, ...text };
        touch("note", op.id, opIndex);
      }
      continue;
    }
    if (op.type === "walkthrough.update") {
      if (op.overview !== undefined)
        draft.overview =
          op.overview === null ? null : guidanceText(opIndex, op.overview, draft.overview);
      if (op.groupOrder) {
        const order = op.groupOrder;
        if (
          new Set(order).size !== order.length ||
          order.length !== draft.groups.length ||
          order.some((id) => !groupOf(id))
        ) {
          fail(opIndex, "groupOrder must list every current group once");
          continue;
        }
        draft.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      }
      continue;
    }
    if (op.type === "note.create") {
      if (!op.id.trim()) {
        fail(opIndex, "note id must not be empty");
        continue;
      }
      if (noteOf(op.id)) {
        fail(opIndex, `note ${op.id} already exists`);
        continue;
      }
      const group = groupOf(op.group);
      if (!group) {
        fail(opIndex, `group ${op.group} does not exist`);
        continue;
      }
      group.notes.push({
        id: op.id,
        anchor: { snapshotId: draft.snapshotId, ...op.anchor },
        ...guidanceText(opIndex, op.markdown, null),
      });
      touch("note", op.id, opIndex);
      anchorsWritten.add(op.id);
      continue;
    }
    if (op.type === "note.update" || op.type === "note.remove") {
      const found = noteOf(op.id);
      if (!found) {
        fail(opIndex, `note ${op.id} does not exist`);
        continue;
      }
      const { group, index } = found;
      if (op.type === "note.remove") {
        group.notes.splice(index, 1);
        anchorsWritten.delete(op.id);
        continue;
      }
      const note = group.notes[index]!;
      group.notes[index] = {
        id: note.id,
        anchor: op.anchor ? { snapshotId: draft.snapshotId, ...op.anchor } : note.anchor,
        ...(op.markdown === undefined ? textOf(note) : guidanceText(opIndex, op.markdown, note)),
      };
      touch("note", op.id, opIndex);
      if (op.anchor) anchorsWritten.add(op.id);
      continue;
    }
    if (!op.id.trim()) {
      fail(opIndex, "group id must not be empty");
      continue;
    }
    if (op.type === "group.create") {
      if (groupOf(op.id) || hunkIds.has(op.id)) {
        fail(opIndex, `item id ${op.id} already exists`);
        continue;
      }
      const problem = membersProblem(op.memberHunkIds);
      if (problem) {
        fail(opIndex, problem);
        continue;
      }
      draft.groups.push({
        id: op.id,
        title: op.title,
        overview: guidanceText(opIndex, op.overview, null),
        hunkIds: [...op.memberHunkIds],
        files: op.files ? [...op.files] : filesOf(op.memberHunkIds),
        notes: [],
      });
      touch("group", op.id, opIndex);
      continue;
    }
    const group = groupOf(op.id);
    if (!group) {
      fail(opIndex, `group ${op.id} does not exist`);
      continue;
    }
    if (op.type === "group.dissolve") {
      draft.groups.splice(draft.groups.indexOf(group), 1);
      for (const { id } of group.notes) anchorsWritten.delete(id);
      continue;
    }
    if (op.memberHunkIds) {
      const problem = membersProblem(op.memberHunkIds);
      if (problem) {
        fail(opIndex, problem);
        continue;
      }
      const files = filesOf(op.memberHunkIds);
      group.files = [
        ...group.files.filter((file) => files.includes(file)),
        ...files.filter((file) => !group.files.includes(file)),
      ];
      group.hunkIds = [...op.memberHunkIds];
    }
    if (op.files) group.files = [...op.files];
    if (op.title !== undefined) group.title = op.title;
    if (op.overview !== undefined)
      group.overview =
        op.overview === null ? null : guidanceText(opIndex, op.overview, group.overview);
    touch("group", op.id, opIndex);
  }
  if (errors.length)
    return Result.fail(
      new ValidationFailed({ message: "apply validation failed", detail: errors }),
    );

  // Whole-state validation: the result must hold however the ops reached it.
  const fileOf = new Map(draft.hunks.map(({ id, file }) => [id, file]));
  const owners = new Map<string, string>();
  for (const group of draft.groups) {
    const groupOp = touchedBy("group", group.id) ?? -1;
    for (const id of group.hunkIds) {
      const other = owners.get(id);
      if (other === undefined) owners.set(id, group.id);
      else
        fail(
          Math.max(groupOp, touchedBy("group", other) ?? -1),
          `hunk ${id} is in groups ${other} and ${group.id}; a hunk may belong to only one group`,
        );
    }
    const memberFiles = new Set(group.hunkIds.map((id) => fileOf.get(id)!));
    if (
      new Set(group.files).size !== group.files.length ||
      group.files.length !== memberFiles.size ||
      group.files.some((file) => !memberFiles.has(file))
    )
      fail(groupOp, `files of group ${group.id} must list each of its members' files once`);
  }
  for (const group of draft.groups) {
    for (const note of group.notes) {
      const noteOp = touchedBy("note", note.id) ?? touchedBy("group", group.id) ?? -1;
      if (anchorsWritten.has(note.id)) {
        const problem = capturedProblem(captured, note.anchor);
        if (problem) {
          fail(noteOp, `note ${note.id}: ${problem}`);
          continue;
        }
      }
      // Outdated guidance is kept as refresh left it until the agent repairs it.
      if (note.outdated && !anchorsWritten.has(note.id)) continue;
      if (note.anchor.snapshotId !== draft.snapshotId) {
        fail(
          noteOp,
          `note ${note.id} is anchored to an earlier snapshot; re-anchor it with note.update`,
        );
        continue;
      }
      const anchored = anchoredHunkIds(draft.hunks, note.anchor);
      if (!anchored.some((id) => group.hunkIds.includes(id)))
        fail(noteOp, `note ${note.id} must cover a changed line of its group ${group.id}`);
      for (const foreign of anchored.filter((id) => !group.hunkIds.includes(id))) {
        const owner = owners.get(foreign);
        fail(
          noteOp,
          `note ${note.id} covers changed lines of hunk ${foreign}, which is ${owner === undefined ? "ungrouped" : `in group ${owner}`}, not group ${group.id}`,
        );
      }
    }
  }
  if (errors.length)
    return Result.fail(
      new ValidationFailed({ message: "apply validation failed", detail: errors }),
    );

  const unviewed = invalidatedHunkIds(session, draft, captured.earlierHunks);
  draft.viewedHunkIds = draft.viewedHunkIds.filter((id) => !unviewed.has(id));
  for (const group of draft.groups) sortNotes(draft, group);
  draft.revision++;
  draft.updatedAt = updatedAt;
  const status = statusOf(draft);
  draft.applyReceipts.push({
    key: envelope.idempotencyKey,
    digest,
    status: receiptStatusOf(draft, status),
  });
  return Result.succeed({ session: draft, status });
}
