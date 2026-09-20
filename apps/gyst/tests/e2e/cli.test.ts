import { describe, expect, it } from "bun:test";
import { join } from "node:path";

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
});
