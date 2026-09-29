import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { terminalProgress } from "./session.ts";

const stream = (isTTY: boolean | undefined) => {
  const written: string[] = [];
  return { isTTY, written, write: (text: string) => written.push(text) };
};

describe("terminalProgress", () => {
  it("rewrites one terminal line with real counts and clears it afterwards", () => {
    const tty = stream(true);
    const shown = terminalProgress(tty)!;
    Effect.runSync(shown.report({ phase: "capture", done: 3, total: 10, bytes: 1536 }));
    Effect.runSync(shown.report({ phase: "diff", done: 1, total: 2, bytes: 5 * 1024 * 1024 }));
    Effect.runSync(shown.clear);
    expect(tty.written).toEqual([
      "\r\x1b[Kgyst: Capturing files 3/10 (1.5 KiB captured)",
      "\r\x1b[Kgyst: Diffing changed files 1/2 (5.0 MiB captured)",
      "\r\x1b[K",
    ]);
    // Nothing shown, nothing to clear.
    const quiet = stream(true);
    Effect.runSync(terminalProgress(quiet)!.clear);
    expect(quiet.written).toEqual([]);
  });

  it("shows nothing when stderr is not a terminal, so agents and pipes are unaffected", () => {
    expect(terminalProgress(stream(false))).toBeUndefined();
    expect(terminalProgress(stream(undefined))).toBeUndefined();
  });
});
