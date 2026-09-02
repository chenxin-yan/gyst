import { describe, expect, it } from "bun:test";

import packageJson from "../../package.json" with { type: "json" };
import { app } from "./app.ts";

async function execute(argv: string[]): Promise<string> {
  const output: string[] = [];
  await app.execute({ argv, io: { stdout: (line) => output.push(line) } });
  return output.join("\n");
}

describe("crust command help", () => {
  it("describes the root and session command tree", async () => {
    expect(await execute(["--help"])).toContain("Commands:");
    expect(await execute(["session", "--help"])).toContain("gyst session");
    expect(await execute(["session", "create", "--help"])).toContain("gyst session create");
  });

  it("reports the package version in root metadata and CLI output", async () => {
    expect((await app.snapshot()).meta.version).toBe(packageJson.version);
    expect(await execute(["--version"])).toBe(`gyst v${packageJson.version}`);
  });
});
