import { parsePatchFiles } from "@pierre/diffs";
import { Schema } from "effect";

// Require only Bun's pure hash and structuredClone, without exposing ambient I/O APIs.
declare const Bun: { hash(input: string): number | bigint };
declare function structuredClone<T>(value: T): T;

export const ErrorCodeSchema = Schema.Literal(
  "stale_revision",
  "validation_failed",
  "no_session",
  "session_exists",
  "daemon_unreachable",
  "bad_args",
);
export type ErrorCode = typeof ErrorCodeSchema.Type;

export const ErrorPayloadSchema = Schema.Struct({
  code: ErrorCodeSchema,
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),
});
export type ErrorPayload = typeof ErrorPayloadSchema.Type;

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

export const SourceSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("git"),
    args: Schema.Array(Schema.String),
    includeUntracked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
);
export type Source = typeof SourceSchema.Type;

const SessionSummaryFields = {
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};
const HunkSummarySchema = Schema.Struct({ id: Schema.String, file: Schema.String });
const GroupSummarySchema = Schema.Struct({
  id: Schema.String,
  tldr: Schema.String,
  exemplarHunkId: Schema.String,
  hunkIds: Schema.Array(Schema.String),
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
  session: Schema.Struct(SessionSummaryFields),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  groups: Schema.Array(GroupSummarySchema),
  spotlight: Schema.Array(SpotlightSummarySchema),
  inbox: Schema.Array(HunkSummarySchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  ready: Schema.Boolean,
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;

const ApplyReceiptSchema = Schema.Struct({ key: Schema.String, status: StatusPayloadSchema });
export const SessionSchema = Schema.Struct({
  ...SessionSummaryFields,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  hunks: Schema.Array(HunkSchema),
  groups: Schema.Array(GroupSchema),
  queue: Schema.Array(Schema.String),
  queueSet: Schema.Boolean,
  acceptHistory: Schema.Array(Schema.String),
  applyReceipts: Schema.Array(ApplyReceiptSchema),
});
export type Session = typeof SessionSchema.Type;

/** On-disk session shape, including fields older daemons did not persist. */
export const PersistedSessionSchema = Schema.Struct({
  ...SessionSchema.fields,
  hunks: Schema.Array(
    Schema.Struct({
      ...HunkSchema.fields,
      contentHash: Schema.optional(Schema.String),
      accepted: Schema.optional(Schema.Boolean),
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({ ...GroupSchema.fields, accepted: Schema.optional(Schema.Boolean) }),
  ),
  queue: Schema.optional(Schema.Array(Schema.String)),
  queueSet: Schema.optional(Schema.Boolean),
  acceptHistory: Schema.optional(Schema.Array(Schema.String)),
  applyReceipts: Schema.optional(Schema.Array(ApplyReceiptSchema)),
});
export type PersistedSession = typeof PersistedSessionSchema.Type;

export function migratePersistedSession(persisted: PersistedSession): Session {
  return {
    ...persisted,
    hunks: persisted.hunks.map((hunk) => ({
      ...hunk,
      contentHash: hunk.contentHash ?? hash(hunk.patch.slice(hunk.patch.indexOf("\n") + 1)),
      accepted: hunk.accepted ?? false,
    })),
    groups: persisted.groups.map((group) => ({ ...group, accepted: group.accepted ?? false })),
    queue: persisted.queue ?? [],
    queueSet: persisted.queueSet ?? false,
    acceptHistory: persisted.acceptHistory ?? [],
    applyReceipts: persisted.applyReceipts ?? [],
  };
}

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
export const ApplyOpSchema = Schema.Union(
  GroupCreateSchema,
  GroupUpdateSchema,
  GroupDissolveSchema,
  HunkAnnotateSchema,
  QueueSetSchema,
);
export type ApplyOp = typeof ApplyOpSchema.Type;
export const ApplyEnvelopeSchema = Schema.Struct({
  revision: Schema.Number,
  idempotencyKey: Schema.String,
  ops: Schema.Array(ApplyOpSchema),
});
export type ApplyEnvelope = typeof ApplyEnvelopeSchema.Type;

export const HumanActionSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("cursor.move"), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("expand.toggle") }),
  Schema.Struct({ type: Schema.Literal("verdict.toggle"), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("verdict.undo") }),
);
export type HumanAction = typeof HumanActionSchema.Type;

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
  command: Schema.Literal("create", "status", "diff", "apply", "refresh", "close", "tui.action"),
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.optional(Schema.String),
  action: Schema.optional(HumanActionSchema),
});
export type Request = typeof RequestSchema.Type;

export const ReplySchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ErrorPayloadSchema }),
);
export type Reply = typeof ReplySchema.Type;

function hash(input: string): string {
  return Bun.hash(input).toString(16).padStart(16, "0");
}

