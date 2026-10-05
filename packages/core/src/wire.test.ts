import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import * as publicRoot from "@gyst/core";
import * as publicWire from "@gyst/core/wire";
import { BadArgs, ErrorPayloadSchema, NoSession } from "./errors.ts";
import { BrowserRequestSchema, ReplySchema, RequestSchema } from "./wire.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeRequest = Schema.decodeUnknownSync(RequestSchema, strict);
const snapshotId = "a".repeat(64);
const decodeBrowserRequest = Schema.decodeUnknownSync(BrowserRequestSchema, strict);
const decodeReply = Schema.decodeUnknownSync(ReplySchema);
const encodeError = Schema.encodeSync(ErrorPayloadSchema);

describe("daemon wire envelopes", () => {
  it("rejects request and reply shape drift", () => {
    expect(() => decodeRequest({ command: "unknown", session: "s1" })).toThrow();
    expect(() => decodeReply({ ok: true, payload: {} })).toThrow();
    expect(() => decodeReply({ ok: false, error: { message: "missing code" } })).toThrow();
    expect(() => decodeReply({ ok: false, error: { _tag: "bad_args", message: "x" } })).toThrow();
  });

  it("carries recorded scopes and exact ids, never argv, patches or directory fallbacks", () => {
    for (const valid of [
      { command: "open", cwd: "/repo", scope: { kind: "uncommitted" } },
      { command: "open", cwd: "/repo", scope: { kind: "range", range: "main...feature" } },
      { command: "open", session: "s1" },
      { command: "list" },
      { command: "diff", session: "s1", file: "a.txt" },
      { command: "delete", session: "s1", requestId: "r1" },
    ])
      expect(decodeRequest(valid)).toEqual(valid);
    for (const invalid of [
      { command: "create", cwd: "/repo", revisions: ["HEAD"] },
      { command: "close", session: "s1" },
      { command: "open", cwd: "/repo", scope: { kind: "range", range: "a..b" }, session: "s1" },
      { command: "open", cwd: "/repo", scope: { kind: "range", range: "a..b", pathspecs: ["x"] } },
      { command: "open", cwd: "/repo", scope: { kind: "stdin" }, patch: "diff" },
      { command: "status", cwd: "/repo" },
      { command: "status", cwd: "/repo", session: "s1" },
      { command: "refresh", session: "s1", patch: "diff" },
      { command: "delete", session: "s1" },
      { command: "apply", session: "s1", stdin: "{}" },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
  });

  it("keeps checkout, Git, executable, authority and agent operations out of browser requests", () => {
    for (const valid of [
      { command: "list" },
      { command: "open", session: "s1" },
      { command: "status", session: "s1" },
      { command: "delete", session: "s1", requestId: "r1" },
      {
        command: "viewed",
        session: "s1",
        snapshotId,
        revision: 2,
        requestId: "r1",
        hunkIds: ["h1"],
        viewed: true,
      },
      { command: "files", session: "s1", snapshotId, after: "src/a.ts" },
      { command: "code", session: "s1", snapshotId, file: "src/a.ts", side: "new" },
      {
        command: "code",
        session: "s1",
        snapshotId,
        file: "a",
        side: "old",
        startLine: 2,
        endLine: 2,
      },
      { command: "code", session: "s1", snapshotId, file: "a", side: "old", offset: 0, endLine: 9 },
    ])
      expect(decodeBrowserRequest(valid)).toEqual(valid);
    for (const invalid of [
      { command: "open", cwd: "/repo", scope: { kind: "uncommitted" } },
      { command: "open", session: "s1", cwd: "/repo" },
      { command: "status", session: "s1", role: "human" },
      { command: "check", session: "s1", args: ["--output=/tmp/x"] },
      { command: "diff", session: "s1", executable: "/bin/sh" },
      { command: "apply", session: "s1", batch: "{}" },
      { command: "refresh", session: "s1" },
      // Viewed names the observed snapshot and revision and a request id; never an author role.
      { command: "viewed", session: "s1", snapshotId, requestId: "r1", hunkIds: [], viewed: true },
      { command: "viewed", session: "s1", revision: 2, requestId: "r1", hunkIds: [], viewed: true },
      { command: "viewed", session: "s1", snapshotId, revision: 2, hunkIds: [], viewed: true },
      {
        command: "viewed",
        session: "s1",
        snapshotId,
        revision: 2,
        requestId: "r1",
        hunkIds: ["h1"],
        viewed: true,
        role: "agent",
      },
      // Group verdicts and the review queue are gone, not aliased.
      { command: "verdict", session: "s1", itemId: "g1" },
      // Snapshot reads name a logical path in an exact snapshot, never a host path or blob.
      { command: "code", session: "s1", file: "a", side: "new" },
      { command: "code", session: "s1", snapshotId: "HEAD", file: "a", side: "new" },
      { command: "code", session: "s1", snapshotId, file: "/etc/passwd", side: "new" },
      { command: "code", session: "s1", snapshotId, file: "../outside", side: "new" },
      { command: "code", session: "s1", snapshotId, file: "a", side: "working-tree" },
      { command: "code", session: "s1", snapshotId, file: "a", side: "new", blob: snapshotId },
      { command: "code", session: "s1", snapshotId, file: "a", side: "new", cwd: "/repo" },
      { command: "files", session: "s1", snapshotId, after: "a/../../b" },
      { command: "files", session: "s1", snapshotId, path: "/repo" },
      // Positions are whole 1-based lines or a byte offset, in order, never both.
      { command: "code", session: "s1", snapshotId, file: "a", side: "new", startLine: 0 },
      { command: "code", session: "s1", snapshotId, file: "a", side: "new", startLine: 1.5 },
      { command: "code", session: "s1", snapshotId, file: "a", side: "new", offset: -1 },
      {
        command: "code",
        session: "s1",
        snapshotId,
        file: "a",
        side: "new",
        startLine: 3,
        endLine: 2,
      },
      {
        command: "code",
        session: "s1",
        snapshotId,
        file: "a",
        side: "new",
        startLine: 1,
        offset: 0,
      },
    ])
      expect(() => decodeBrowserRequest(invalid)).toThrow();
  });

  it("exports the browser contracts through the public @gyst/core/wire subpath, shared with the root", () => {
    const browserContracts = [
      "BrowserRequestSchema",
      "OpenPayloadSchema",
      "ListPayloadSchema",
      "StatusPayloadSchema",
      "DiffPayloadSchema",
      "FilesPayloadSchema",
      "CodePayloadSchema",
      "CaptureProgressSchema",
      "pageBytes",
      "SourceCheckPayloadSchema",
      "DeletePayloadSchema",
      "ViewedPayloadSchema",
      "ReplySchema",
      "SessionVersionSchema",
      "SubscribeRequestSchema",
      "SubscriptionEventSchema",
      "ScopeSchema",
      "SessionSummarySchema",
      "HunkSchema",
      "MarkdownSchema",
      "CodeRangeSchema",
      "CapturedRangeSchema",
      "NoteSchema",
      "parseReferenceHref",
      "ErrorCodeSchema",
      "ErrorPayloadSchema",
      "DaemonError",
      "StaleRevision",
      "ValidationFailed",
      "NoSession",
      "DaemonUnreachable",
      "BadArgs",
      "InternalError",
    ] as const;
    const wireExports: Record<string, unknown> = { ...publicWire };
    const rootExports: Record<string, unknown> = { ...publicRoot };
    for (const name of browserContracts) {
      expect(wireExports[name], name).toBeDefined();
      // One schema object: the daemon and a browser validate with the same definition.
      expect(wireExports[name], name).toBe(rootExports[name]);
    }
    const scope: publicWire.Scope = { kind: "range", range: "main...feature" };
    const summary: publicWire.SessionSummary = {
      id: "s1",
      repoRoot: "/repo",
      scope,
      snapshotId: "snapshot",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const status: publicWire.StatusPayload = {
      session: summary,
      revision: 0,
      overview: null,
      groups: [],
      preparation: {
        state: "plain",
        groupedHunks: 0,
        totalHunks: 1,
        overviewMissing: true,
        groupsMissingOverview: [],
      },
      viewedHunkIds: [],
      files: [{ path: "a.ts", hunkCount: 1, viewed: false }],
    };
    expect(Schema.decodeUnknownSync(publicWire.StatusPayloadSchema, strict)(status)).toEqual(
      status,
    );
    for (const legacy of [{ seq: 0 }, { queue: [] }, { inbox: [] }, { ready: false }])
      expect(() =>
        Schema.decodeUnknownSync(publicWire.StatusPayloadSchema, strict)({ ...status, ...legacy }),
      ).toThrow();
    const error: publicWire.ErrorPayload = { code: "no_session", message: "gone" };
    expect(Schema.decodeUnknownSync(publicWire.ErrorPayloadSchema)(error)).toBeInstanceOf(
      publicWire.NoSession,
    );
  });

  it("stays importable by a browser: the public wire graph imports only effect", () => {
    const packageDir = new URL("../", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("package.json", packageDir), "utf8"));
    const external = new Set<string>();
    const seen = new Set<string>();
    const visit = (file: URL) => {
      if (seen.has(file.href)) return;
      seen.add(file.href);
      const source = readFileSync(file, "utf8");
      // Static imports and re-exports, including multi-line specifier lists.
      for (const [, from, bare] of source.matchAll(
        /^(?:import|export)\s[^;"]*?\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gm,
      )) {
        const specifier = (from ?? bare)!;
        if (specifier.startsWith(".")) visit(new URL(specifier, file));
        else external.add(specifier);
      }
    };
    visit(new URL(manifest.exports["./wire"], packageDir));
    expect([...seen].map((href) => href.slice(packageDir.href.length)).sort()).toEqual([
      "src/content.ts",
      "src/errors.ts",
      "src/guidance.ts",
      "src/metadata.ts",
      "src/session.ts",
      "src/wire.ts",
    ]);
    expect([...external]).toEqual(["effect"]);
  });

  it("frames subscriptions as versioned invalidations, not state or history", () => {
    const decodeEvent = Schema.decodeUnknownSync(publicWire.SubscriptionEventSchema, strict);
    const version = { sessionId: "s1", snapshotId: snapshotId, revision: 4 };
    for (const event of [
      { kind: "ready", daemon: "instance", ...version },
      { kind: "changed", ...version },
      { kind: "deleted", sessionId: "s1" },
    ])
      expect(decodeEvent(event)).toEqual(event);
    const failed = decodeEvent({ kind: "failed", error: { code: "no_session", message: "gone" } });
    expect(failed.kind === "failed" && failed.error).toBeInstanceOf(NoSession);
    for (const invalid of [
      { kind: "ready", ...version },
      { kind: "changed", ...version, viewedHunkIds: [] },
      { kind: "changed", sessionId: "s1" },
      { kind: "progress", ...version },
    ])
      expect(() => decodeEvent(invalid)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        publicWire.SubscribeRequestSchema,
        strict,
      )({
        session: "s1",
        cwd: "/repo",
      }),
    ).toThrow();
  });

  it("accepts both reply variants", () => {
    expect(decodeReply({ ok: true, value: {} })).toEqual({ ok: true, value: {} });
    const failed = decodeReply({ ok: false, error: { code: "bad_args", message: "bad request" } });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBeInstanceOf(BadArgs);
      expect(failed.error.message).toBe("bad request");
    }
  });

  it("keeps `code` on the wire for tagged errors", () => {
    expect(encodeError(new NoSession({ message: "gone" }))).toEqual({
      code: "no_session",
      message: "gone",
    });
    expect(JSON.stringify(encodeError(new BadArgs({ message: "x", detail: ["y"] })))).toBe(
      '{"code":"bad_args","message":"x","detail":["y"]}',
    );
  });
});
