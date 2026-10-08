import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import * as publicRoot from "@gyst/core";
import * as publicWire from "@gyst/core/wire";
import { BadArgs, ErrorPayloadSchema, NoSession, SourceUnavailable } from "./errors.ts";
import {
  BrowserRequestSchema,
  IdentifiersPayloadSchema,
  NavigationGapSchema,
  NavigationResultPayloadSchema,
  NavigationStatusPayloadSchema,
  ReplySchema,
  RequestSchema,
  TextRangeSchema,
} from "./wire.ts";

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
      { command: "open", cwd: "/repo", scope: { kind: "uncommitted" }, path: "/usr/bin:/bin" },
      { command: "open", session: "s1" },
      { command: "open", session: "s1", path: "" },
      { command: "list" },
      { command: "diff", session: "s1", file: "a.txt" },
      { command: "delete", session: "s1", requestId: "r1" },
      { command: "refresh", session: "s1", snapshotId, requestId: "r1" },
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
      { command: "open", session: "s1", path: ["/bin"] },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
  });

  const humanConversation = [
    {
      command: "draft",
      session: "s1",
      requestId: "r1",
      target: {
        kind: "comment",
        anchor: { snapshotId, path: "src/a.ts", side: "new", startLine: 2, endLine: 4 },
      },
    },
    {
      command: "send",
      session: "s1",
      requestId: "r2",
      draft: "d1",
      markdown: "Why?",
      kind: "question",
    },
    { command: "draft", session: "s1", requestId: "r3", target: { kind: "thread", thread: "t1" } },
    {
      command: "draft",
      session: "s1",
      requestId: "r4",
      target: { kind: "note", note: "n1" },
      wording: {
        markdown: "The note.",
        references: [],
        anchor: { snapshotId, path: "src/a.ts", side: "new", startLine: 2, endLine: 4 },
      },
    },
    {
      command: "edit",
      session: "s1",
      requestId: "r5",
      message: "m1",
      seen: { markdown: "Why?", kind: "question" },
      kind: "change",
    },
    {
      command: "retract",
      session: "s1",
      requestId: "r6",
      message: "m1",
      seen: { markdown: "Why?", kind: "question" },
    },
    {
      command: "resolve",
      session: "s1",
      requestId: "r7",
      thread: "t1",
      seen: "v1",
      resolved: false,
    },
    { command: "discard", session: "s1", requestId: "r8", draft: "d1" },
    { command: "conversations", session: "s1" },
    { command: "messages", session: "s1", thread: "t1" },
  ];

  it("keeps human and browser-only operations off the socket", () => {
    const target = { session: "s1", snapshotId, side: "new", file: "src/a.ts" };
    for (const browserOnly of [
      {
        command: "viewed",
        session: "s1",
        snapshotId,
        revision: 2,
        requestId: "r1",
        hunkIds: ["h1"],
        viewed: true,
      },
      { command: "layer", session: "s1", number: 3 },
      { command: "commits", session: "s1", snapshotId },
      { command: "commits", session: "s1", snapshotId, after: "a".repeat(40) },
      { command: "navigation", session: "s1", snapshotId },
      { command: "navigation", session: "s1", snapshotId, recheck: true },
      { command: "definition", ...target, position: { line: 1, character: 4 } },
      { command: "references", ...target, position: { line: 1, character: 4 } },
      { command: "identifiers", ...target, line: 3 },
      ...humanConversation,
    ]) {
      expect(decodeBrowserRequest(browserOnly)).toEqual(browserOnly);
      expect(() => decodeRequest(browserOnly)).toThrow();
    }
  });

  it("keeps the agent's thread retrieval off the browser, and human authority off both", () => {
    for (const retrieval of [
      { command: "threads", session: "s1", mode: "pending", requestId: "r1" },
      { command: "threads", session: "s1", mode: "open", requestId: "r1" },
    ]) {
      expect(decodeRequest(retrieval)).toEqual(retrieval);
      expect(() => decodeBrowserRequest(retrieval)).toThrow();
    }
    for (const invalid of [
      { command: "threads", session: "s1", mode: "pending" },
      { command: "threads", session: "s1", mode: "resolved", requestId: "r1" },
      { command: "threads", session: "s1", mode: "open", requestId: "r1", role: "human" },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
    for (const invalid of [
      // A message has no author field to forge, and a kind only of its own.
      { ...humanConversation[1], author: "agent" },
      { ...humanConversation[1], kind: "verdict" },
      { ...humanConversation[1], markdown: "  " },
      {
        command: "edit",
        session: "s1",
        requestId: "r1",
        message: "m1",
        seen: { markdown: "Why?", kind: "question" },
      },
      // An edit or deletion names the message as its author read it.
      { command: "edit", session: "s1", requestId: "r1", message: "m1", kind: "change" },
      { command: "retract", session: "s1", requestId: "r1", message: "m1" },
      // A resolution names the thread as its author read it.
      { command: "resolve", session: "s1", requestId: "r1", thread: "t1", resolved: true },
      { ...humanConversation[0], target: { kind: "group", group: "g1" } },
      { ...humanConversation[0], target: { kind: "overview" } },
      { ...humanConversation[0], target: { kind: "comment", anchor: { path: "a", side: "new" } } },
      { command: "resolve", session: "s1", thread: "t1", resolved: true },
    ])
      expect(() => decodeBrowserRequest(invalid)).toThrow();
  });

  it("previews and generates an export on both surfaces, generation only for a named approval", () => {
    for (const valid of [
      { command: "preview", session: "s1" },
      { command: "export", session: "s1", approval: "a".repeat(64) },
    ]) {
      expect(decodeRequest(valid)).toEqual(valid);
      expect(decodeBrowserRequest(valid)).toEqual(valid);
    }
    for (const invalid of [
      { command: "export", session: "s1" },
      { command: "export", session: "s1", approval: "a".repeat(64), output: "/tmp/x.html" },
      { command: "export", session: "s1", approval: "a".repeat(64), force: true },
      { command: "preview", session: "s1", group: "g1" },
    ]) {
      expect(() => decodeRequest(invalid)).toThrow();
      expect(() => decodeBrowserRequest(invalid)).toThrow();
    }
  });

  it("keeps checkout, Git, executable, authority and agent operations out of browser requests", () => {
    for (const valid of [
      { command: "list" },
      { command: "open", session: "s1" },
      { command: "status", session: "s1" },
      { command: "delete", session: "s1", requestId: "r1" },
      // A human refresh names the snapshot it replaces and a request id, like Viewed.
      { command: "refresh", session: "s1", snapshotId, requestId: "r1" },
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
      { command: "stack", session: "s1" },
      { command: "layer", session: "s1", number: 3 },
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
      { command: "refresh", session: "s1", snapshotId, requestId: "r1", cwd: "/repo" },
      { command: "refresh", session: "s1", snapshotId: "HEAD", requestId: "r1" },
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
      // A stack recheck names only the session; a layer only a PR number of that session's stack.
      { command: "stack", session: "s1", cwd: "/repo" },
      { command: "stack", session: "s1", repository: "acme/widgets" },
      { command: "layer", session: "s1" },
      { command: "layer", session: "s1", number: 0 },
      { command: "layer", session: "s1", number: 1.5 },
      { command: "layer", session: "s1", number: "3" },
      { command: "layer", session: "s1", number: 3, cwd: "/repo" },
      { command: "layer", session: "s1", number: 3, repository: "acme/gadgets" },
      { command: "layer", session: "s1", number: 3, repoRoot: "/repo" },
      { command: "layer", session: "s1", number: 3, path: "/repo" },
      {
        command: "layer",
        session: "s1",
        number: 3,
        scope: { kind: "pr", repository: "acme/widgets", number: 3 },
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
      // Commit messages are the snapshot's captured ones, never a revision read from Git.
      { command: "commits", session: "s1" },
      { command: "commits", session: "s1", snapshotId, after: "HEAD~1" },
      { command: "commits", session: "s1", snapshotId, range: "main..feature" },
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
      "CommitsPayloadSchema",
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
      "SourceUnavailable",
      "SourceUnavailableReasonSchema",
      "InternalError",
      "RepositorySchema",
      "PullRequestNumberSchema",
      "PullRequestScopeSchema",
      "parsePullRequestUrl",
      "pullRequestUrlOf",
      "PullRequestStateSchema",
      "PullRequestSchema",
      "StackLayerSchema",
      "StackMembershipSchema",
      "GitHubUnavailableReasonSchema",
      "PullRequestContextSchema",
      "PullRequestStatusSchema",
      "StackPayloadSchema",
      "AddonDiscoverySchema",
      "AddonStateSchema",
      "navigationAddon",
      "navigationInstallCommand",
      "TextPointSchema",
      "TextRangeSchema",
      "NavigationGapSchema",
      "NavigationLocationSchema",
      "NavigationUnavailableSchema",
      "NavigationResultPayloadSchema",
      "IdentifiersPayloadSchema",
      "NavigationSideStateSchema",
      "NavigationStatusPayloadSchema",
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
        overviewOutdated: false,
        groupsOutdated: [],
        notesOutdated: [],
      },
      viewedHunkIds: [],
      threads: { open: 0, resolved: 0, pending: 0 },
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
      "src/export.ts",
      "src/github.ts",
      "src/guidance.ts",
      "src/mapping.ts",
      "src/metadata.ts",
      "src/navigation.ts",
      "src/session.ts",
      "src/status.ts",
      "src/thread.ts",
      "src/wire.ts",
    ]);
    expect([...external]).toEqual(["effect"]);
  });

  it("frames subscriptions as versioned invalidations, not state or history", () => {
    const decodeEvent = Schema.decodeUnknownSync(publicWire.SubscriptionEventSchema, strict);
    const version = { sessionId: "s1", snapshotId: snapshotId, revision: 4, conversations: "v1" };
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

  it("names text points by 1-based line and UTF-16 character, and navigation gaps by kind", () => {
    const decodeRange = Schema.decodeUnknownSync(TextRangeSchema, strict);
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 3 } };
    expect(decodeRange(range)).toEqual(range);
    for (const start of [{ line: 0, character: 0 }, { line: 1, character: -1 }, { line: 1 }])
      expect(() => decodeRange({ ...range, start })).toThrow();

    const decodeGap = Schema.decodeUnknownSync(NavigationGapSchema, strict);
    for (const gap of [
      { kind: "dependencies", file: "package.json" },
      { kind: "uncaptured", file: "src/link.ts", reason: "symlink" },
      { kind: "uncaptured", file: "vendor", reason: "submodule" },
      { kind: "no-project-config" },
      { kind: "unresolved-import", file: "src/a.ts", message: "Cannot find module './gen'" },
    ])
      expect(decodeGap(gap)).toEqual(gap);
    for (const gap of [
      { kind: "dependencies", file: "../package.json" },
      { kind: "uncaptured", file: "a.ts", reason: "ignored" },
      { kind: "no-project-config", file: "/tmp/x" },
      { kind: "complete" },
    ])
      expect(() => decodeGap(gap)).toThrow();
  });

  it("lets browsers name a navigation target but never an add-on, executable or PATH", () => {
    const addon = {
      kind: "available",
      entry: "/opt/bin/gyst-navigation-typescript",
      version: "1.0.0",
    };
    const target = { session: "s1", snapshotId, side: "new", file: "src/a.ts" };
    const position = { line: 1, character: 4 };
    // Browsers name only the target: the daemon finds the add-on, which they cannot express.
    const browserValid = [
      { command: "definition", ...target, position },
      { command: "references", ...target, side: "old", position },
      { command: "identifiers", ...target, line: 3 },
      { command: "navigation", session: "s1", snapshotId },
      { command: "navigation", session: "s1", snapshotId, recheck: true },
    ];
    for (const valid of browserValid) expect(decodeBrowserRequest(valid)).toEqual(valid);
    for (const valid of browserValid) {
      expect(() => decodeBrowserRequest({ ...valid, addon })).toThrow();
      expect(() => decodeBrowserRequest({ ...valid, entry: "/bin/sh" })).toThrow();
      expect(() => decodeBrowserRequest({ ...valid, path: "/tmp" })).toThrow();
    }
    for (const invalid of [
      { command: "definition", ...target, file: "/etc/passwd", position },
      { command: "identifiers", ...target, line: 0 },
      { command: "navigation", session: "s1" },
      { command: "navigation", session: "s1", snapshotId, recheck: "yes" },
      { command: "open", session: "s1", path: "/tmp" },
    ])
      expect(() => decodeBrowserRequest(invalid)).toThrow();
  });

  it("reports navigation readiness per side without host paths", () => {
    const decodeStatus = Schema.decodeUnknownSync(NavigationStatusPayloadSchema, strict);
    const install = "npm install -g @gyst/navigation-typescript@1.0.0";
    const gaps = [{ kind: "no-project-config" }];
    for (const [old, current] of [
      [{ kind: "stopped" }, { kind: "queued" }],
      [{ kind: "preparing" }, { kind: "ready", files: 3, bytes: 120, gaps }],
      [
        { kind: "unavailable", reason: { kind: "historical" } },
        { kind: "unavailable", reason: { kind: "engine", message: "stopped" } },
      ],
    ]) {
      const payload = {
        sessionId: "s1",
        snapshotId,
        addon: { kind: "missing", install },
        sides: { old, new: current },
      };
      expect(decodeStatus(payload)).toEqual(payload);
    }
    const ready = { sessionId: "s1", snapshotId, addon: { kind: "available", version: "1.0.0" } };
    for (const invalid of [
      { ...ready, sides: { old: { kind: "stopped" } } },
      {
        ...ready,
        sides: { old: { kind: "stopped" }, new: { kind: "ready", files: -1, bytes: 0, gaps } },
      },
      { ...ready, sides: { old: { kind: "stopped" }, new: { kind: "ready", files: 1, bytes: 1 } } },
      { ...ready, sides: { old: { kind: "stopped" }, new: { kind: "stopped", dir: "/tmp/x" } } },
      {
        ...ready,
        addon: { kind: "available", version: "1.0.0", entry: "/opt/gyst-navigation-typescript" },
        sides: { old: { kind: "stopped" }, new: { kind: "stopped" } },
      },
    ])
      expect(() => decodeStatus(invalid)).toThrow();
  });

  it("restates query identity in navigation results and names only captured locations", () => {
    const decodeResult = Schema.decodeUnknownSync(NavigationResultPayloadSchema, strict);
    const range = { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } };
    const identity = {
      sessionId: "s1",
      snapshotId,
      side: "old",
      file: "src/a.ts",
      query: "references",
      position: range.start,
    };
    for (const outcome of [
      {
        kind: "locations",
        symbol: { text: "add", range },
        locations: [{ file: "src/b.ts", range }],
        outside: 2,
        gaps: [{ kind: "no-project-config" }],
      },
      { kind: "no-symbol" },
      { kind: "unavailable", reason: { kind: "historical" } },
      { kind: "unavailable", reason: { kind: "not-source", detail: "no old side" } },
      { kind: "unavailable", reason: { kind: "engine", message: "exited" } },
      {
        kind: "unavailable",
        reason: { kind: "addon", addon: { kind: "missing", install: "npm install -g x@1" } },
      },
    ])
      expect(decodeResult({ ...identity, outcome })).toEqual({ ...identity, outcome });
    const located = {
      kind: "locations",
      symbol: { text: "add", range },
      locations: [],
      outside: 0,
      gaps: [],
    };
    for (const invalid of [
      { ...identity, outcome: { ...located, locations: [{ file: "/etc/passwd", range }] } },
      { ...identity, outcome: { ...located, locations: [{ uri: "file:///etc/passwd", range }] } },
      { ...identity, outcome: { ...located, outside: -1 } },
      { ...identity, query: "hover", outcome: located },
      // The browser view of the add-on never carries its host path.
      {
        ...identity,
        outcome: {
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "available", version: "1", entry: "/x" } },
        },
      },
    ])
      expect(() => decodeResult(invalid)).toThrow();

    const decodeIdentifiers = Schema.decodeUnknownSync(IdentifiersPayloadSchema, strict);
    const line = { sessionId: "s1", snapshotId, side: "new", file: "src/a.ts", line: 2 };
    const identifiers = {
      ...line,
      outcome: { kind: "identifiers", identifiers: [{ text: "first", range }], gaps: [] },
    };
    expect(decodeIdentifiers(identifiers)).toEqual(identifiers);
    expect(() => decodeIdentifiers({ ...identifiers, line: 0 })).toThrow();
    expect(() => decodeIdentifiers({ ...line, outcome: { kind: "no-symbol" } })).toThrow();
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

  it("round-trips a source_unavailable reason and diagnostic, rejecting unknown reasons", () => {
    const unavailable = new SourceUnavailable({
      message: "run gh auth login",
      detail: { reason: "gh_unauthenticated", diagnostic: "gh: Bad credentials (HTTP 401)" },
    });
    const encoded = encodeError(unavailable);
    expect(encoded).toEqual({
      code: "source_unavailable",
      message: "run gh auth login",
      detail: { reason: "gh_unauthenticated", diagnostic: "gh: Bad credentials (HTTP 401)" },
    });
    const decoded = Schema.decodeUnknownSync(ErrorPayloadSchema)(
      JSON.parse(JSON.stringify(encoded)),
    );
    expect(decoded).toBeInstanceOf(SourceUnavailable);
    expect(decoded).toMatchObject({ message: unavailable.message, detail: unavailable.detail });
    for (const detail of [undefined, { reason: "offline" }, {}])
      expect(() =>
        Schema.decodeUnknownSync(ErrorPayloadSchema)({
          code: "source_unavailable",
          message: "m",
          detail,
        }),
      ).toThrow();
  });
});
