import type { CapturedRange } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import type { Place } from "./navigation.ts";
import { type ReadingPlace, recall, remember } from "./reading-memory.ts";

const placeAt = (path: string, file: string | undefined): ReadingPlace => ({
  review: { kind: "files", path },
  captured: undefined,
  expandedOpened: new Map(),
  peek: undefined,
  back: [],
  inputMode: "vim",
  cursor: undefined,
  opened: new Map(),
  top: file === undefined ? undefined : { position: { file, side: undefined, line: undefined } },
});

describe("reading memory", () => {
  it("keeps each session's place apart, so switching sessions resumes each where it was left", () => {
    const b: ReadingPlace = {
      ...placeAt("src", undefined),
      inputMode: "mouse",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map([["src/b.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      top: { position: { file: "src/b.ts", side: "additions", line: 9 } },
    };
    remember("b", "snap-b", b);
    remember("c", "snap-c", placeAt("", "c.ts"));
    expect(recall("b", "snap-b")).toEqual(b);
    expect(recall("c", "snap-c")).toEqual(placeAt("", "c.ts"));
    expect(recall("a", "snap-b")).toBeUndefined();
  });

  it("keeps an expanded reference with its opened lines, its peek and the places Back returns to", () => {
    const target: CapturedRange = {
      snapshotId: "snap-e",
      path: "lib/x.ts",
      side: "new",
      startLine: 4,
      endLine: 6,
    };
    const origin: Place = {
      review: { kind: "group", id: "core" },
      captured: undefined,
      cursor: { file: "a.ts", kind: "line", side: "additions", line: 18 },
      lines: null,
      folded: new Set<string>(),
      restore: { scrollTop: 120 },
      peek: { target, origin: { kind: "note", noteId: "span" } },
    };
    const expanded: ReadingPlace = {
      ...placeAt("", undefined),
      review: origin.review,
      captured: target,
      expandedOpened: new Map([["lib/x.ts", new Map([[1, { fromStart: 3, fromEnd: 0 }]])]]),
      peek: { target, origin: { kind: "overview" } },
      back: [origin],
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 5 },
      top: { position: { file: "lib/x.ts", side: "additions", line: 2 } },
    };
    remember("e", "snap-e", expanded);
    expect(recall("e", "snap-e")).toEqual(expanded);
  });

  it("carries only the view, input mode and top file over a refresh to another snapshot", () => {
    remember("d", "old", {
      ...placeAt("lib", "lib/x.ts"),
      inputMode: "mouse",
      cursor: { file: "lib/x.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map([["lib/x.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      top: { position: { file: "lib/x.ts", side: "additions", line: 9 } },
    });
    expect(recall("d", "new")).toEqual({ ...placeAt("lib", "lib/x.ts"), inputMode: "mouse" });
    // An overview at the top is kept as the panel's offset.
    const overview: ReadingPlace = { ...placeAt("", undefined), top: { scrollTop: 40 } };
    remember("d", "new", overview);
    expect(recall("d", "new")).toEqual(overview);
  });
});
