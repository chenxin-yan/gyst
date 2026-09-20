import { describe, expect, it } from "bun:test";
import { Crust } from "@crustjs/core";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { app } from "./app.ts";
import { jsonErrors } from "./extensions/json-errors.ts";

async function execute(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  const exitCode = await app.execute({
    argv,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  });
  // execute() sets the exit status for the real CLI; the test runner keeps its own.
  process.exitCode = previousExitCode ?? 0;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

describe("crust command help", () => {
  it("describes the root and session command tree", async () => {
    expect((await execute(["--help"])).stdout).toContain("Commands:");
    expect((await execute(["session", "--help"])).stdout).toContain("gyst session");
    expect((await execute(["session", "create", "--help"])).stdout).toContain(
      "gyst session create",
    );
    expect((await execute(["--help"])).stdout).not.toContain("daemon");
  });

  it("reports the package version in root metadata and CLI output", async () => {
    expect((await app.snapshot()).meta.version).toBe(packageJson.version);
    expect((await execute(["--version"])).stdout).toBe(`gyst v${packageJson.version}`);
  });

  it("rejects stray root positionals through the JSON error contract", async () => {
    const result = await execute(["sesion"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      code: "bad_args",
      message: expect.stringContaining("sesion"),
    });
  });
});

describe("tui entry", () => {
  it("refuses to run the TUI without a TTY", async () => {
    const child = Bun.spawn(["bun", "src/index.tsx"], {
      cwd: join(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      code: "bad_args",
      message: "TUI requires an interactive terminal (TTY).",
    });
  });

  it("exits 130 silently when the TUI is cancelled", async () => {
    const stderr: string[] = [];
    const cancelled = new Crust("cancelled").extend(jsonErrors).action(() => {
      throw Object.assign(new Error("TUI cancelled"), { name: "AbortError" });
    });
    const previousExitCode = process.exitCode;
    try {
      expect(
        await cancelled.execute({ argv: [], io: { stderr: (line) => stderr.push(line) } }),
      ).toBe(130);
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
    expect(stderr).toEqual([]);
  });
});
