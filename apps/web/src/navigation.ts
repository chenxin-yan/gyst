// Captured-code navigation: the open reference peek, and the places Back returns to after Expand.
// Navigation never reads or writes Viewed. No React or DOM here, so the stack is unit tested.
import type { CapturedRange } from "@gyst/core/wire";
import type { CodeViewLineSelection } from "@pierre/diffs";
import type { Cursor, Side } from "./cursor.ts";
import type { ReviewView } from "./walkthrough.ts";

/** Where a reference was followed from: under a note in the diff, or in the shown overview. */
export type PeekOrigin = { kind: "note"; noteId: string } | { kind: "overview" };

/** An open reference peek: its pinned target and where it opened. */
export type Peek = { target: CapturedRange; origin: PeekOrigin };

/** Where the reader is: a file and, inside its diff, the side and line at the top of the panel. */
export type ReadingPosition = { file: string; side: Side | undefined; line: number | undefined };

/**
 * What a restored panel scrolls to: a logical reading position, which survives reflow, or for an
 * overview, which sits above every file, the panel's pixel offset.
 */
export type Restore = { position: ReadingPosition } | { scrollTop: number };

/** One place Back returns to: the view, an expanded target in it, the reader's place and its peek. */
export type Place = {
  review: ReviewView;
  /** The captured target the main panel had expanded, if any. */
  captured: CapturedRange | undefined;
  /** The cursor, whose side is the split column it walked. */
  cursor: Cursor | undefined;
  lines: CodeViewLineSelection | null;
  restore: Restore;
  peek: Peek | undefined;
};

/** How to scroll back to a place left from `peek`: an overview's offset, or the reading position. */
export function restoreFor(
  peek: Peek | undefined,
  at: { position: ReadingPosition | undefined; scrollTop: number },
): Restore {
  return peek?.origin.kind === "overview" || at.position === undefined
    ? { scrollTop: at.scrollTop }
    : { position: at.position };
}

/** The places Back returns to, the latest last. */
export type BackStack = readonly Place[];

export const pushed = (stack: BackStack, place: Place): BackStack => [...stack, place];

/** The place Back returns to and the stack after it, or undefined when there is nowhere to go. */
export const popped = (stack: BackStack) =>
  stack.length === 0 ? undefined : { place: stack.at(-1)!, stack: stack.slice(0, -1) };
