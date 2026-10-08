// Semantic navigation over the session's current snapshot: definitions and usages the optional
// TS/JS add-on's engine finds for a symbol on a code line, read in a peek under that line. Here
// are its stages as plain data and the pure steps between them, so they are unit tested; the
// requests and the peek itself live in `semantic.tsx`. Navigation never reads or writes Viewed.
import type {
  BrowserRequest,
  CapturedRange,
  IdentifiersPayload,
  NavigationGap,
  NavigationLocation,
  NavigationResultPayload,
  NavigationSideState,
  NavigationUnavailable,
} from "@gyst/core/wire";
import { notCaptured } from "./captured.ts";

export type Query = NavigationResultPayload["query"];
export type CodeSide = NavigationResultPayload["side"];

/** The code line a query is asked from, on one side of a snapshot's file; its peek opens under it. */
export type LineOrigin = {
  kind: "line";
  snapshotId: string;
  side: CodeSide;
  file: string;
  line: number;
};

/** An identifier in captured text, as the engine names it. */
export type SemanticSymbol = Extract<
  IdentifiersPayload["outcome"],
  { kind: "identifiers" }
>["identifiers"][number];

/** One thing to ask of one symbol: its definition or its usages. */
export type Choice = { query: Query; symbol: SemanticSymbol };

/**
 * What a peek asks gyst, kept so Check again and Try again ask exactly that once more: the
 * identifiers on the origin line, for one query (`gd`, `gr`) or, from a right-click, for the symbol
 * under the pointer's token (UTF-16 units of the line); or one choice's answer.
 */
export type SemanticAsk =
  | { kind: "identifiers"; query: Query }
  | { kind: "identifiers"; token: { start: number; end: number } }
  | { kind: "query"; choice: Choice };

/** How far the daemon is with the queried side while an answer is awaited. */
export type Readiness = "queued" | "preparing" | "ready";

export type SemanticStage =
  /** Asked and not answered; the answer applies only while this very `ticket` waits. */
  | { kind: "waiting"; ask: SemanticAsk; ticket: number; readiness?: Readiness }
  /** Several symbols or queries to pick from, and what finding them may lack; `selected` is previewed. */
  | {
      kind: "choose";
      choices: readonly Choice[];
      selected: number;
      gaps: readonly NavigationGap[];
    }
  /** The answer: its places in captured text, how many lie outside it and what it may lack. */
  | {
      kind: "locations";
      choice: Choice;
      locations: readonly NavigationLocation[];
      outside: number;
      gaps: readonly NavigationGap[];
      selected: number;
    }
  /** Nothing to ask of, said in words, with what finding a line's symbols may lack. */
  | { kind: "none"; message: string; gaps?: readonly NavigationGap[] }
  /** Navigation can't run; `checking` is the Check again in flight, `checked` says one found nothing. */
  | {
      kind: "unavailable";
      ask: SemanticAsk;
      reason: NavigationUnavailable;
      checking?: number;
      checked?: boolean;
    }
  | { kind: "failed"; ask: SemanticAsk; message: string };

/** An open semantic peek: the line it was asked from and how far the asking got. */
export type SemanticPeek = { kind: "semantic"; origin: LineOrigin; stage: SemanticStage };

/** The browser operation that asks `ask` from `origin`. */
export function requestOf(sessionId: string, origin: LineOrigin, ask: SemanticAsk) {
  const target = {
    session: sessionId,
    snapshotId: origin.snapshotId,
    side: origin.side,
    file: origin.file,
  };
  return ask.kind === "identifiers"
    ? ({ command: "identifiers", ...target, line: origin.line } satisfies BrowserRequest)
    : ({
        command: ask.choice.query,
        ...target,
        position: ask.choice.symbol.range.start,
      } satisfies BrowserRequest);
}

const samePoint = (a: { line: number; character: number }, b: typeof a) =>
  a.line === b.line && a.character === b.character;

/**
 * Whether a reply restates exactly what was asked: its session, snapshot, side, file and line or
 * query and position. Anything else answers another question and is never shown for this one.
 */
export function answers(
  request: ReturnType<typeof requestOf>,
  reply: IdentifiersPayload | NavigationResultPayload,
) {
  if (
    reply.sessionId !== request.session ||
    reply.snapshotId !== request.snapshotId ||
    reply.side !== request.side ||
    reply.file !== request.file
  )
    return false;
  if (request.command === "identifiers") return "line" in reply && reply.line === request.line;
  return (
    "query" in reply &&
    reply.query === request.command &&
    samePoint(reply.position, request.position)
  );
}

