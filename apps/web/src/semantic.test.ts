import type { IdentifiersPayload, NavigationResultPayload } from "@gyst/core/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  afterIdentifiers,
  afterQuery,
  answers,
  choiceLabel,
  gapText,
  type LineOrigin,
  originTarget,
  readinessOf,
  requestOf,
  type SemanticStage,
  stepped,
  targetOf,
} from "./semantic.ts";
import type { RangeRead } from "./captured.ts";
import { SemanticPeekView } from "./semantic.tsx";

// StyleX compiles away in the app build; Node renders the same markup without its classes.
vi.mock("@stylexjs/stylex", () => ({
  create: (styles: object) => styles,
  defineVars: (vars: object) => vars,
  defineConsts: (consts: object) => consts,
  props: () => ({}),
}));

const snapshotId = "a".repeat(64);
const origin: LineOrigin = { kind: "line", snapshotId, side: "new", file: "src/use.ts", line: 2 };
const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});
const three = { text: "three", range: range(2, 13, 18) };
const plus = { text: "plus", range: range(2, 21, 25) };
const zero = { text: "zero", range: range(2, 36, 40) };
const identity = { sessionId: "s-1", snapshotId, side: "new", file: "src/use.ts" } as const;
const identifiers = (...found: (typeof plus)[]): IdentifiersPayload => ({
  ...identity,
  line: 2,
  outcome: { kind: "identifiers", identifiers: found, gaps: [] },
});
const missing = {
  kind: "addon",
  addon: { kind: "missing", install: "npm install -g @gyst/navigation-typescript@1.2.3" },
} as const;
const result = (outcome: NavigationResultPayload["outcome"]): NavigationResultPayload => ({
  ...identity,
  query: "definition",
  position: plus.range.start,
  outcome,
});

describe("requestOf", () => {
  it("asks a line's identifiers, or a choice at its symbol's start, on the origin's snapshot and side", () => {
    expect(requestOf("s-1", origin, { kind: "identifiers", query: "definition" })).toEqual({
      command: "identifiers",
      session: "s-1",
      snapshotId,
      side: "new",
      file: "src/use.ts",
      line: 2,
    });
    expect(
      requestOf("s-1", origin, {
        kind: "query",
        choice: { query: "references", symbol: plus },
      }),
    ).toEqual({
      command: "references",
      session: "s-1",
      snapshotId,
      side: "new",
      file: "src/use.ts",
      position: { line: 2, character: 21 },
    });
  });
});

describe("answers", () => {
  const lines = requestOf("s-1", origin, { kind: "identifiers", query: "definition" });
  const query = requestOf("s-1", origin, {
    kind: "query",
    choice: { query: "definition", symbol: plus },
  });

  it("accepts a reply restating the question", () => {
    expect(answers(lines, identifiers(plus))).toBe(true);
    expect(answers(query, result({ kind: "no-symbol" }))).toBe(true);
  });

  it("refuses a reply for another snapshot, side, file, line, query or position", () => {
    expect(answers(lines, { ...identifiers(plus), snapshotId: "b".repeat(64) })).toBe(false);
    expect(answers(lines, { ...identifiers(plus), side: "old" })).toBe(false);
    expect(answers(lines, { ...identifiers(plus), file: "src/math.ts" })).toBe(false);
    expect(answers(lines, { ...identifiers(plus), line: 3 })).toBe(false);
    expect(answers(lines, result({ kind: "no-symbol" }))).toBe(false);
    expect(answers(query, { ...result({ kind: "no-symbol" }), query: "references" })).toBe(false);
    expect(
      answers(query, { ...result({ kind: "no-symbol" }), position: { line: 2, character: 22 } }),
    ).toBe(false);
    expect(answers(query, { ...result({ kind: "no-symbol" }), sessionId: "s-2" })).toBe(false);
  });
});

