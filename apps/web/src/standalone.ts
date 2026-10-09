// The standalone walkthrough: the viewer built as one offline file (`vite.export.config.ts`) whose
// reads are answered from the export embedded in it, never from a daemon or the network.
import {
  type BrowserRequest,
  type CodePayload,
  type Reply,
  StaleRevision,
  type StatusPayload,
  type SubscriptionEvent,
  ValidationFailed,
  type WalkthroughExport,
  WalkthroughExportSchema,
} from "@gyst/core/wire";
import { walkthroughSlotId } from "@gyst/core/web";
import { Schema } from "effect";

/** True in the standalone build: the reader is read-only and reads only its embedded export. */
export const standalone = import.meta.env.MODE === "export";

/** The reader's session id in a standalone file, which carries no session's identity. */
export const standaloneSession = "walkthrough";

const decodeExport = Schema.decodeUnknownSync(Schema.fromJsonString(WalkthroughExportSchema), {
  onExcessProperty: "error",
});

let embedded: WalkthroughExport | undefined;
/** The export this file carries, read and validated once. */
export function embeddedExport(): WalkthroughExport {
  embedded ??= decodeExport(document.getElementById(walkthroughSlotId)?.textContent ?? "");
  return embedded;
}

type CodeRequest = Extract<BrowserRequest, { command: "code" }>;
const lf = 10;
const encoder = new TextEncoder();

/**
 * One `code` page of `text`, as the daemon pages it but whole: from `startLine` or `offset` to the
 * end of `endLine` or the file, with byte offsets and LF-counted lines.
 */
export function codePageOf(
  text: string,
  request: Pick<CodeRequest, "startLine" | "offset" | "endLine">,
): Extract<CodePayload["content"], { kind: "text" }> {
  const bytes = encoder.encode(text);
  const lineEnd = (from: number) => {
    const at = bytes.indexOf(lf, from);
    return at === -1 ? bytes.length : at + 1;
  };
  let start = 0;
  let line = 1;
  if (request.offset !== undefined) {
    start = Math.min(request.offset, bytes.length);
    for (let at = bytes.indexOf(lf); at !== -1 && at < start; at = bytes.indexOf(lf, at + 1))
      line++;
  } else
    for (; line < (request.startLine ?? 1) && start < bytes.length; line++) start = lineEnd(start);
  let end = bytes.length;
  if (request.endLine !== undefined) {
    end = start;
    for (let at = line; at <= request.endLine && end < bytes.length; at++) end = lineEnd(end);
  }
  return {
    kind: "text",
    size: bytes.length,
    start: { line, offset: start },
    // `ignoreBOM` keeps a leading U+FEFF: it is captured content, not decoding metadata.
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, end)),
    next: null,
  };
}

const notIncluded = (what: string) =>
  new StaleRevision({ message: `This walkthrough export does not include ${what}.` });

/** What the daemon would answer `request` with, read from the export alone. */
export function answer(data: WalkthroughExport, request: BrowserRequest): Reply {
  const { walkthrough, exportedAt } = data;
  const { snapshotId } = walkthrough;
  const session = {
    id: standaloneSession,
    repoRoot: "",
    scope: walkthrough.scope,
    snapshotId,
    createdAt: exportedAt,
    updatedAt: exportedAt,
  };
  const ok = (value: unknown): Reply => ({ ok: true, value });
  switch (request.command) {
    case "open":
      return ok({ session, created: false, link: "" });
    case "status": {
      const counts = new Map<string, number>();
      for (const hunk of walkthrough.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
      const generated = new Set(
        walkthrough.files.filter((file) => file.generated).map(({ path }) => path),
      );
      return ok({
        session,
        revision: 0,
        overview: walkthrough.overview,
        groups: walkthrough.groups.map((group) => ({ ...group, count: group.hunkIds.length })),
        preparation: {
          state: "complete",
          groupedHunks: walkthrough.hunks.length,
          totalHunks: walkthrough.hunks.length,
          overviewMissing: false,
          groupsMissingOverview: [],
          overviewOutdated: false,
          groupsOutdated: [],
          notesOutdated: [],
        },
        viewedHunkIds: [],
        threads: { open: 0, resolved: 0, pending: 0 },
        files: [...counts].map(([path, hunkCount]) => ({
          path,
          hunkCount,
          viewed: false,
          ...(generated.has(path) && { generated: true as const }),
        })),
      } satisfies StatusPayload);
    }
    case "diff":
      return ok({
        sessionId: standaloneSession,
        snapshotId,
        revision: 0,
        hunks: walkthrough.hunks,
      });
    case "files":
      if (request.snapshotId !== snapshotId)
        return { ok: false, error: notIncluded("that snapshot's file list") };
      return ok({
        sessionId: standaloneSession,
        snapshotId,
        total: walkthrough.files.length,
        files: walkthrough.files,
        next: null,
      });
    case "code": {
      const side =
        request.snapshotId === snapshotId
          ? walkthrough.files.find(({ path }) => path === request.file)?.[request.side]
          : walkthrough.pinned.find(
              (pinned) =>
                pinned.snapshotId === request.snapshotId &&
                pinned.path === request.file &&
                pinned.side === request.side,
            )?.content;
      if (side === undefined)
        return { ok: false, error: notIncluded(`the ${request.side} side of ${request.file}`) };
      return ok({
        sessionId: standaloneSession,
        snapshotId: request.snapshotId,
        file: request.file,
        side: request.side,
        content: side.kind === "text" ? codePageOf(data.contents[side.blob]!, request) : side,
      } satisfies CodePayload);
    }
    case "conversations":
      return ok({
        sessionId: standaloneSession,
        snapshotId,
        revision: 0,
        version: standaloneSession,
        threads: [],
        drafts: [],
      });
    default:
      return {
        ok: false,
        error: new ValidationFailed({
          message: "A walkthrough export is read-only: it changes and checks nothing.",
        }),
      };
  }
}

/** The one `ready` a standalone reader hears; nothing it shows ever changes, so nothing follows. */
export async function* standaloneEvents(
  signal: AbortSignal,
): AsyncGenerator<SubscriptionEvent, void, undefined> {
  const { snapshotId } = embeddedExport().walkthrough;
  yield {
    kind: "ready",
    daemon: standaloneSession,
    sessionId: standaloneSession,
    snapshotId,
    revision: 0,
    conversations: standaloneSession,
  };
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
