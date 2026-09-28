import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { BadArgs, ErrorPayloadSchema, NoSession } from "./errors.ts";
import { BrowserRequestSchema, ReplySchema, RequestSchema } from "./wire.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeRequest = Schema.decodeUnknownSync(RequestSchema, strict);
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
    ])
      expect(() => decodeBrowserRequest(invalid)).toThrow();
  });

  it("stays importable by a browser: the wire schema graph has no Node built-ins", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const [, specifier] of source.matchAll(/^import[^"]*"([^"]+)";$/gm)) {
        expect(specifier).not.toMatch(/^node:/);
        if (specifier!.startsWith("./")) visit(specifier!);
      }
    };
    visit("./wire.ts");
    expect(seen).toContain("./session.ts");
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
