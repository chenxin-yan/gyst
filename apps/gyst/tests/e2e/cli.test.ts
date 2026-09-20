import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { isolatedHome } from "./isolated-home.ts";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "gyst-app-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// Runs the real app as a subprocess so skill auto-repair sees the isolated home, never the host's.
async function execute(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(["bun", "src/index.tsx", ...argv], {
    cwd: join(import.meta.dir, "../.."),
    env: isolatedHome(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("gyst CLI", () => {
  it("prints help for the root and session commands without the hidden daemon", async () => {
    const help = (await execute(["--help"])).stdout;
    expect(help).toContain("Commands:");
    expect(help).toContain("Agent skills");
    expect(help).not.toContain("daemon");
    expect((await execute(["session", "--help"])).stdout).toContain("gyst session");
    expect((await execute(["session", "create", "--help"])).stdout).toContain(
      "gyst session create",
    );
  }, 20_000);

  it("reports the package version", async () => {
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

  it("refuses to run the TUI without a TTY", async () => {
    const { exitCode, stderr } = await execute([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      code: "bad_args",
      message: "TUI requires an interactive terminal (TTY).",
    });
  });
});
