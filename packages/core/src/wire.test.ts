import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { BadArgs, ErrorPayloadSchema, NoSession } from "./errors.ts";
import { ReplySchema, RequestSchema } from "./wire.ts";

const decodeRequest = Schema.decodeUnknownSync(RequestSchema);
const decodeReply = Schema.decodeUnknownSync(ReplySchema);
const encodeError = Schema.encodeSync(ErrorPayloadSchema);

describe("daemon wire envelopes", () => {
  it("rejects request and reply shape drift", () => {
    expect(() => decodeRequest({ command: "unknown", cwd: "/repo", args: [] })).toThrow();
    expect(() => decodeReply({ ok: true, payload: {} })).toThrow();
    expect(() => decodeReply({ ok: false, error: { message: "missing code" } })).toThrow();
    expect(() => decodeReply({ ok: false, error: { _tag: "bad_args", message: "x" } })).toThrow();
  });

  it("accepts typed human actions", () => {
    const request = {
      command: "tui.action",
      cwd: "/repo",
      args: [],
      action: { type: "cursor.focus", itemId: "g1", pane: "queue", hunkId: "h1" },
    } as const;
    expect(decodeRequest(request)).toEqual(request);
    expect(() =>
      decodeRequest({
        command: "tui.action",
        cwd: "/repo",
        args: [],
        action: { type: "cursor.move" },
      }),
    ).toThrow();
    // A verdict must name the frame the human saw.
    expect(() =>
      decodeRequest({
        command: "tui.action",
        cwd: "/repo",
        args: [],
        action: { type: "verdict.toggle", itemId: "g1" },
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
