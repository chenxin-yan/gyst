import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Crust } from "@crustjs/core";
import { buildCommandDocumentation } from "@crustjs/core/tooling";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { app } from "./app.ts";
import { jsonErrors } from "./extensions/json-errors.ts";
import { isolatedHome } from "./test-env.ts";

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

describe("crust command help", () => {
  it("describes the root, session, and skills command tree", async () => {
    const snapshot = await app.snapshot();
    expect(buildCommandDocumentation(snapshot).children.map(({ name }) => name)).toEqual([
      "session",
      "skills",
    ]);
    const help = (await execute(["--help"])).stdout;
    expect(help).toContain("Commands:");
    expect(help).toContain("Agent skills");
    expect(help).not.toContain("daemon");
    expect((await execute(["session", "--help"])).stdout).toContain("gyst session");
    expect((await execute(["session", "create", "--help"])).stdout).toContain(
      "gyst session create",
    );
  }, 20_000);

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
    const { exitCode, stderr } = await execute([]);
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
