// Reading a reference's captured target: whether this session can show it, and its lines, only
// through the `code` read of the snapshot it is pinned to. Nothing here reads live content or
// redirects a reference to another snapshot or path. No React or DOM, so each piece is unit tested.
import type {
  BrowserRequest,
  CapturedRange,
  CodePayload,
  ContentSide,
  ManifestFile,
} from "@gyst/core/wire";
import { capturedText } from "./reader.ts";

/** Why a side has no captured text, short enough for a file header bar. */
export const notCaptured = {
  binary: "binary",
  "unsupported-encoding": "not UTF-8 text",
  symlink: "symbolic link",
  submodule: "submodule",
} satisfies Record<Extract<ContentSide, { kind: "unavailable" }>["reason"], string>;

export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

const available: Availability = { available: true };

type NoText = Exclude<ContentSide, { kind: "text" }>;

/** Why one side of a captured file holds no text. */
const whyNoText = (side: CapturedRange["side"], content: NoText) =>
  content.kind === "absent"
    ? `absent on the ${side} side`
    : `${side} side not captured: ${notCaptured[content.reason]}`;

/**
 * Whether the reader can show a reference's target. Only the current snapshot is readable (older
 * ones are not kept yet, #93), so a target pinned to another one is unavailable rather than read
 * from the current files. `file` is the target's manifest entry when a loaded files page has it;
 * while pages are still loading, a file not seen yet is left to the read to settle.
 */
export function referenceAvailability(
  target: CapturedRange,
  current: { snapshotId: string; file: ManifestFile | undefined; complete: boolean },
): Availability {
  if (target.snapshotId !== current.snapshotId)
    return {
      available: false,
      reason: "captured in an earlier snapshot this session no longer keeps",
    };
  if (current.file === undefined)
    return current.complete ? { available: false, reason: "not in this snapshot" } : available;
  const side = current.file[target.side];
  return side.kind === "text"
    ? available
    : { available: false, reason: whyNoText(target.side, side) };
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
 * snapshot the target is pinned to, page by page until the requested end.
 */
export async function readRange(
  target: CapturedRange,
  read: CodeRead,
  context = 3,
): Promise<RangeRead> {
  const pinned = pinnedRead(target);
  const startLine = Math.max(1, target.startLine - context);
  const endLine = target.endLine + context;
  let text = "";
  let first: number | undefined;
  let offset: number | undefined;
  do {
    const { content } = await read(
      offset === undefined ? { ...pinned, startLine, endLine } : { ...pinned, offset, endLine },
    );
    if (content.kind !== "text")
      return { kind: "unavailable", reason: whyNoText(target.side, content) };
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