export function parseSnapshot(patch: string): Hunk[] {
  const files = parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files);
  const unsupported = files.find((file) => file.hunks.length === 0);
  if (unsupported)
    throw new Error(`file-level change without text hunks is unsupported: ${unsupported.name}`);
  const rawHunks = [
    ...patch.matchAll(/^@@[^\n]*(?:\n|$)[\s\S]*?(?=^@@|^diff --git |(?![\s\S]))/gm),
  ].map((match) => match[0].replace(/\n$/, ""));
  const parsedHunkCount = files.reduce((count, file) => count + file.hunks.length, 0);
  if (rawHunks.length !== parsedHunkCount)
    throw new Error("parsed hunk count does not match unified diff");
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
      const body = text.slice(text.indexOf("\n") + 1);
      const contentHash = hash(body);
      const identity = `${file.name}\0${text}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      hunks.push({
        id: hash(`${identity}\0${occurrence}`),
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
        contentHash,
        accepted: false,
      });
    }
  }
  return hunks;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
type MutableGroup = Mutable<Omit<Group, "hunkIds">> & { hunkIds: string[] };
type MutableSession = Mutable<
  Omit<Session, "hunks" | "groups" | "queue" | "acceptHistory" | "applyReceipts">
> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  queue: string[];
  acceptHistory: string[];
  applyReceipts: Array<{ key: string; status: StatusPayload }>;
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
    session: {
      id: session.id,
      repoRoot: session.repoRoot,
      source: session.source,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
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
  const acceptedIds = new Set([
    ...session.groups.filter(({ accepted }) => accepted).map(({ id }) => id),
    ...session.hunks
      .filter(({ accepted, tldr, id }) => accepted && tldr !== undefined && visibleSet.has(id))
      .map(({ id }) => id),
  ]);
  session.acceptHistory = session.acceptHistory.filter((id) => acceptedIds.has(id));
  if (session.cursor.itemId !== null && !visibleSet.has(session.cursor.itemId)) {
    session.cursor = { itemId: null, expanded: false };
  }
}

export type ValidationDetail = { opIndex: number; message: string };
export type ApplyResult = {
  session?: Session;
  status?: StatusPayload;
  errorCode?: "stale_revision" | "validation_failed";
  errors?: ValidationDetail[];
};

export function applyBatch(session: Session, envelope: ApplyEnvelope): ApplyResult {
  const receipt = session.applyReceipts.find(({ key }) => key === envelope.idempotencyKey);
  if (receipt) return { status: receipt.status };
  if (envelope.revision !== session.revision)
    return {
      errorCode: "stale_revision",
      errors: [
        {
          opIndex: -1,
          message: `stale revision ${envelope.revision}; current revision is ${session.revision}`,
        },
      ],
    };

  const draft = draftOf(session);
  const errors: ValidationDetail[] = [];
  const fail = (opIndex: number, message: string) => errors.push({ opIndex, message });
  const hunkExists = (id: string) => draft.hunks.some((hunk) => hunk.id === id);
  const hunkInOtherGroup = (id: string, ownId?: string) =>
    draft.groups.some((group) => group.id !== ownId && group.hunkIds.includes(id));

  for (const [opIndex, op] of envelope.ops.entries()) {
    if (op.type === "group.create") {
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
  if (errors.length) return { errorCode: "validation_failed", errors };
  if (!draft.queueSet) reconcileQueue(draft);
  draft.revision++;
  draft.seq++;
  draft.updatedAt = new Date().toISOString();
  const status = statusOf(draft);
  draft.applyReceipts.push({ key: envelope.idempotencyKey, status });
  return { session: draft, status };
}

export function applyHumanAction(session: Session, action: HumanAction): Session | undefined {
  const draft = draftOf(session);
  const visibleIds = new Set(visibleItemIds(session));

  if (action.type === "cursor.move") {
    if (!visibleIds.has(action.itemId)) return;
    draft.cursor = { itemId: action.itemId, expanded: false };
    draft.seq++;
  } else if (action.type === "expand.toggle") {
    if (!session.cursor.itemId || !session.groups.some(({ id }) => id === session.cursor.itemId))
      return;
    draft.cursor = { ...draft.cursor, expanded: !draft.cursor.expanded };
    draft.seq++;
  } else {
    const itemId = action.type === "verdict.undo" ? draft.acceptHistory.at(-1) : action.itemId;
    if (!itemId) return;
    const group = draft.groups.find(({ id }) => id === itemId);
    const grouped = groupedIds(draft);
    const hunk = draft.hunks.find(
      ({ id, tldr }) => id === itemId && tldr !== undefined && !grouped.has(id),
    );
    const item = group ?? hunk;
    if (!item || (action.type === "verdict.undo" && !item.accepted)) return;
    if (action.type === "verdict.undo") {
      item.accepted = false;
      draft.acceptHistory.pop();
      draft.cursor = { itemId, expanded: false };
    } else {
      item.accepted = !item.accepted;
      draft.acceptHistory = draft.acceptHistory.filter((id) => id !== itemId);
      if (item.accepted) draft.acceptHistory.push(itemId);
    }
    draft.revision++;
    draft.seq++;
  }

  draft.updatedAt = new Date().toISOString();
  return draft;
}

export function refreshSession(session: Session, freshHunks: readonly Hunk[]): Session {
  const draft = draftOf(session);
  const oldByMatch = new Map<string, Hunk[]>();
  const freshMatchCounts = new Map<string, number>();
  for (const hunk of session.hunks) {
    const key = `${hunk.file}\0${hunk.contentHash}`;
    const matches = oldByMatch.get(key) ?? [];
    matches.push(hunk);
    oldByMatch.set(key, matches);
  }
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
    return [
      {
        ...group,
        hunkIds,
        exemplarHunkId: hunkIds.includes(group.exemplarHunkId) ? group.exemplarHunkId : hunkIds[0]!,
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
