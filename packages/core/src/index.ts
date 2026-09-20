import { parsePatchFiles } from "@pierre/diffs";
import { Result, Schema, SchemaGetter, Struct } from "effect";

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
  tldr: Schema.optional(Schema.String),
});
export type Hunk = typeof HunkSchema.Type;

export const GroupSchema = Schema.Struct({
  id: Schema.String,
  tldr: Schema.String,
  exemplarHunkId: Schema.String,
  hunkIds: Schema.Array(Schema.String),
});
export type Group = typeof GroupSchema.Type;

export const SourceSchema = Schema.Union([
  // `cwd` makes relative pathspecs in `args` replayable.
  Schema.Struct({
    kind: Schema.Literal("git"),
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
]);
export type Source = typeof SourceSchema.Type;

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  repoRoot: Schema.String,
  source: SourceSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  hunks: Schema.Array(HunkSchema),
  groups: Schema.Array(GroupSchema),
});
export type Session = typeof SessionSchema.Type;

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
  session: SessionSchema.mapFields(
    Struct.pick(["id", "repoRoot", "source", "createdAt", "updatedAt"]),
  ),
  revision: Schema.Number,
  seq: Schema.Number,
  cursor: Schema.Struct({ itemId: Schema.NullOr(Schema.String), expanded: Schema.Boolean }),
  groups: Schema.Array(GroupSummarySchema),
  spotlight: Schema.Array(SpotlightSummarySchema),
  inbox: Schema.Array(HunkSummarySchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String, hunkCount: Schema.Number })),
});
export type StatusPayload = typeof StatusPayloadSchema.Type;

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
  command: Schema.Literals(["create", "status", "diff", "close"]),
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
  const hunks: Hunk[] = [];
  const ids = new Set<string>();
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
      const digest = Bun.hash(`${file.name}\0${text}`).toString(16).padStart(16, "0");
      // Ids are the agent's handles; a collision must not make two hunks one.
      let id = digest;
      for (let n = 2; ids.has(id); n++) id = `${digest}-${n}`;
      ids.add(id);
      hunks.push({
        id,
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
      });
    }
  }
  return Result.succeed(hunks);
}

export function statusOf(session: Session): StatusPayload {
  const counts = new Map<string, number>();
  for (const hunk of session.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
  const grouped = new Set(session.groups.flatMap((group) => group.hunkIds));
  return {
    session: Struct.pick(session, ["id", "repoRoot", "source", "createdAt", "updatedAt"]),
    revision: session.revision,
    seq: session.seq,
    cursor: session.cursor,
    groups: session.groups.map((group) => ({
      ...group,
      count: group.hunkIds.length,
      accepted: false,
    })),
    spotlight: session.hunks
      .filter((hunk) => !grouped.has(hunk.id) && hunk.tldr !== undefined)
      .map((hunk) => ({ id: hunk.id, file: hunk.file, tldr: hunk.tldr!, accepted: false })),
    inbox: session.hunks
      .filter((hunk) => !grouped.has(hunk.id) && hunk.tldr === undefined)
      .map(({ id, file }) => ({ id, file })),
    files: [...counts].map(([path, hunkCount]) => ({ path, hunkCount })),
  };
}
