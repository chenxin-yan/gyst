import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  anchoredHunkIds,
  CapturedRangeSchema,
  changedLinesOf,
  CodeRangeSchema,
  MarkdownSchema,
  parseReferenceHref,
} from "./guidance.ts";

const hunk = (id: string, patch: string, file = "a.ts") => ({ id, file, patch });

describe("changedLinesOf", () => {
  it("numbers removed lines on the old side and added lines on the new side", () => {
    expect(changedLinesOf({ patch: "@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+2b\n three" })).toEqual({
      old: [2],
      new: [2, 3],
    });
    expect(changedLinesOf({ patch: "@@ -0,0 +1,2 @@\n+a\n+b" })).toEqual({ old: [], new: [1, 2] });
    expect(changedLinesOf({ patch: "@@ -4,2 +3,0 @@\n-x\n-y" })).toEqual({ old: [4, 5], new: [] });
    expect(changedLinesOf({ patch: "@@ -7 +7 @@ fn()\n-a\n+b" })).toEqual({ old: [7], new: [7] });
  });

  it("skips no-newline markers and counts context on both sides", () => {
    expect(
      changedLinesOf({
        patch:
          "@@ -10,3 +10,3 @@\n ctx\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
      }),
    ).toEqual({ old: [11], new: [11] });
    expect(changedLinesOf({ patch: "@@ -5,4 +5,6 @@\n a\n b\n+c\n d\n-e\n+E\n+F" })).toEqual({
      old: [8],
      new: [7, 9, 10],
    });
  });

  it("has no changed lines without a hunk header", () => {
    expect(changedLinesOf({ patch: "-a\n+b" })).toEqual({ old: [], new: [] });
  });
});

describe("anchoredHunkIds", () => {
  const hunks = [
    hunk("first", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"),
    hunk("deletion", "@@ -10,2 +9,0 @@\n-x\n-y"),
    hunk("second", "@@ -20,2 +18,3 @@\n p\n+q\n r"),
    hunk("elsewhere", "@@ -1 +1 @@\n-a\n+b", "b.ts"),
  ];
  const range = (side: "old" | "new", startLine: number, endLine: number) => ({
    path: "a.ts",
    side,
    startLine,
    endLine,
  });

  it("matches changed lines on the range's side and file only", () => {
    expect(anchoredHunkIds(hunks, range("new", 1, 30))).toEqual(["first", "second"]);
    // A pure deletion is reachable only from the old side.
    expect(anchoredHunkIds(hunks, range("old", 1, 30))).toEqual(["first", "deletion"]);
    expect(anchoredHunkIds(hunks, range("new", 9, 10))).toEqual([]);
  });

  it("treats both range ends as inclusive and ignores context lines", () => {
    expect(anchoredHunkIds(hunks, range("new", 2, 2))).toEqual(["first"]);
    expect(anchoredHunkIds(hunks, range("new", 19, 19))).toEqual(["second"]);
    expect(anchoredHunkIds(hunks, range("new", 3, 18))).toEqual([]);
    expect(anchoredHunkIds(hunks, range("old", 11, 11))).toEqual(["deletion"]);
    expect(anchoredHunkIds(hunks, range("old", 12, 20))).toEqual([]);
  });
});

describe("guidance schemas", () => {
  it("accept rich Markdown of any length and refuse blank or control-bearing text", () => {
    const valid = Schema.is(MarkdownSchema);
    for (const text of ["`code`", "a\n\n- b\n\tc", "x".repeat(10_000), "```mermaid\ngraph TD\n```"])
      expect(valid(text), text).toBe(true);
    for (const text of ["", " \n\t", "a\rb", "a\u0007b", "a\u001bb", "a\u009bb", "a\u2028b"])
      expect(valid(text), JSON.stringify(text)).toBe(false);
    for (const text of ["a\u202eb", "a\u2066b", "a\u2069b"]) expect(valid(text)).toBe(false);
  });

  it("require an ordered range of positive lines on a logical path", () => {
    const valid = Schema.is(CodeRangeSchema);
    const range = { path: "src/a.ts", side: "new", startLine: 3, endLine: 3 };
    expect(valid(range)).toBe(true);
    for (const invalid of [
      { ...range, startLine: 0 },
      { ...range, endLine: 2 },
      { ...range, startLine: 1.5 },
      { ...range, side: "both" },
      { ...range, path: "../a.ts" },
      { ...range, path: "/a.ts" },
    ])
      expect(valid(invalid), JSON.stringify(invalid)).toBe(false);
    expect(Schema.is(CapturedRangeSchema)({ ...range, snapshotId: "s" })).toBe(true);
    expect(Schema.is(CapturedRangeSchema)({ ...range, snapshotId: "s", endLine: 1 })).toBe(false);
  });
});

describe("parseReferenceHref", () => {
  it("reads a side, a percent-decoded path and one line or an inclusive range", () => {
    expect(parseReferenceHref("gyst:new/src/a.ts#L40-L52")).toEqual({
      path: "src/a.ts",
      side: "new",
      startLine: 40,
      endLine: 52,
    });
    expect(parseReferenceHref("gyst:old/docs/a%20b.md#L7")).toEqual({
      path: "docs/a b.md",
      side: "old",
      startLine: 7,
      endLine: 7,
    });
  });

  it("returns nothing for anything that is not an exact valid reference", () => {
    for (const href of [
      "gyst:src/a.ts#L1",
      "gyst:both/a.ts#L1",
      "gyst:new/a.ts",
      "gyst:new/a.ts#L0",
      "gyst:new/a.ts#L01",
      "gyst:new/a.ts#L5-L4",
      "gyst:new/a.ts#L1-2",
      "gyst:new/../a.ts#L1",
      "gyst:new/a/%2e%2e/b.ts#L1",
      "gyst:new/a//b.ts#L1",
      "gyst:new/%E0%A4%A.ts#L1",
      "gyst:new/a%00.ts#L1",
      "https://example.com/a.ts#L1",
      "GYST:new/a.ts#L1",
    ])
      expect(parseReferenceHref(href), href).toBeUndefined();
  });
});