describe("afterIdentifiers", () => {
  it("offers every identifier on the line for gd or gr, in line order", () => {
    expect(
      afterIdentifiers(
        { kind: "identifiers", query: "references" },
        identifiers(three, plus, zero),
      ),
    ).toEqual({
      stage: {
        kind: "choose",
        choices: [three, plus, zero].map((symbol) => ({ query: "references", symbol })),
        selected: 0,
        gaps: [],
      },
    });
  });

  it("asks at once for a line's only identifier, and says when there is none", () => {
    expect(
      afterIdentifiers({ kind: "identifiers", query: "definition" }, identifiers(plus)),
    ).toEqual({ ask: { kind: "query", choice: { query: "definition", symbol: plus } } });
    expect(afterIdentifiers({ kind: "identifiers", query: "definition" }, identifiers())).toEqual({
      stage: { kind: "none", message: "No symbol to look up on line 2.", gaps: [] },
    });
  });

  it("offers both queries of the identifier under a right-clicked token", () => {
    const at = afterIdentifiers(
      { kind: "identifiers", token: { start: 21, end: 25 } },
      identifiers(three, plus, zero),
    );
    expect(at).toEqual({
      stage: {
        kind: "choose",
        choices: [
          { query: "definition", symbol: plus },
          { query: "references", symbol: plus },
        ],
        selected: 0,
        gaps: [],
      },
    });
    // A token that only overlaps the identifier, as a highlighter may split one, still finds it.
    expect(
      afterIdentifiers({ kind: "identifiers", token: { start: 24, end: 26 } }, identifiers(plus)),
    ).toMatchObject({ stage: { kind: "choose", choices: [{ symbol: plus }, { symbol: plus }] } });
    expect(
      afterIdentifiers({ kind: "identifiers", token: { start: 25, end: 26 } }, identifiers(plus)),
    ).toEqual({ stage: { kind: "none", message: "No symbol to look up there.", gaps: [] } });
  });

  it("keeps the known missing inputs of a line's identifiers, when it has none too", () => {
    const gaps = [{ kind: "dependencies", file: "package.json" }] as const;
    const lacking = (...found: (typeof plus)[]): IdentifiersPayload => ({
      ...identifiers(...found),
      outcome: { kind: "identifiers", identifiers: found, gaps },
    });
    expect(
      afterIdentifiers({ kind: "identifiers", query: "definition" }, lacking(three, plus)),
    ).toMatchObject({ stage: { kind: "choose", gaps } });
    expect(
      afterIdentifiers({ kind: "identifiers", token: { start: 21, end: 25 } }, lacking(plus)),
    ).toMatchObject({ stage: { kind: "choose", gaps } });
    expect(afterIdentifiers({ kind: "identifiers", query: "definition" }, lacking())).toEqual({
      stage: { kind: "none", message: "No symbol to look up on line 2.", gaps },
    });
    expect(
      afterIdentifiers({ kind: "identifiers", token: { start: 0, end: 1 } }, lacking(plus)),
    ).toEqual({ stage: { kind: "none", message: "No symbol to look up there.", gaps } });
  });

  it("keeps an unavailable reason and the ask that met it", () => {
    const ask = { kind: "identifiers", query: "definition" } as const;
    expect(
      afterIdentifiers(ask, {
        ...identifiers(),
        outcome: { kind: "unavailable", reason: missing },
      }),
    ).toEqual({ stage: { kind: "unavailable", ask, reason: missing } });
  });
});

describe("afterQuery", () => {
  const choice = { query: "definition", symbol: plus } as const;
  const math = { file: "src/math.ts", range: range(3, 16, 19) };

  it("shows the engine's symbol and every location, the first selected, with what lies outside and the gaps", () => {
    const answered = afterQuery(
      choice,
      result({
        kind: "locations",
        symbol: plus,
        locations: [math],
        outside: 2,
        gaps: [{ kind: "no-project-config" }],
      }),
    );
    expect(answered).toEqual({
      kind: "locations",
      choice,
      locations: [math],
      outside: 2,
      gaps: [{ kind: "no-project-config" }],
      selected: 0,
    });
  });

  it("says when the engine found no symbol, and keeps an unavailable reason with its ask", () => {
    expect(afterQuery(choice, result({ kind: "no-symbol" }))).toEqual({
      kind: "none",
      message: "The engine found no symbol there.",
    });
    expect(
      afterQuery(choice, result({ kind: "unavailable", reason: { kind: "historical" } })),
    ).toEqual({
      kind: "unavailable",
      ask: { kind: "query", choice },
      reason: { kind: "historical" },
    });
  });
});

describe("stepped", () => {
  it("moves the selection within its list and leaves other stages alone", () => {
    const choose: SemanticStage = {
      kind: "choose",
      choices: [three, plus, zero].map((symbol) => ({ query: "definition", symbol })),
      selected: 0,
      gaps: [],
    };
    expect(stepped(choose, 1)).toMatchObject({ selected: 1 });
    expect(stepped(stepped(stepped(choose, 1), 1), 1)).toMatchObject({ selected: 2 });
    expect(stepped(choose, -1)).toBe(choose);
    const none: SemanticStage = { kind: "none", message: "x" };
    expect(stepped(none, 1)).toBe(none);
  });
});

