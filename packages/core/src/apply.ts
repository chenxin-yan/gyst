import { Result, Schema } from "effect";
import { draftOf, type MutableSession, reconcileQueue } from "./draft.ts";
import { StaleRevision, ValidationFailed } from "./errors.ts";
import { hash } from "./hash.ts";
import { metadataFields, MetadataSchema, NotesSchema, TitleSchema } from "./metadata.ts";
import type { ReceiptStatus, Session, StatusPayload } from "./session.ts";
import { statusOf } from "./status.ts";

export const GroupCreateSchema = Schema.Struct({
  type: Schema.Literal("group.create"),
  id: Schema.String,
  ...metadataFields,
  memberHunkIds: Schema.Array(Schema.String),
});
export const GroupUpdateSchema = Schema.Struct({
  type: Schema.Literal("group.update"),
  id: Schema.String,
  title: Schema.optional(TitleSchema),
  notes: Schema.optional(NotesSchema),
  memberHunkIds: Schema.optional(Schema.Array(Schema.String)),
});
export const GroupDissolveSchema = Schema.Struct({
  type: Schema.Literal("group.dissolve"),
  id: Schema.String,
});
export const QueueSetSchema = Schema.Struct({
  type: Schema.Literal("queue.set"),
  itemIds: Schema.Array(Schema.String),
});
export const ApplyOpSchema = Schema.Union([
  GroupCreateSchema,
  GroupUpdateSchema,
  GroupDissolveSchema,
  QueueSetSchema,
]);
export type ApplyOp = typeof ApplyOpSchema.Type;
export const ApplyEnvelopeSchema = Schema.Struct({
  revision: Schema.Number,
  idempotencyKey: Schema.String,
  ops: Schema.Array(ApplyOpSchema),
});
export type ApplyEnvelope = typeof ApplyEnvelopeSchema.Type;
export type ValidationDetail = { opIndex: number; message: string };
/** A replayed idempotency key returns the recorded status and no session to persist. */
export type ApplyOutcome = { readonly status: StatusPayload; readonly session?: Session };

// Receipts intern note text while preserving exact historical anchors and status.
function receiptStatusOf(draft: MutableSession, status: StatusPayload): ReceiptStatus {
  // ponytail: linear indexOf over distinct texts; a hash index if a session publishes thousands.
  const intern = (text: string) => {
    const index = draft.receiptNoteTexts.indexOf(text);
    return index >= 0 ? index : draft.receiptNoteTexts.push(text) - 1;
  };
  return {
    ...status,
    groups: status.groups.map((group) => ({
      ...group,
      notes: group.notes.map((note) => ({ ...note, text: intern(note.text) })),
    })),
  };
}
function recordedStatusOf(session: Session, status: ReceiptStatus): StatusPayload {
  const text = (index: number) => session.receiptNoteTexts[index]!;
  return {
    ...status,
    groups: status.groups.map((group) => ({
      ...group,
      notes: group.notes.map((note) => ({ ...note, text: text(note.text) })),
    })),
  };
}

const validAnchors = (notes: typeof NotesSchema.Type, members: readonly string[]) =>
  new Set(notes.map(({ hunkId }) => hunkId)).size === notes.length &&
  notes.every(({ hunkId }) => members.includes(hunkId));

