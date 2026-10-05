import { describe, expect, it } from "vite-plus/test";
import { recall, remember } from "./reading-memory.ts";

describe("reading memory", () => {
  it("keeps each session's place apart, so switching sessions resumes each where it was left", () => {
    remember("b", "snap-b", {
      selection: "src",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      file: "src/b.ts",
    });
    remember("c", "snap-c", { selection: "", cursor: undefined, file: "c.ts" });
    expect(recall("b", "snap-b")).toEqual({
      selection: "src",
      cursor: { file: "src/b.ts", kind: "line", side: "additions", line: 12 },
      file: "src/b.ts",
    });
    expect(recall("c", "snap-c")).toEqual({ selection: "", cursor: undefined, file: "c.ts" });
    expect(recall("a", "snap-b")).toBeUndefined();
  });

  it("ignores a place read in another snapshot of the session, as after a refresh", () => {
    remember("d", "old", { selection: "lib", cursor: undefined, file: "lib/x.ts" });
    expect(recall("d", "new")).toBeUndefined();
    remember("d", "new", { selection: "", cursor: undefined, file: undefined });
    expect(recall("d", "new")).toEqual({ selection: "", cursor: undefined, file: undefined });
  });
});
