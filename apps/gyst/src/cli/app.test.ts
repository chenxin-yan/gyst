import { describe, expect, it } from "bun:test";

import { app } from "./app.ts";

async function help(path: [] | ["session"]): Promise<string> {
  const output: string[] = [];
  await app.run(path, { flags: { help: true } }, { stdout: (line) => output.push(line) });
  return output.join("\n");
}

describe("crust command help", () => {
  it("describes the root and session command tree", async () => {
    expect(await help([])).toContain("Commands:\n  session");
    expect(await help(["session"])).toContain("Usage:\n  gyst session [options]");
  });
});
