import { describe, expect, it } from "bun:test";
import { Crust } from "@crustjs/core";
import { buildCommandDocumentation } from "@crustjs/core/tooling";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { app, jsonErrors } from "./app.ts";

async function execute(argv: string[]): Promise<string> {
  const output: string[] = [];
  await app.execute({ argv, io: { stdout: (line) => output.push(line) } });
  return output.join("\n");
}

describe("crust command help", () => {
  it("describes the root, session, and skill command tree", async () => {
    const snapshot = await app.snapshot();
    expect(buildCommandDocumentation(snapshot).children.map(({ name }) => name)).toEqual([
      "session",
      "skill",
    ]);
    expect(await execute(["--help"])).toContain("Commands:");
    expect(await execute(["--help"])).toContain("Agent skills");
    expect(await execute(["session", "--help"])).toContain("gyst session");
    expect(await execute(["session", "create", "--help"])).toContain("gyst session create");
  });

  it("reports the package version in root metadata and CLI output", async () => {
    expect((await app.snapshot()).meta.version).toBe(packageJson.version);
    expect(await execute(["--version"])).toBe(`gyst v${packageJson.version}`);
  });
});

describe("tui entry", () => {
  it("refuses to run the TUI without a TTY", async () => {
    const child = Bun.spawn(["bun", "src/index.tsx"], { cwd: join(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({ code: "bad_args", message: "TUI requires an interactive terminal (TTY)." });
  });

  it("exits 130 silently when the TUI is cancelled", async () => {
    const stderr: string[] = [];
    const cancelled = new Crust("cancelled").extend(jsonErrors).action(() => {
      throw Object.assign(new Error("TUI cancelled"), { name: "AbortError" });
    });
    try {
      expect(await cancelled.execute({ argv: [], io: { stderr: (line) => stderr.push(line) } })).toBe(130);
    } finally { process.exitCode = 0; } // crust sets the runner's exitCode; Bun ignores assigning undefined
    expect(stderr).toEqual([]);
  });
});
