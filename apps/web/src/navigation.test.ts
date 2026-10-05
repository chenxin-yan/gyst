import type { CapturedRange } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { type Peek, type Place, popped, pushed, restoreFor } from "./navigation.ts";

const range = (path: string, startLine: number): CapturedRange => ({
  snapshotId: "a".repeat(64),
  path,
  side: "new",
  startLine,
  endLine: startLine + 2,
});
const notePeek: Peek = { target: range("walk/b.ts", 4), origin: { kind: "note", noteId: "span" } };
const overviewPeek: Peek = { target: range("src/long.ts", 10), origin: { kind: "overview" } };
const position = { file: "walk/a.ts", side: "additions", line: 18 } as const;

describe("restoreFor", () => {
  it("returns to a note's reading position, and to an overview's pixel offset", () => {
    expect(restoreFor(notePeek, { position, scrollTop: 640 })).toEqual({ position });
    expect(restoreFor(overviewPeek, { position, scrollTop: 0 })).toEqual({ scrollTop: 0 });
    expect(restoreFor(notePeek, { position: undefined, scrollTop: 12 })).toEqual({
      scrollTop: 12,
    });
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
      peek: { target: range("src/long.ts", 40), origin: { kind: "note", noteId: "b-note" } },
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
