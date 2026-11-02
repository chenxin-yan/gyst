// Reading a reference's captured target: whether this session can show it, and its lines, only
// through the `code` read of the snapshot it is pinned to. Nothing here reads live content or
// redirects a reference to another snapshot or path. No React or DOM, so each piece is unit tested.
import {
  type BrowserRequest,
  type CapturedRange,
  type CodePayload,
  type ManifestFile,
  noTextReason,
} from "@gyst/core/wire";
import { capturedText } from "./reader.ts";

export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

const available: Availability = { available: true };

/**
 * Whether the reader can show a reference's target. A target pinned to an earlier snapshot is read
 * from that snapshot, which the session keeps while guidance pins it, never from the current files;
 * its read settles whether its side holds text. `file` is the target's manifest entry when a loaded
 * files page has it; while pages are still loading, a file not seen yet is left to the read too.
 */
export function referenceAvailability(
  target: CapturedRange,
  current: { snapshotId: string; file: ManifestFile | undefined; complete: boolean },
): Availability {
  if (target.snapshotId !== current.snapshotId) return available;
  if (current.file === undefined)
    return current.complete ? { available: false, reason: "not in this snapshot" } : available;
  const side = current.file[target.side];
  return side.kind === "text"
    ? available
    : { available: false, reason: noTextReason(target.side, side) };
}

type CodeRequest = Extract<BrowserRequest, { command: "code" }>;
/** A `code` read, without the session the caller adds. */
export type CodeRead = (request: Omit<CodeRequest, "session">) => Promise<CodePayload>;

const pinnedRead = (target: CapturedRange) =>
  ({
    command: "code",
    snapshotId: target.snapshotId,
    file: target.path,
    side: target.side,
  }) as const;

/** The lines a peek previews: the target's, `context` lines either side, from `startLine`. */
export type RangeRead =
  | { readonly kind: "text"; readonly startLine: number; readonly lines: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Reads a target's lines and `context` lines around them through the `code` command of the
 * snapshot the target is pinned to, page by page until the requested end. gyst refuses an end past
 * the file's last line, so a target that close to the end is read on to the end, a few lines away.
 */
export async function readRange(
  target: CapturedRange,
  read: CodeRead,
  context = 3,
): Promise<RangeRead> {
  const startLine = Math.max(1, target.startLine - context);
  try {
    return await readLines(target, read, startLine, target.endLine + context);
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "_tag" in error) ||
      error._tag !== "bad_args"
    )
      throw error;
    return readLines(target, read, startLine, undefined);
  }
}

async function readLines(
  target: CapturedRange,
  read: CodeRead,
  startLine: number,
  endLine: number | undefined,
): Promise<RangeRead> {
  const pinned = pinnedRead(target);
  const end = endLine === undefined ? {} : { endLine };
  let text = "";
  let first: number | undefined;
  let offset: number | undefined;
  do {
    const { content } = await read(
      offset === undefined ? { ...pinned, startLine, ...end } : { ...pinned, offset, ...end },
    );
    if (content.kind !== "text")
      return { kind: "unavailable", reason: noTextReason(target.side, content) };
    first ??= content.start.line;
    text += content.text;
    offset = content.next?.offset;
  } while (offset !== undefined);
  return { kind: "text", startLine: first ?? startLine, lines: linesOf(text) };
}

/** A captured text's lines: LF ends a line, so a final LF starts no further one. */
export const linesOf = (text: string) =>
  text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

/** A target's whole captured side, read like `readRange`, for a captured file shown in full. */
export const readWholeSide = (target: CapturedRange, read: CodeRead) =>
  capturedText((offset) =>
    read(offset === undefined ? pinnedRead(target) : { ...pinnedRead(target), offset }),
  );
