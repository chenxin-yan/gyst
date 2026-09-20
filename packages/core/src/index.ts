import { parsePatchFiles } from "@pierre/diffs";
import { Result, Schema, SchemaGetter, Struct } from "effect";

const hash = (input: string) => Bun.hash(input).toString(16).padStart(16, "0");

export const ErrorCodeSchema = Schema.Literals([
  "stale_revision",
  "validation_failed",
  "no_session",
  "session_exists",
  "daemon_unreachable",
  "bad_args",
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

export const DaemonError = Schema.Union([
  StaleRevision,
  ValidationFailed,
  NoSession,
  SessionExists,
  DaemonUnreachable,
  BadArgs,
]);
export type DaemonError = typeof DaemonError.Type;

/** Agents parse `code` on the wire; in-process the same error is a tagged class instance. */
export const ErrorPayloadSchema = Schema.Struct({ code: ErrorCodeSchema, ...errorFields }).pipe(
  Schema.decodeTo(DaemonError, {
    decode: SchemaGetter.transform(({ code, ...rest }) => ({ _tag: code, ...rest })),
    encode: SchemaGetter.transform(({ _tag, ...rest }) => ({ code: _tag, ...rest })),
  }),
);

export const HunkSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  header: Schema.String,
  patch: Schema.String,
  contentHash: Schema.String,
  tldr: Schema.optional(Schema.String),
  accepted: Schema.Boolean,
});
export type Hunk = typeof HunkSchema.Type;

export const GroupSchema = Schema.Struct({
  id: Schema.String,
  tldr: Schema.String,
  exemplarHunkId: Schema.String,
  hunkIds: Schema.Array(Schema.String),
  accepted: Schema.Boolean,
});
export type Group = typeof GroupSchema.Type;

export const SourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    args: Schema.Array(Schema.String),
    // `cwd` makes relative pathspecs in `args` replayable.
    cwd: Schema.String,
    // A bare snapshot re-resolves HEAD and re-lists untracked files on refresh.
    includeUntracked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
]);
export type Source = typeof SourceSchema.Type;

const sessionSummaryFields = {
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
const cursorSchema = Schema.Struct({
  itemId: Schema.NullOr(Schema.String),
  expanded: Schema.Boolean,
});

const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
const GroupSummarySchema = Schema.Struct({
  ...GroupSchema.fields,
  count: Schema.Number,
  accepted: Schema.Boolean,
});
const SpotlightSummarySchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  tldr: Schema.String,
  accepted: Schema.Boolean,
});
export const StatusPayloadSchema = Schema.Struct({
  session: Schema.Struct(sessionSummaryFields),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  groups: Schema.Array(GroupSummarySchema),
  spotlight: Schema.Array(SpotlightSummarySchema),
  inbox: Schema.Array(HunkSummarySchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  ready: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;

// `digest` pins the receipt to the exact batch it answered, so a reused key cannot replay another.
const ApplyReceiptSchema = Schema.Struct({
  key: Schema.String,
  digest: Schema.String,
  status: StatusPayloadSchema,
});
export const SessionSchema = Schema.Struct({
  ...sessionSummaryFields,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: cursorSchema,
  hunks: Schema.Array(HunkSchema),
  groups: Schema.Array(GroupSchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  applyReceipts: Schema.Array(ApplyReceiptSchema),
});
export type Session = typeof SessionSchema.Type;

export const GroupCreateSchema = Schema.Struct({
  type: Schema.Literal("group.create"),
  id: Schema.String,
  tldr: Schema.String,
  memberHunkIds: Schema.Array(Schema.String),
  exemplarHunkId: Schema.String,
});
export const GroupUpdateSchema = Schema.Struct({
  type: Schema.Literal("group.update"),
  id: Schema.String,
  tldr: Schema.optional(Schema.String),
  memberHunkIds: Schema.optional(Schema.Array(Schema.String)),
  exemplarHunkId: Schema.optional(Schema.String),
});
export const GroupDissolveSchema = Schema.Struct({
  type: Schema.Literal("group.dissolve"),
  id: Schema.String,
});
export const HunkAnnotateSchema = Schema.Struct({
  type: Schema.Literal("hunk.annotate"),
  hunkId: Schema.String,
  tldr: Schema.String,
});
export const QueueSetSchema = Schema.Struct({
  type: Schema.Literal("queue.set"),
  itemIds: Schema.Array(Schema.String),
});
export const ApplyOpSchema = Schema.Union([
  GroupCreateSchema,
  GroupUpdateSchema,
  GroupDissolveSchema,
  HunkAnnotateSchema,
  QueueSetSchema,
]);
export type ApplyOp = typeof ApplyOpSchema.Type;
export const ApplyEnvelopeSchema = Schema.Struct({
  revision: Schema.Number,
  idempotencyKey: Schema.String,
  ops: Schema.Array(ApplyOpSchema),
});
export type ApplyEnvelope = typeof ApplyEnvelopeSchema.Type;

export const DiffPayloadSchema = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
  hunks: Schema.Array(HunkSchema),
});
export type DiffPayload = typeof DiffPayloadSchema.Type;

export const ClosePayloadSchema = Schema.Struct({
  closed: Schema.Literal(true),
  sessionId: Schema.String,
});
export type ClosePayload = typeof ClosePayloadSchema.Type;

export const RequestSchema = Schema.Struct({
  command: Schema.Literals(["create", "status", "diff", "apply", "refresh", "close"]),
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.optional(Schema.String),
});
export type Request = typeof RequestSchema.Type;

export const ReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
]);
export type Reply = typeof ReplySchema.Type;

