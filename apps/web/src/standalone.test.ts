import type { BrowserRequest, CodePayload, WalkthroughExport } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { type CodeRead, readRange, readWholeSide } from "./captured.ts";
import { answer, codePageOf } from "./standalone.ts";

const S1 = "1".repeat(64);
const S0 = "0".repeat(64);
const blob = (name: string) => name.repeat(64).slice(0, 64);
const text = "\uFEFFfirst é\r\nsecond\nthird €\nlast";
const helper = "h1\nh2\nh3\n";
const data: WalkthroughExport = {
  gyst: "0.0.0",
  exportedAt: "2026-03-01T00:00:00.000Z",
  walkthrough: {
    scope: { kind: "range", range: "main...topic" },
    provenance: {
      kind: "range",
      base: "a".repeat(40),
      head: "b".repeat(40),
      mergeBase: "c".repeat(40),
    },
    snapshotId: S1,
    overview: { markdown: "Overview.", references: [] },
    groups: [],
    hunks: [
      {
        id: "h",
        file: "a.ts",
        header: "@@ -1 +1 @@",
        patch: "@@ -1 +1 @@\n-x\n+y",
        contentHash: "c",
      },
    ],
    files: [
      { path: "a.ts", old: { kind: "absent" }, new: { kind: "text", blob: blob("a"), size: 0 } },
      {
        path: "bin",
        old: { kind: "unavailable", reason: "binary" },
        new: { kind: "unavailable", reason: "binary" },
      },
    ],
    pinned: [
      {
        snapshotId: S0,
        path: "helper.ts",
        side: "new",
        content: { kind: "text", blob: blob("b"), size: 9 },
      },
    ],
  },
  contents: { [blob("a")]: text, [blob("b")]: helper },
};

const read: CodeRead = async (request) => {
  const reply = answer(data, { ...request, session: "walkthrough" });
  if (!reply.ok) throw reply.error;
  return reply.value as CodePayload;
};
const reply = (request: BrowserRequest) => answer(data, request);

describe("codePageOf", () => {
  it("pages as the daemon does: LF lines, UTF-8 byte offsets, a kept BOM and CR", () => {
    expect(codePageOf(text, {})).toEqual({
      kind: "text",
      size: new TextEncoder().encode(text).length,
      start: { line: 1, offset: 0 },
      text,
      next: null,
    });
    // BOM (3 bytes) + "first é\r\n" (10 bytes) puts line 2 at byte 13.
    expect(codePageOf(text, { startLine: 2, endLine: 3 })).toMatchObject({
      start: { line: 2, offset: 13 },
      text: "second\nthird €\n",
    });
    expect(codePageOf(text, { offset: 13 })).toMatchObject({
      start: { line: 2, offset: 13 },
      text: "second\nthird €\nlast",
    });
    expect(codePageOf(text, { startLine: 4 })).toMatchObject({ text: "last" });
    expect(codePageOf("", {})).toMatchObject({ size: 0, text: "", start: { line: 1, offset: 0 } });
  });
});

describe("answer", () => {
  it("reads captured sides of the current snapshot and the earlier sides the export pins", async () => {
    expect(
      await readWholeSide(
        { snapshotId: S1, path: "a.ts", side: "new", startLine: 1, endLine: 1 },
        read,
      ),
    ).toBe(text);
    expect(
      await readRange(
        { snapshotId: S0, path: "helper.ts", side: "new", startLine: 2, endLine: 2 },
        read,
        0,
      ),
    ).toEqual({ kind: "text", startLine: 2, lines: ["h2"] });
    expect(
      await readRange({ snapshotId: S1, path: "bin", side: "new", startLine: 1, endLine: 1 }, read),
    ).toEqual({ kind: "unavailable", reason: "new side not captured: binary" });
    // Only the pinned side of an earlier file is in the export, never its other side.
    await expect(
      readRange({ snapshotId: S0, path: "helper.ts", side: "old", startLine: 1, endLine: 1 }, read),
    ).rejects.toMatchObject({ _tag: "stale_revision" });
  });

  it("answers the reader's reads with the export alone and nothing private", () => {
    const status = reply({ command: "status", session: "walkthrough" });
    expect(status).toMatchObject({
      ok: true,
      value: {
        session: { id: "walkthrough", repoRoot: "", snapshotId: S1, createdAt: data.exportedAt },
        preparation: { state: "complete", totalHunks: 1 },
        viewedHunkIds: [],
        threads: { open: 0, resolved: 0, pending: 0 },
        files: [{ path: "a.ts", hunkCount: 1, viewed: false }],
      },
    });
    expect(reply({ command: "files", session: "walkthrough", snapshotId: S1 })).toMatchObject({
      ok: true,
      value: { total: 2, files: data.walkthrough.files, next: null },
    });
    expect(reply({ command: "conversations", session: "walkthrough" })).toMatchObject({
      ok: true,
      value: { threads: [], drafts: [] },
    });
  });

  it("refuses every write, check and refresh: the export is read-only", () => {
    for (const request of [
      {
        command: "viewed",
        session: "walkthrough",
        snapshotId: S1,
        revision: 0,
        requestId: "r",
        hunkIds: ["h"],
        viewed: true,
      },
      { command: "refresh", session: "walkthrough", snapshotId: S1, requestId: "r" },
      { command: "check", session: "walkthrough" },
      { command: "delete", session: "walkthrough", requestId: "r" },
      { command: "list" },
      { command: "preview", session: "walkthrough" },
    ] satisfies BrowserRequest[])
      expect(reply(request)).toMatchObject({ ok: false, error: { _tag: "validation_failed" } });
  });
});
