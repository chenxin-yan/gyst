import type { CapturedRange } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import {
  type Peek,
  type Place,
  type ReferencePeek,
  popped,
  pushed,
  restoreFor,
  resumable,
} from "./navigation.ts";
import type { SemanticPeek } from "./semantic.ts";

const range = (path: string, startLine: number): CapturedRange => ({
  snapshotId: "a".repeat(64),
  path,
  side: "new",
  startLine,
  endLine: startLine + 2,
});
const notePeek: ReferencePeek = {
  kind: "reference",
  target: range("walk/b.ts", 4),
  origin: { kind: "note", noteId: "span" },
};
const overviewPeek: Peek = {
  kind: "reference",
  target: range("src/long.ts", 10),
  origin: { kind: "overview" },
};
const symbol = {
  text: "plus",
  range: { start: { line: 2, character: 21 }, end: { line: 2, character: 25 } },
};
const definitionPeek: SemanticPeek = {
  kind: "semantic",
  origin: { kind: "line", snapshotId: "a".repeat(64), side: "new", file: "src/use.ts", line: 2 },
  stage: {
    kind: "locations",
    choice: { query: "definition", symbol },
    locations: [{ file: "src/math.ts", range: symbol.range }],
    outside: 0,
    gaps: [],
    selected: 0,
  },
};
const position = { file: "walk/a.ts", side: "additions", line: 18 } as const;

describe("restoreFor", () => {
  it("returns to a note's reading position, and to an overview's pixel offset", () => {
    expect(restoreFor(notePeek, { position, scrollTop: 640 })).toEqual({ position });
    expect(restoreFor(overviewPeek, { position, scrollTop: 0 })).toEqual({ scrollTop: 0 });
    expect(restoreFor(notePeek, { position: undefined, scrollTop: 12 })).toEqual({
      scrollTop: 12,
    });
  });

  it("returns to a semantic peek's code line by its reading position", () => {
    expect(restoreFor(definitionPeek, { position, scrollTop: 640 })).toEqual({ position });
  });
});

describe("resumable", () => {
  const ask = { kind: "identifiers", query: "definition" } as const;
  const missing = { kind: "addon", addon: { kind: "missing", install: "npm i" } } as const;

  it("keeps references and settled semantic peeks as they were", () => {
    expect(resumable(notePeek)).toBe(notePeek);
    expect(resumable(definitionPeek)).toBe(definitionPeek);
    expect(resumable(undefined)).toBeUndefined();
  });

  it("drops a semantic peek still waiting for an answer, and forgets a Check again in flight", () => {
    expect(
      resumable({ ...definitionPeek, stage: { kind: "waiting", ask, ticket: 3 } }),
    ).toBeUndefined();
    expect(
      resumable({
        ...definitionPeek,
        stage: { kind: "unavailable", ask, reason: missing, checking: 4, checked: true },
      }),
    ).toEqual({ ...definitionPeek, stage: { kind: "unavailable", ask, reason: missing } });
  });
});

describe("the Back stack", () => {
  it("returns through nested expansions to the origin, each with its cursor, selection and peek", () => {
    const origin: Place = {
      review: { kind: "group", id: "core" },
      captured: undefined,
      cursor: { file: "walk/a.ts", kind: "line", side: "additions", line: 20 },
      lines: { id: "walk/a.ts", range: { start: 18, side: "additions", end: 20 } },
      folded: new Set(["walk/b.ts"]),
      restore: { position },
      peek: notePeek,
    };
    const first: Place = {
      review: origin.review,
      captured: notePeek.target,
      cursor: { file: "walk/b.ts", kind: "line", side: "additions", line: 5 },
      lines: null,
      folded: new Set(),
      restore: { position: { file: "walk/b.ts", side: "additions", line: 1 } },
      peek: definitionPeek,
    };
    let stack = pushed(pushed([], origin), first);
    expect(stack).toHaveLength(2);

    const back = popped(stack)!;
    expect(back.place).toBe(first);
    stack = back.stack;
    const again = popped(stack)!;
    expect(again.place).toBe(origin);
    expect(again.place.lines).toEqual(origin.lines);
    expect(again.place.folded).toEqual(new Set(["walk/b.ts"]));
    expect(again.stack).toEqual([]);
    expect(popped(again.stack)).toBeUndefined();
  });
});