describe("captured targets", () => {
  it("previews a location on the queried side of the origin's snapshot, and the origin line itself", () => {
    expect(targetOf(origin, { file: "src/math.ts", range: range(3, 16, 19) })).toEqual({
      snapshotId,
      path: "src/math.ts",
      side: "new",
      startLine: 3,
      endLine: 3,
    });
    expect(originTarget(origin)).toEqual({
      snapshotId,
      path: "src/use.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
    });
  });
});

describe("words", () => {
  it("names a choice by its query and symbol", () => {
    expect(choiceLabel({ query: "definition", symbol: plus })).toBe("Definition of plus");
    expect(choiceLabel({ query: "references", symbol: plus })).toBe("Usages of plus");
  });

  it("names each kind of known missing input", () => {
    expect(gapText({ kind: "dependencies", file: "package.json" })).toBe(
      "package.json declares packages, and installed packages are never captured",
    );
    expect(gapText({ kind: "uncaptured", file: "lib", reason: "symlink" })).toBe(
      "lib wasn't captured (symbolic link)",
    );
    expect(gapText({ kind: "no-project-config" })).toBe(
      "no tsconfig.json or jsconfig.json, so the engine inferred the project",
    );
    expect(
      gapText({
        kind: "unresolved-import",
        file: "src/a.ts",
        message: 'cannot resolve "@gyst/core" (TS2307)',
      }),
    ).toBe('src/a.ts: cannot resolve "@gyst/core" (TS2307)');
  });

  it("reads queued, preparing and ready as readiness, and nothing else", () => {
    expect(readinessOf({ kind: "queued" })).toBe("queued");
    expect(readinessOf({ kind: "preparing" })).toBe("preparing");
    expect(readinessOf({ kind: "ready", files: 1, bytes: 2, gaps: [] })).toBe("ready");
    expect(readinessOf({ kind: "stopped" })).toBeUndefined();
    expect(readinessOf({ kind: "unavailable", reason: { kind: "historical" } })).toBeUndefined();
  });
});

