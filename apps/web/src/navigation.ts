// Captured-code navigation: the open peek, a followed reference or a semantic query, and the
// places Back returns to after Expand. Navigation never reads or writes Viewed. No React or DOM
// here, so the stack is unit tested.
import type { CapturedRange } from "@gyst/core/wire";
import type { CodeViewLineSelection } from "@pierre/diffs";
import type { Cursor, Side } from "./cursor.ts";
import type { SemanticPeek } from "./semantic.ts";
import type { ReviewView } from "./walkthrough.ts";

/**
 * Where a reference was followed from: under a note or in a thread in the diff, or in the shown
 * overview.
 */
export type PeekOrigin =
  | { kind: "note"; noteId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "overview" };

/** An open reference peek: its pinned target and where it opened. */
export type ReferencePeek = { kind: "reference"; target: CapturedRange; origin: PeekOrigin };

/** The open peek: a followed reference, or a semantic query under the code line it was asked on. */
export type Peek = ReferencePeek | SemanticPeek;

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
  /** The files folded there; an expanded file starts unfolded and folds on its own. */
  folded: ReadonlySet<string>;
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

/**
 * A peek as it can be shown again after the reader was away: a semantic answer that can no longer
 * arrive is dropped, and a Check again in flight forgotten.
 */
export function resumable(peek: Peek | undefined): Peek | undefined {
  if (peek?.kind !== "semantic") return peek;
  const { stage } = peek;
  if (stage.kind === "waiting") return undefined;
  if (stage.kind !== "unavailable" || stage.checking === undefined) return peek;
  return { ...peek, stage: { kind: "unavailable", ask: stage.ask, reason: stage.reason } };
}

/** The places Back returns to, the latest last. */
export type BackStack = readonly Place[];

export const pushed = (stack: BackStack, place: Place): BackStack => [...stack, place];

/** The place Back returns to and the stack after it, or undefined when there is nowhere to go. */
export const popped = (stack: BackStack) =>
  stack.length === 0 ? undefined : { place: stack.at(-1)!, stack: stack.slice(0, -1) };
