import { parsePatchFiles } from "@pierre/diffs";
import { Schema } from "effect";

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

export const SourceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("git"), args: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("stdin") }),
);
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
  session: SessionSchema.pick("id", "repoRoot", "source", "createdAt", "updatedAt"),
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
  command: Schema.Literal("create", "status", "diff", "close"),
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  stdin: Schema.optional(Schema.String),
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
      const input = `${file.name}\0${text}`;
      let hash = 2166136261;
      for (let offset = 0; offset < input.length; offset++)
        hash = Math.imul(hash ^ input.charCodeAt(offset), 16777619);
      const id = (hash >>> 0).toString(16).padStart(8, "0");
      hunks.push({
        id,
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
      });
    }
  }
  return hunks;
}

export function statusOf(session: Session): StatusPayload {
  const counts = new Map<string, number>();
  for (const hunk of session.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
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
    groups: session.groups.map((group) => ({
      ...group,
      count: group.hunkIds.length,
      accepted: false,
    })),
    spotlight: session.hunks
      .filter(
        (hunk) =>
          !session.groups.some((group) => group.hunkIds.includes(hunk.id)) &&
          hunk.tldr !== undefined,
      )
      .map((hunk) => ({ id: hunk.id, file: hunk.file, tldr: hunk.tldr!, accepted: false })),
    inbox: session.hunks
      .filter(
        (hunk) =>
          !session.groups.some((group) => group.hunkIds.includes(hunk.id)) &&
          hunk.tldr === undefined,
      )
      .map(({ id, file }) => ({ id, file })),
    files: [...counts].map(([path, hunkCount]) => ({ path, hunkCount })),
  };
}