const invalidDiff = (detail: string) =>
  Result.fail(new BadArgs({ message: "invalid unified diff", detail }));

export function parseSnapshot(patch: string): Result.Result<Hunk[], BadArgs> {
  return Result.flatMap(
    Result.try({
      try: () => parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files),
      catch: (error) =>
        new BadArgs({
          message: "invalid unified diff",
          detail: error instanceof Error ? error.message : String(error),
        }),
    }),
    (files) => hunksOf(patch, files),
  );
}

function hunksOf(
  patch: string,
  files: ReturnType<typeof parsePatchFiles>[number]["files"],
): Result.Result<Hunk[], BadArgs> {
  if (files.length === 0 && /\S/.test(patch)) return invalidDiff("input is not a unified diff");
  const unsupported = files.find((file) => file.hunks.length === 0);
  if (unsupported)
    return invalidDiff(`file-level change without text hunks is unsupported: ${unsupported.name}`);
  const rawHunks = [
    ...patch.matchAll(/^@@[^\n]*(?:\n|$)[\s\S]*?(?=^@@|^diff --git |(?![\s\S]))/gm),
  ].map((match) => match[0].replace(/\n$/, ""));
  const parsedHunkCount = files.reduce((count, file) => count + file.hunks.length, 0);
  if (rawHunks.length !== parsedHunkCount)
    return invalidDiff("parsed hunk count does not match unified diff");
  let index = 0;
  const occurrences = new Map<string, number>();
  const hunks: Hunk[] = [];
  for (const file of files) {
    for (const parsedHunk of file.hunks) {
      const lines = rawHunks[index++]!.split("\n");
      let remainingOld = parsedHunk.deletionCount;
      let remainingNew = parsedHunk.additionCount;
      let end = 1;
      // File headers can look like hunk content; only the declared counts end a hunk.
      while (end < lines.length) {
        const sign = lines[end]![0];
        if (remainingOld === 0 && remainingNew === 0 && sign !== "\\") break;
        if (sign === "-" || sign === " ") remainingOld--;
        if (sign === "+" || sign === " ") remainingNew--;
        end++;
      }
      const text = lines.slice(0, end).join("\n");
      // The body hash matches a hunk across refreshes even when its line numbers moved; the
      // occurrence index keeps identical hunks distinct so ids stay stable and unique.
      const identity = `${file.name}\0${text}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      hunks.push({
        id: hash(`${identity}\0${occurrence}`),
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
        contentHash: hash(text.slice(text.indexOf("\n") + 1)),
        accepted: false,
      });
    }
  }
  return Result.succeed(hunks);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
type MutableGroup = Mutable<Omit<Group, "hunkIds">> & { hunkIds: string[] };
type MutableSession = Mutable<Omit<Session, "hunks" | "groups" | "queue" | "applyReceipts">> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  queue: string[];
  applyReceipts: Array<{ key: string; digest: string; status: StatusPayload }>;
};

function draftOf(session: Session): MutableSession {
  // SAFETY: structuredClone returns a detached copy, so dropping readonly cannot alias the caller's session.
  return structuredClone(session) as MutableSession;
}

function groupedIds(session: Session): Set<string> {
  return new Set(session.groups.flatMap((group) => [...group.hunkIds]));
}

export function statusOf(session: Session): StatusPayload {
  const counts = new Map<string, number>();
  for (const hunk of session.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
  const grouped = groupedIds(session);
  const spotlight = session.hunks.filter(
    (hunk) => !grouped.has(hunk.id) && hunk.tldr !== undefined,
  );
  const inbox = session.hunks.filter((hunk) => !grouped.has(hunk.id) && hunk.tldr === undefined);
  return {
    session: Struct.pick(session, ["id", "repoRoot", "source", "createdAt", "updatedAt"]),
    revision: session.revision,
    seq: session.seq,
    cursor: session.cursor,
    groups: session.groups.map((group) => ({ ...group, count: group.hunkIds.length })),
    spotlight: spotlight.map((hunk) => ({
      id: hunk.id,
      file: hunk.file,
      tldr: hunk.tldr!,
      accepted: hunk.accepted,
    })),
    inbox: inbox.map(({ id, file }) => ({ id, file })),
    queue: [...session.queue],
    queueSet: session.queueSet,
    ready: inbox.length === 0 && session.queueSet,
    files: [...counts].map(([path, hunkCount]) => ({ path, hunkCount })),
  };
}

function visibleItemIds(session: Session): string[] {
  const grouped = groupedIds(session);
  return [
    ...session.groups.map((group) => group.id),
    ...session.hunks.filter((hunk) => !grouped.has(hunk.id)).map((hunk) => hunk.id),
  ];
}

function reconcileQueue(session: MutableSession): void {
  const visible = visibleItemIds(session);
  const visibleSet = new Set(visible);
  const available = new Set(visible);
  session.queue = [
    ...session.queue.filter((id) => available.delete(id)),
    ...visible.filter((id) => available.has(id)),
  ];
  // A grouped hunk is reviewed through its group, so a verdict of its own would be unreachable.
  for (const hunk of session.hunks) if (!visibleSet.has(hunk.id)) hunk.accepted = false;
  if (session.cursor.itemId !== null && !visibleSet.has(session.cursor.itemId)) {
    session.cursor = { itemId: null, expanded: false };
  }
}

export type ValidationDetail = { opIndex: number; message: string };
/** A replayed idempotency key returns the recorded status and no session to persist. */
export type ApplyOutcome = { readonly status: StatusPayload; readonly session?: Session };

export function applyBatch(
  session: Session,
  envelope: ApplyEnvelope,
): Result.Result<ApplyOutcome, StaleRevision | ValidationFailed> {
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the batch.
  const digest = hash(JSON.stringify(envelope));
  const receipt = session.applyReceipts.find(({ key }) => key === envelope.idempotencyKey);
  if (receipt) {
    if (receipt.digest === digest) return Result.succeed({ status: receipt.status });
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
      if (!op.tldr.trim()) {
        fail(opIndex, "group tldr must not be empty");
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
      if (!op.memberHunkIds.includes(op.exemplarHunkId)) {
        fail(opIndex, "group exemplar must be a member");
        continue;
      }
      draft.groups.push({
        id: op.id,
        tldr: op.tldr,
        hunkIds: [...op.memberHunkIds],
        exemplarHunkId: op.exemplarHunkId,
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
      const exemplar = op.exemplarHunkId ?? group.exemplarHunkId;
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
      if (!members.includes(exemplar)) {
        fail(opIndex, "group exemplar must be a member");
        continue;
      }
      if (op.tldr !== undefined && !op.tldr.trim()) {
        fail(opIndex, "group tldr must not be empty");
        continue;
      }
      Object.assign(group, {
        hunkIds: [...members],
        exemplarHunkId: exemplar,
        ...(op.tldr === undefined ? {} : { tldr: op.tldr }),
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
    if (op.type === "hunk.annotate") {
      const hunk = draft.hunks.find((candidate) => candidate.id === op.hunkId);
      if (!hunk) {
        fail(opIndex, `hunk ${op.hunkId} does not exist`);
        continue;
      }
      if (!op.tldr.trim()) {
        fail(opIndex, "hunk tldr must not be empty");
        continue;
      }
      const wasInbox = hunk.tldr === undefined && !hunkInOtherGroup(hunk.id);
      // A re-worded annotation is a new claim; the verdict on the old wording no longer applies.
      if (hunk.tldr !== op.tldr) hunk.accepted = false;
      hunk.tldr = op.tldr;
      if (wasInbox) draft.queueSet = false;
      continue;
    }
    const grouped = groupedIds(draft);
    const expected = [
      ...draft.groups.map((group) => group.id),
      ...draft.hunks
        .filter((hunk) => !grouped.has(hunk.id) && hunk.tldr !== undefined)
        .map((hunk) => hunk.id),
    ];
    if (
      op.itemIds.length !== expected.length ||
      new Set(op.itemIds).size !== op.itemIds.length ||
      expected.some((id) => !op.itemIds.includes(id))
    ) {
      fail(opIndex, "queue must contain every group and spotlight hunk exactly once");
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
    fail(queueOpIndex, "queue.set must describe the batch's final groups and spotlight hunks");
  }
  if (errors.length)
    return Result.fail(
      new ValidationFailed({ message: "apply validation failed", detail: errors }),
    );
  if (!draft.queueSet) reconcileQueue(draft);
  draft.revision++;
  draft.seq++;
  draft.updatedAt = new Date().toISOString();
  const status = statusOf(draft);
  draft.applyReceipts.push({ key: envelope.idempotencyKey, digest, status });
  return Result.succeed({ session: draft, status });
}

export function refreshSession(session: Session, freshHunks: readonly Hunk[]): Session {
  const draft = draftOf(session);
  const oldByMatch = Map.groupBy(session.hunks, (hunk) => `${hunk.file}\0${hunk.contentHash}`);
  const freshMatchCounts = new Map<string, number>();
  for (const hunk of freshHunks) {
    const key = `${hunk.file}\0${hunk.contentHash}`;
    freshMatchCounts.set(key, (freshMatchCounts.get(key) ?? 0) + 1);
  }
  const freshById = new Map(freshHunks.map((hunk) => [hunk.id, hunk]));
  const stableDuplicates = new Map<string, Hunk>();
  // An exact ID is safe for duplicates only when none of its peers moved or vanished.
  for (const [key, matches] of oldByMatch) {
    if (matches.length < 2 || matches.length !== freshMatchCounts.get(key)) continue;
    if (
      matches.every((old) => {
        const fresh = freshById.get(old.id);
        return fresh?.file === old.file && fresh.patch === old.patch;
      })
    ) {
      for (const old of matches) stableDuplicates.set(old.id, old);
    }
  }
  const survivingIds = new Set<string>();
  draft.hunks = freshHunks.map((fresh) => {
    const key = `${fresh.file}\0${fresh.contentHash}`;
    const matches = oldByMatch.get(key);
    const old =
      matches?.length === 1 && freshMatchCounts.get(key) === 1
        ? matches[0]
        : stableDuplicates.get(fresh.id);
    if (!old) return { ...fresh, tldr: undefined, accepted: false };
    survivingIds.add(old.id);
    return { ...fresh, id: old.id, tldr: old.tldr, accepted: old.accepted };
  });

  draft.groups = draft.groups.flatMap((group) => {
    const hunkIds = group.hunkIds.filter((id) => survivingIds.has(id));
    if (hunkIds.length === 0) return [];
    const exemplarSurvived = hunkIds.includes(group.exemplarHunkId);
    return [
      {
        ...group,
        hunkIds,
        exemplarHunkId: exemplarSurvived ? group.exemplarHunkId : hunkIds[0]!,
        // The human judged the group through its exemplar; a different one is a new claim.
        accepted: exemplarSurvived && group.accepted,
      },
    ];
  });
  if (survivingIds.size !== freshHunks.length) draft.queueSet = false;
  reconcileQueue(draft);
  draft.revision++;
  draft.seq++;
  draft.updatedAt = new Date().toISOString();
  return draft;
}
