import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("core types allow ECMAScript but reject ambient I/O", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "gyst-core-types-"));
  const root = join(import.meta.dir, "..");
  try {
    await writeFile(
      join(fixture, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, "packages/core/tsconfig.json"),
        include: ["probe.ts"],
      }),
    );
    await writeFile(
      join(fixture, "probe.ts"),
      [
        "export const values = new Map<string, Promise<number>>();",
        'fetch("https://example.com");',
        "new XMLHttpRequest();",
        'new WebSocket("wss://example.com");',
      ].join("\n"),
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      join(fixture, "tsconfig.json"),
      "--pretty",
      "false",
    ]);
    expect(result.exitCode).toBe(1);
    const output = result.stdout.toString();
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket"]) {
      expect(output).toContain(`Cannot find name '${name}'`);
    }
    expect(output.match(/error TS/g)).toHaveLength(3);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
