import { BadArgs, type CapturedRange, type CodePayload, type ManifestFile } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import {
  type CodeRead,
  linesOf,
  readRange,
  readWholeSide,
  referenceAvailability,
} from "./captured.ts";

const snapshotId = "a".repeat(64);
const target: CapturedRange = {
  snapshotId,
  path: "src/long.ts",
  side: "new",
  startLine: 40,
  endLine: 42,
};
const blob = { kind: "text", blob: "b".repeat(64), size: 10 } as const;
const entry = (sides: Partial<Pick<ManifestFile, "old" | "new">> = {}): ManifestFile => ({
  path: target.path,
  old: blob,
  new: blob,
  ...sides,
});
const current = (file: ManifestFile | undefined, complete = true) => ({
  snapshotId,
  file,
  complete,
});

describe("referenceAvailability", () => {
  it("shows a target pinned to the current snapshot whose side holds text", () => {
    expect(referenceAvailability(target, current(entry()))).toEqual({ available: true });
  });

  it("leaves a target pinned to an earlier snapshot to that snapshot's read, not the current files", () => {
    const earlier = { ...target, snapshotId: "c".repeat(64) };
    expect(referenceAvailability(earlier, current(undefined))).toEqual({ available: true });
    expect(referenceAvailability(earlier, current(entry({ new: { kind: "absent" } })))).toEqual({
      available: true,
    });
  });

  it("says why a target can't be shown instead of reading another path", () => {
    expect(referenceAvailability(target, current(undefined))).toEqual({
      available: false,
      reason: "not in this snapshot",
    });
    expect(referenceAvailability(target, current(entry({ new: { kind: "absent" } })))).toEqual({
      available: false,
      reason: "absent on the new side",
    });
    expect(
      referenceAvailability(
        { ...target, side: "old" },
        current(entry({ old: { kind: "unavailable", reason: "binary" } })),
      ),
    ).toEqual({ available: false, reason: "old side not captured: binary" });
  });

  it("leaves a file no loaded files page has listed yet to the read", () => {
    expect(referenceAvailability(target, current(undefined, false))).toEqual({ available: true });
  });
});

const page = (
  start: number,
  text: string,
  next: { line: number; offset: number } | null,
): CodePayload => ({
  sessionId: "s",
  snapshotId,
  file: target.path,
  side: target.side,
  content: { kind: "text", size: 999, start: { line: start, offset: 0 }, text, next },
});

describe("readRange", () => {
  it("reads the target and three lines either side from the snapshot it is pinned to", async () => {
    const requests: Parameters<CodeRead>[0][] = [];
    const read: CodeRead = async (request) => {
      requests.push(request);
      return requests.length === 1
        ? page(37, "l37\nl38\nl39\nl40\n", { line: 41, offset: 100 })
        : page(41, "l41\nl42\nl43\nl44\nl45\n", null);
    };
    expect(await readRange(target, read)).toEqual({
      kind: "text",
      startLine: 37,
      lines: ["l37", "l38", "l39", "l40", "l41", "l42", "l43", "l44", "l45"],
    });
    const pinned = { command: "code", snapshotId, file: "src/long.ts", side: "new" };
    expect(requests).toEqual([
      { ...pinned, startLine: 37, endLine: 45 },
      { ...pinned, offset: 100, endLine: 45 },
    ]);
  });

  it("starts at the first line and reads on to the file's end when it ends within the context", async () => {
    const requests: Parameters<CodeRead>[0][] = [];
    const read: CodeRead = async (request) => {
      requests.push(request);
      if (request.endLine !== undefined)
        throw new BadArgs({ message: "endLine is past the last line of the captured content" });
      return page(1, "l1\nl2", null);
    };
    expect(await readRange({ ...target, startLine: 1, endLine: 2 }, read)).toEqual({
      kind: "text",
      startLine: 1,
      lines: ["l1", "l2"],
    });
    const pinned = { command: "code", snapshotId, file: "src/long.ts", side: "new" };
    expect(requests).toEqual([
      { ...pinned, startLine: 1, endLine: 5 },
      { ...pinned, startLine: 1 },
    ]);
  });

  it("passes on any other failure", async () => {
    const lost = new Error("lost");
    await expect(
      readRange(target, async () => {
        throw lost;
      }),
    ).rejects.toBe(lost);
  });

  it("says why a side has no text", async () => {
    const read: CodeRead = async () => ({
      ...page(1, "", null),
      content: { kind: "unavailable", reason: "symlink" },
    });
    expect(await readRange(target, read)).toEqual({
      kind: "unavailable",
      reason: "new side not captured: symbolic link",
    });
  });
});

describe("readWholeSide", () => {
  it("pages through the whole pinned side", async () => {
    const requests: Parameters<CodeRead>[0][] = [];
    const read: CodeRead = async (request) => {
      requests.push(request);
      return requests.length === 1 ? page(1, "a\n", { line: 2, offset: 2 }) : page(2, "b\n", null);
    };
    expect(await readWholeSide(target, read)).toBe("a\nb\n");
    const pinned = { command: "code", snapshotId, file: "src/long.ts", side: "new" };
    expect(requests).toEqual([pinned, { ...pinned, offset: 2 }]);
  });
});

describe("linesOf", () => {
  it("splits on LF, where a final LF ends the last line", () => {
    expect(linesOf("")).toEqual([]);
    expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    expect(linesOf("a\nb")).toEqual(["a", "b"]);
    expect(linesOf("\n")).toEqual([""]);
  });
});
