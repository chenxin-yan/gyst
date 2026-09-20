import { describe, expect, it } from "bun:test";
import { Crust } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { NoSession } from "@gyst/core";
import { Effect } from "effect";
import { jsonErrors } from "./json-errors.ts";

// Runs a one-action app whose only extension is `jsonErrors`, capturing stderr.
async function run(action: Parameters<Crust["action"]>[0], argv: string[] = []) {
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    const exitCode = await new Crust("failing")
      .extend(jsonErrors)
      .action(action)
      .execute({ argv, io: { stderr: (line) => stderr.push(line) } });
    return { exitCode, stderr };
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
}

describe("jsonErrors", () => {
  it("keeps a domain error's code, message and detail", async () => {
    const { exitCode, stderr } = await run(
      handler(() => new NoSession({ message: "none here", detail: { cwd: "/x" } })),
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr[0]!)).toEqual({
      code: "no_session",
      message: "none here",
      detail: { cwd: "/x" },
    });
  });

  it("reports crust's own parse verdicts as bad_args", async () => {
    const { exitCode, stderr } = await run(() => undefined, ["--no-such-flag"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr[0]!)).toEqual({
      code: "bad_args",
      message: expect.stringContaining("no-such-flag"),
    });
  });

  it("reports a defect as internal_error rather than blaming the caller", async () => {
    const { exitCode, stderr } = await run(
      handler(() => Effect.die(new TypeError("broken invariant"))),
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr[0]!)).toEqual({ code: "internal_error", message: "broken invariant" });
  });

  it("exits 130 silently when the action is cancelled", async () => {
    const { exitCode, stderr } = await run(() => {
      throw Object.assign(new Error("TUI cancelled"), { name: "AbortError" });
    });
    expect(exitCode).toBe(130);
    expect(stderr).toEqual([]);
  });
});
