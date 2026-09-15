import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { ReplySchema, RequestSchema } from "../src/index.ts";

const decodeRequest = Schema.decodeUnknownSync(RequestSchema);
const decodeReply = Schema.decodeUnknownSync(ReplySchema);

describe("daemon wire envelopes", () => {
  it("rejects request and reply shape drift", () => {
    expect(() => decodeRequest({ command: "unknown", cwd: "/repo", args: [] })).toThrow();
    expect(() => decodeReply({ ok: true, payload: {} })).toThrow();
    expect(() => decodeReply({ ok: false, error: { message: "missing code" } })).toThrow();
  });

  it("accepts typed human actions", () => {
    expect(
      decodeRequest({
        command: "tui.action",
        cwd: "/repo",
        args: [],
        action: { type: "expand.toggle" },
      }),
    ).toEqual({
      command: "tui.action",
      cwd: "/repo",
      args: [],
      action: { type: "expand.toggle" },
    });
  });

  it("accepts both reply variants", () => {
    expect(decodeReply({ ok: true, value: {} })).toEqual({ ok: true, value: {} });
    expect(decodeReply({ ok: false, error: { code: "bad_args", message: "bad request" } })).toEqual(
      {
        ok: false,
        error: { code: "bad_args", message: "bad request" },
      },
    );
  });
});