describe("SemanticPeekView", () => {
  const view = (stage: SemanticStage, at: LineOrigin = origin) =>
    renderToStaticMarkup(
      createElement(SemanticPeekView, {
        peek: { kind: "semantic", origin: at, stage },
        snapshotId,
        read: () => new Promise<RangeRead>(() => {}),
        narrow: false,
        onSelect: () => {},
        onChoose: () => {},
        onExpand: () => {},
        onClose: () => {},
        onCheckAgain: () => {},
        onRetry: () => {},
        onContinue: () => {},
      }),
    );
  const ask = { kind: "identifiers", query: "definition" } as const;
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, "")
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");

  it("says Preparing while it waits, and how far the queried side is", () => {
    expect(text(view({ kind: "waiting", ask, ticket: 1 }))).toContain("Preparing navigation…");
    expect(text(view({ kind: "waiting", ask, ticket: 1, readiness: "queued" }))).toContain(
      "Queued: waiting for an analysis engine; at most two run at once.",
    );
    expect(text(view({ kind: "waiting", ask, ticket: 1, readiness: "preparing" }))).toContain(
      "Preparing the new side: copying its captured TS/JS files and starting the engine…",
    );
  });

  it("offers the exact install command, Check again and Continue without navigation for a missing add-on", () => {
    const html = view({ kind: "unavailable", ask, reason: missing });
    expect(text(html)).toContain(
      "TS/JS navigation needs its optional add-on, which isn't on the PATH gyst was last opened from.",
    );
    expect(html).toContain(
      '<code data-install="true">npm install -g @gyst/navigation-typescript@1.2.3</code>',
    );
    expect(text(html)).toContain("Check again");
    expect(text(html)).toContain("Continue without navigation");
    expect(text(html)).not.toContain("Potentially incomplete");
    expect(text(view({ kind: "unavailable", ask, reason: missing, checked: true }))).toContain(
      "Checked again: no change yet.",
    );
  });

  it("names a mismatched release and an unusable add-on apart from project inputs", () => {
    const install = "npm install -g @gyst/navigation-typescript@1.2.3";
    expect(
      text(
        view({
          kind: "unavailable",
          ask,
          reason: { kind: "addon", addon: { kind: "mismatched", found: "0.0.1", install } },
        }),
      ),
    ).toContain(
      "The TS/JS navigation add-on found is release 0.0.1, not this gyst's. Update it to the matching release.",
    );
    expect(
      text(
        view({
          kind: "unavailable",
          ask,
          reason: { kind: "addon", addon: { kind: "unusable", reason: "no engine.", install } },
        }),
      ),
    ).toContain("The TS/JS navigation add-on found can't run: no engine. Install it again.");
    const notSource = text(
      view({
        kind: "unavailable",
        ask,
        reason: {
          kind: "not-source",
          detail: "README.md is not a TypeScript or JavaScript source",
        },
      }),
    );
    expect(notSource).toContain("Unavailable: README.md is not a TypeScript or JavaScript source.");
    expect(notSource).not.toContain("Check again");
  });

  it("says earlier code has no semantic queries", () => {
    expect(text(view({ kind: "unavailable", ask, reason: { kind: "historical" } }))).toContain(
      "Unavailable: semantic queries cover only the session's current snapshot, and this code is from an earlier one.",
    );
  });

  it("lists symbols and locations as a vertical selector, labelled with the query, symbol, side and snapshot", () => {
    const choose = view({
      kind: "choose",
      choices: [three, plus].map((symbol) => ({ query: "definition", symbol })),
      selected: 1,
      gaps: [],
    });
    expect(choose).toContain('role="listbox" aria-label="Symbols"');
    expect(choose.match(/role="option"/g)).toHaveLength(2);
    expect(choose).toMatch(/aria-selected="true"[^>]*>.*Definition of plus/);
    const found = view({
      kind: "locations",
      choice: { query: "definition", symbol: plus },
      locations: [{ file: "src/math.ts", range: range(3, 16, 19) }],
      outside: 0,
      gaps: [],
      selected: 0,
    });
    expect(found).toContain('aria-label="Definition of plus · new side · snapshot aaaaaaa"');
    expect(found).toContain('role="listbox" aria-label="Definitions"');
    expect(text(found)).toContain("math.tssrc/ · line 3, column 17");
    expect(text(found)).toContain("Expand");
  });

  it("marks potentially incomplete results, an empty one too, and counts what lies outside the capture", () => {
    const html = text(
      view({
        kind: "locations",
        choice: { query: "references", symbol: plus },
        locations: [],
        outside: 2,
        gaps: [{ kind: "dependencies", file: "package.json" }],
        selected: 0,
      }),
    );
    expect(html).toContain("No usages found in the captured files.");
    expect(html).toContain(
      "Potentially incomplete: finding none doesn't mean there are none.1 known missing input",
    );
    expect(html).toContain(
      "package.json declares packages, and installed packages are never captured",
    );
    expect(html).toContain("2 more lie outside the captured files and aren't shown.");
    expect(html).not.toContain("Expand");
    expect(
      text(
        view({
          kind: "locations",
          choice: { query: "definition", symbol: plus },
          locations: [],
          outside: 1,
          gaps: [],
          selected: 0,
        }),
      ),
    ).toContain("1 more lies outside the captured files and isn't shown.");
  });

  it("marks a line's symbols, or finding none there, potentially incomplete with their known missing inputs", () => {
    const gaps = [{ kind: "dependencies", file: "package.json" }] as const;
    const missingInput =
      "package.json declares packages, and installed packages are never captured";
    const choose = text(
      view({
        kind: "choose",
        choices: [three, plus].map((symbol) => ({ query: "definition", symbol })),
        selected: 0,
        gaps,
      }),
    );
    expect(choose).toContain("Potentially incomplete.1 known missing input");
    expect(choose).toContain(missingInput);
    const none = text(view({ kind: "none", message: "No symbol to look up on line 2.", gaps }));
    expect(none).toContain("No symbol to look up on line 2.");
    expect(none).toContain(
      "Potentially incomplete: finding none doesn't mean there are none.1 known missing input",
    );
    expect(none).toContain(missingInput);
    expect(
      text(view({ kind: "none", message: "No symbol to look up on line 2.", gaps: [] })),
    ).not.toContain("Potentially incomplete");
  });

  it("lists a few known missing inputs at once and more on request", () => {
    const gaps = (count: number) =>
      view({
        kind: "locations",
        choice: { query: "references", symbol: plus },
        locations: [{ file: "src/use.ts", range: plus.range }],
        outside: 0,
        gaps: Array.from({ length: count }, (_, n) => ({
          kind: "dependencies" as const,
          file: `packages/p${n}/package.json`,
        })),
        selected: 0,
      });
    expect(gaps(3)).toContain('<details open=""><summary>3 known missing inputs</summary>');
    expect(gaps(4)).toContain("<details><summary>4 known missing inputs</summary>");
    expect(text(gaps(4))).toContain("packages/p3/package.json declares packages");
  });
});
