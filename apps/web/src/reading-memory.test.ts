import { describe, expect, it } from "vite-plus/test";
import { type ReadingPlace, recall, remember } from "./reading-memory.ts";

const placeAt = (path: string, file: string | undefined): ReadingPlace => ({
  review: { kind: "files", path },
  inputMode: "vim",
  cursor: undefined,
  opened: new Map(),
  top: file === undefined ? undefined : { file, side: undefined, line: undefined },
});

describe("reading memory", () => {
  it("keeps each session's place apart, so switching sessions resumes each where it was left", () => {
    const b: ReadingPlace = {
      review: { kind: "files", path: "src" },
      inputMode: "mouse",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      opened: new Map([["src/b.ts", new Map([[0, { fromStart: 20, fromEnd: 0 }]])]]),
      top: { file: "src/b.ts", side: "additions", line: 9 },
    };
    remember("b", "snap-b", b);
    remember("c", "snap-c", placeAt("", "c.ts"));
    expect(recall("b", "snap-b")).toEqual(b);
    expect(recall("c", "snap-c")).toEqual(placeAt("", "c.ts"));
    expect(recall("a", "snap-b")).toBeUndefined();
  });

  it("ignores a place read in another snapshot of the session, as after a refresh", () => {
    remember("d", "old", placeAt("lib", "lib/x.ts"));
    expect(recall("d", "new")).toBeUndefined();
    remember("d", "new", placeAt("", undefined));
    expect(recall("d", "new")).toEqual(placeAt("", undefined));
  });
});