export function applyBatch(
  session: Session,
  envelope: ApplyEnvelope,
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
  if (envelope.revision !== session.revision)
    return Result.fail(
      new StaleRevision({
        message: "apply revision is stale",
        detail: [
          {
            opIndex: -1,
            message: `stale revision ${envelope.revision}; current revision is ${session.revision}`,
          },
        ] satisfies ValidationDetail[],
      }),
    );

  const draft = draftOf(session);
  const errors: ValidationDetail[] = [];
  const fail = (opIndex: number, message: string) => errors.push({ opIndex, message });
  const hunkExists = (id: string) => draft.hunks.some((hunk) => hunk.id === id);
  const hunkInOtherGroup = (id: string, ownId?: string) =>
    draft.groups.some((group) => group.id !== ownId && group.hunkIds.includes(id));

  for (const [opIndex, op] of envelope.ops.entries()) {
    if (op.type === "group.create") {
      if (!op.id.trim()) {
        fail(opIndex, "group id must not be empty");
        continue;
      }
      if (draft.groups.some((group) => group.id === op.id) || hunkExists(op.id)) {
        fail(opIndex, `item id ${op.id} already exists`);
        continue;
      }
      if (!Schema.is(MetadataSchema)(op) || !validAnchors(op.notes, op.memberHunkIds)) {
        fail(opIndex, "invalid group title, notes or anchors");
        continue;
      }
      if (
        op.memberHunkIds.length === 0 ||
        new Set(op.memberHunkIds).size !== op.memberHunkIds.length
      ) {
        fail(opIndex, "group members must be non-empty and unique");
        continue;
      }
      if (op.memberHunkIds.some((id) => !hunkExists(id))) {
        fail(opIndex, "group member does not exist");
        continue;
      }
      if (op.memberHunkIds.some((id) => hunkInOtherGroup(id))) {
        fail(opIndex, "a hunk may belong to only one group");
        continue;
      }
      draft.groups.push({
        id: op.id,
        title: op.title,
        notes: op.notes.map((note) => ({ ...note })),
        hunkIds: [...op.memberHunkIds],
        accepted: false,
      });
      draft.queueSet = false;
      reconcileQueue(draft);
      continue;
    }
    if (op.type === "group.update") {
      if (!op.id.trim()) {
        fail(opIndex, "group id must not be empty");
        continue;
      }
      const group = draft.groups.find((candidate) => candidate.id === op.id);
      if (!group) {
        fail(opIndex, `group ${op.id} does not exist`);
        continue;
      }
      const members = op.memberHunkIds ?? group.hunkIds;
      if (members.length === 0 || new Set(members).size !== members.length) {
        fail(opIndex, "group members must be non-empty and unique");
        continue;
      }
      if (members.some((id) => !hunkExists(id))) {
        fail(opIndex, "group member does not exist");
        continue;
      }
      if (members.some((id) => hunkInOtherGroup(id, group.id))) {
        fail(opIndex, "a hunk may belong to only one group");
        continue;
      }
      const title = op.title ?? group.title;
      const notes = op.notes ?? group.notes;
      if (!Schema.is(MetadataSchema)({ title, notes }) || !validAnchors(notes, members)) {
        fail(opIndex, "invalid group title, notes or anchors");
        continue;
      }
      Object.assign(group, {
        hunkIds: [...members],
        title,
        notes: notes.map((note) => ({ ...note })),
        accepted: false,
      });
      draft.queueSet = false;
      reconcileQueue(draft);
      continue;
    }
    if (op.type === "group.dissolve") {
      const index = draft.groups.findIndex((group) => group.id === op.id);
      if (index < 0) {
        fail(opIndex, `group ${op.id} does not exist`);
        continue;
      }
      draft.groups.splice(index, 1);
      draft.queueSet = false;
      reconcileQueue(draft);
      continue;
    }
    const expected = draft.groups.map((group) => group.id);
    if (
      op.itemIds.length !== expected.length ||
      new Set(op.itemIds).size !== op.itemIds.length ||
      expected.some((id) => !op.itemIds.includes(id))
    ) {
      fail(opIndex, "queue must contain every group exactly once");
      continue;
    }
    draft.queue = [...op.itemIds];
    draft.queueSet = true;
  }

  const queueOpIndex = envelope.ops.findLastIndex((op) => op.type === "queue.set");
  if (
    queueOpIndex >= 0 &&
    !draft.queueSet &&
    !errors.some(({ opIndex }) => opIndex === queueOpIndex)
  ) {
    fail(queueOpIndex, "queue.set must describe the batch's final groups");
  }
  if (!errors.length && !draft.queueSet && envelope.ops.some((op) => op.type !== "queue.set"))
    fail(envelope.ops.length - 1, "group changes require a complete queue.set");
  if (errors.length)
    return Result.fail(
      new ValidationFailed({ message: "apply validation failed", detail: errors }),
    );
  if (!draft.queueSet) reconcileQueue(draft);
  draft.revision++;
  draft.seq++;
  draft.updatedAt = updatedAt;
  const status = statusOf(draft);
  draft.applyReceipts.push({
    key: envelope.idempotencyKey,
    digest,
    status: receiptStatusOf(draft, status),
  });
  return Result.succeed({ session: draft, status });
}
