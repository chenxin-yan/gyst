import { describe, expect, it } from "bun:test";
import { Result } from "effect";
import { parseSnapshot } from "./snapshot.ts";

const hunks = (patch: string) => Result.getOrThrow(parseSnapshot(patch));
const rejection = (patch: string) => Result.getOrThrow(Result.flip(parseSnapshot(patch)));

describe("parseSnapshot", () => {
  it("preserves hunk text and stable ids across multi-file, multi-hunk patches", () => {
    const patch = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-alpha
+ALPHA
 bravo
@@ -5,2 +5,2 @@
-echo
+ECHO
 foxtrot
diff --git a/b.txt b/b.txt
index 1234567..89abcde 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-xray
+XRAY
`;
    const parsed = hunks(patch);
    expect(parsed.map((hunk) => hunk.file)).toEqual(["a.txt", "a.txt", "b.txt"]);
    expect(parsed.map((hunk) => hunk.patch)).toEqual([
      expect.stringContaining("-alpha"),
      expect.stringContaining("-echo"),
      expect.stringContaining("-xray"),
    ]);
    const ids = parsed.map((hunk) => hunk.id);
    expect(new Set(ids).size).toBe(3);
    expect(hunks(patch).map((hunk) => hunk.id)).toEqual(ids);
  });

  it("extracts plain unified hunks by line counts, including header-like content and EOF markers", () => {
    const bodies = [
      "@@ -1,2 +1,2 @@\n--- old content\n+++ new content\n context",
      "@@ -8 +8 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
      "@@ -0,0 +1 @@\n+added\n\\ No newline at end of file",
    ];
    const patch = `--- a/a.txt\n+++ b/a.txt\n${bodies[0]}\n${bodies[1]}\n--- /dev/null\n+++ b/b.txt\n${bodies[2]}\n`;
    expect(hunks(patch).map((hunk) => hunk.patch)).toEqual(bodies);
  });

  it("rejects file-only changes and non-diff input as bad_args", () => {
    const modeOnly = `diff --git a/tracked.txt b/tracked.txt
old mode 100644
new mode 100755
`;
    expect(rejection(modeOnly)._tag).toBe("bad_args");
    expect(rejection("just some text\n").detail).toBe("input is not a unified diff");
    expect(hunks("")).toEqual([]);
  });

  it("rejects malformed hunks as bad_args instead of throwing", () => {
    const truncated = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n";
    const rejected = rejection(truncated);
    expect(rejected._tag).toBe("bad_args");
    expect(rejected.message).toBe("invalid unified diff");
    expect(rejected.detail).toBe("parsePatchContent: hunk line count mismatch");
  });
});