/** What comes after an ask: a stage to show, or a query to ask at once. */
export type Next = { stage: SemanticStage } | { ask: SemanticAsk };

/**
 * The stage after a line's identifiers. `gd`/`gr` offer every identifier, asking at once when
 * there is only one; a right-click offers both queries of the identifier under its token.
 */
export function afterIdentifiers(
  ask: Extract<SemanticAsk, { kind: "identifiers" }>,
  reply: IdentifiersPayload,
): Next {
  const { outcome } = reply;
  if (outcome.kind === "unavailable")
    return { stage: { kind: "unavailable", ask, reason: outcome.reason } };
  // Only identifiers the engine resolves are offered, so a missing input can hide one.
  const { gaps } = outcome;
  if ("query" in ask) {
    const choices = outcome.identifiers.map((symbol) => ({ query: ask.query, symbol }));
    if (choices.length === 1) return { ask: { kind: "query", choice: choices[0]! } };
    return choices.length === 0
      ? { stage: { kind: "none", message: `No symbol to look up on line ${reply.line}.`, gaps } }
      : { stage: { kind: "choose", choices, selected: 0, gaps } };
  }
  const { start, end } = ask.token;
  const symbol = outcome.identifiers.find(
    ({ range }) => range.start.character < end && range.end.character > start,
  );
  return symbol === undefined
    ? { stage: { kind: "none", message: "No symbol to look up there.", gaps } }
    : {
        stage: {
          kind: "choose",
          choices: [
            { query: "definition", symbol },
            { query: "references", symbol },
          ],
          selected: 0,
          gaps,
        },
      };
}

/** The stage a definition or usages answer shows. */
export function afterQuery(choice: Choice, reply: NavigationResultPayload): SemanticStage {
  const { outcome } = reply;
  switch (outcome.kind) {
    case "locations":
      return {
        kind: "locations",
        // The engine's own name for the symbol it answered, which an alias can change.
        choice: { query: choice.query, symbol: outcome.symbol },
        locations: outcome.locations,
        outside: outcome.outside,
        gaps: outcome.gaps,
        selected: 0,
      };
    case "no-symbol":
      return { kind: "none", message: "The engine found no symbol there." };
    case "unavailable":
      return { kind: "unavailable", ask: { kind: "query", choice }, reason: outcome.reason };
  }
}

/** The waiting stage's readiness, from the queried side's state. */
export function readinessOf(side: NavigationSideState): Readiness | undefined {
  return side.kind === "queued" || side.kind === "preparing" || side.kind === "ready"
    ? side.kind
    : undefined;
}

/** A stage with its selection moved `by` rows, kept inside its list. */
export function stepped(stage: SemanticStage, by: number): SemanticStage {
  if (stage.kind !== "choose" && stage.kind !== "locations") return stage;
  const count = stage.kind === "choose" ? stage.choices.length : stage.locations.length;
  const selected = Math.max(0, Math.min(count - 1, stage.selected + by));
  return selected === stage.selected ? stage : { ...stage, selected };
}

/** A result location as the captured range a peek previews and Expand opens. */
export const targetOf = (origin: LineOrigin, location: NavigationLocation): CapturedRange => ({
  snapshotId: origin.snapshotId,
  path: location.file,
  side: origin.side,
  startLine: location.range.start.line,
  endLine: location.range.end.line,
});

/** The origin line itself as a captured range, previewed while a symbol is chosen. */
export const originTarget = (origin: LineOrigin): CapturedRange => ({
  snapshotId: origin.snapshotId,
  path: origin.file,
  side: origin.side,
  startLine: origin.line,
  endLine: origin.line,
});

/** What a choice asks, in words: `Definition of plus`, `Usages of plus`. */
export const choiceLabel = ({ query, symbol }: Choice) =>
  `${query === "definition" ? "Definition" : "Usages"} of ${symbol.text}`;

/** A known missing input, in words. */
export function gapText(gap: NavigationGap): string {
  switch (gap.kind) {
    case "dependencies":
      return `${gap.file} declares packages, and installed packages are never captured`;
    case "uncaptured":
      return `${gap.file} wasn't captured (${notCaptured[gap.reason]})`;
    case "no-project-config":
      return "no tsconfig.json or jsconfig.json, so the engine inferred the project";
    case "unresolved-import":
      return `${gap.file}: ${gap.message}`;
  }
}
