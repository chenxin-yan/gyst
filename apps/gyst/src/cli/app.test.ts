import { describe, expect, it } from "bun:test";

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

  it("reports the package version", async () => {
    expect(await execute(["--version"])).toBe("gyst v0.0.0");
  });
});
