import {
  type CapturedRange,
  type CodeRange,
  diagramProblems,
  isWebUrl,
  parseReferenceHref,
} from "@gyst/core/wire";
import type { MermaidConfig } from "mermaid";

/** What a Markdown link may do: open an `http(s)` page, follow a pinned reference, or nothing. */
export type RichLink =
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "reference"; readonly target: CapturedRange }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "inert" };

/** react-markdown's `urlTransform`: every other URL becomes empty, so it renders inert. */
export const safeUrl = (url: string) => (url.startsWith("gyst:") || isWebUrl(url) ? url : "");

const sameRange = (a: CodeRange, b: CodeRange) =>
  a.path === b.path && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine;

/**
 * A `gyst:` link follows only the target its text pinned when it was published; one the entry
 * check never validated is unavailable rather than read from whatever snapshot is current.
 */
export function linkOf(href: string | undefined, references: readonly CapturedRange[]): RichLink {
  if (!href) return { kind: "inert" };
  if (href.startsWith("gyst:")) {
    const range = parseReferenceHref(href);
    const target = range && references.find((pinned) => sameRange(pinned, range));
    return target
      ? { kind: "reference", target }
      : { kind: "unavailable", reason: "not a validated reference" };
  }
  return isWebUrl(href) ? { kind: "external", href } : { kind: "inert" };
}

/** `L40–52 · new` */
export const rangeLabel = (range: CodeRange) =>
  `L${range.startLine}${range.endLine > range.startLine ? `–${range.endLine}` : ""} · ${range.side}`;

/** `src/a.ts:L40–52 · new` */
export const referenceLabel = (range: CodeRange) => `${range.path}:${rangeLabel(range)}`;

// Mermaid reads frontmatter only at the very start, but a removed directive can expose one there.
const frontmatter = /^\s*---[^\n]*\n(?:[\s\S]*?\n)?[^\S\n]*---[^\S\n]*(?:\n|$)/;
// An unclosed directive runs to the end of the text, as Mermaid's own directive pattern does.
const directive = /%%\s*\{[\s\S]*?(?:\}\s*%%|$)/g;

/**
 * Removes all author configuration from a diagram: leading `---` frontmatter and every `%%{…}%%`
 * directive, repeated until none is left, because removing one can join its neighbours into another.
 * A diagram with shape data or author styling is refused, never handed to Mermaid.
 */
export function mermaidSource(text: string): { source: string } | { error: string } {
  let source = text.replace(/\r\n?/g, "\n");
  for (let previous = ""; previous !== source;) {
    previous = source;
    if (/^\s*---/.test(source)) {
      const match = frontmatter.exec(source);
      if (!match) return { error: "The diagram starts with unclosed frontmatter." };
      source = source.slice(match[0].length);
    }
    source = source.replace(directive, "");
  }
  source = source.trimStart();
  if (!source.trimEnd()) return { error: "The diagram is empty." };
  const [problem] = diagramProblems(source);
  return problem ? { error: `${problem}.` } : { source };
}

/** The app palette a diagram is drawn in, read from the app's CSS custom properties. */
export type DiagramColors = {
  readonly background: string;
  readonly surface: string;
  readonly line: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  readonly font: string;
};

/**
 * Strict and app-themed. `secure` keeps these keys out of reach of any per-diagram override
 * Mermaid would otherwise accept, as a second line behind `mermaidSource`.
 */
export const mermaidConfig = (colors: DiagramColors): MermaidConfig => ({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  suppressErrorRendering: true,
  maxTextSize: 20_000,
  maxEdges: 500,
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "suppressErrorRendering",
    "maxEdges",
    "htmlLabels",
    "dompurifyConfig",
    "theme",
    "themeCSS",
    "themeVariables",
    "fontFamily",
  ],
  theme: "base",
  fontFamily: colors.font,
  themeVariables: {
    darkMode: true,
    fontFamily: colors.font,
    background: colors.background,
    textColor: colors.ink,
    titleColor: colors.ink,
    primaryColor: colors.surface,
    primaryTextColor: colors.ink,
    primaryBorderColor: colors.accent,
    secondaryColor: colors.background,
    tertiaryColor: colors.background,
    mainBkg: colors.surface,
    nodeBorder: colors.accent,
    lineColor: colors.muted,
    clusterBkg: colors.background,
    clusterBorder: colors.line,
    edgeLabelBackground: colors.background,
    noteBkgColor: colors.surface,
    noteTextColor: colors.ink,
    noteBorderColor: colors.line,
  },
});

/** The part of the `mermaid` module the queue drives. */
export type DiagramEngine = {
  initialize(config: MermaidConfig): void;
  render(id: string, text: string): Promise<{ readonly svg: string }>;
};

export type DiagramOutcome = { readonly svg: string } | { readonly error: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Renders diagrams one at a time, because Mermaid keeps its configuration and scratch DOM global.
 * `load` runs on the first request only; a failed load fails every request waiting on it, and the
 * next request tries again. Outcomes are cached per palette and source. A `slot` is one place a
 * diagram is shown: only its latest request is delivered, and none after `release`.
 */
export function createDiagramQueue(load: () => Promise<DiagramEngine>) {
  let engine: Promise<DiagramEngine> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let configured: string | undefined;
  let renders = 0;
  const outcomes = new Map<string, Promise<DiagramOutcome>>();
  const latest = new WeakMap<object, symbol>();

  const loaded = () => {
    if (engine) return engine;
    const loading = load();
    engine = loading;
    loading.catch(() => {
      if (engine === loading) engine = undefined;
    });
    return loading;
  };

  const enqueue = (source: string, colors: DiagramColors, colorsKey: string, key: string) => {
    const loading = loaded();
    const outcome = tail.then(async (): Promise<DiagramOutcome> => {
      let mermaid: DiagramEngine;
      try {
        mermaid = await loading;
      } catch (error) {
        outcomes.delete(key);
        return { error: `Mermaid could not load: ${messageOf(error)}` };
      }
      try {
        if (configured !== colorsKey) {
          configured = undefined;
          mermaid.initialize(mermaidConfig(colors));
          configured = colorsKey;
        }
        renders += 1;
        return { svg: (await mermaid.render(`gyst-mermaid-${renders}`, source)).svg };
      } catch (error) {
        return { error: messageOf(error) };
      }
    });
    tail = outcome;
    return outcome;
  };

  return {
    request(
      slot: object,
      source: string,
      colors: DiagramColors,
      deliver: (outcome: DiagramOutcome) => void,
    ) {
      const token = Symbol("diagram request");
      latest.set(slot, token);
      const colorsKey = JSON.stringify(colors);
      const key = JSON.stringify([colorsKey, source]);
      let outcome = outcomes.get(key);
      if (!outcome) {
        outcome = enqueue(source, colors, colorsKey, key);
        outcomes.set(key, outcome);
      }
      void outcome.then((result) => {
        if (latest.get(slot) === token) deliver(result);
      });
    },
    release(slot: object) {
      latest.delete(slot);
    },
  };
}
