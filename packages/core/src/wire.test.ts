import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { BadArgs, ErrorPayloadSchema, NoSession } from "./errors.ts";
import { ReplySchema, RequestSchema } from "./wire.ts";

const decodeRequest = Schema.decodeUnknownSync(RequestSchema);
const decodeReply = Schema.decodeUnknownSync(ReplySchema);
const encodeError = Schema.encodeSync(ErrorPayloadSchema);

describe("daemon wire envelopes", () => {
  it("rejects request and reply shape drift", () => {
    expect(() => decodeRequest({ command: "unknown", cwd: "/repo" })).toThrow();
    expect(() => decodeReply({ ok: true, payload: {} })).toThrow();
    expect(() => decodeReply({ ok: false, error: { message: "missing code" } })).toThrow();
    expect(() => decodeReply({ ok: false, error: { _tag: "bad_args", message: "x" } })).toThrow();
  });

  it("carries command-specific operations, never argv", () => {
    const create = {
      command: "create",
      cwd: "/repo",
      revisions: ["HEAD"],
      pathspecs: ["a.txt"],
    } as const;
    expect(decodeRequest(create)).toEqual(create);
    const diff = { command: "diff", cwd: "/repo", session: "s1", file: "a.txt" } as const;
    expect(decodeRequest(diff)).toEqual(diff);
    for (const invalid of [
      { command: "create", cwd: "/repo", args: ["--", "HEAD"] },
      { command: "create", cwd: "/repo", revisions: "HEAD" },
      { command: "apply", cwd: "/repo", stdin: "{}" },
    ])
      expect(() => decodeRequest(invalid)).toThrow();
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
