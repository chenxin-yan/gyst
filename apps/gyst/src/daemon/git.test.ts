import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "./git.ts";

let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function repo(name: string, commit = true): Promise<string> {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@gyst.invalid");
  git(cwd, "config", "user.name", "Gyst Test");
  if (commit) {
    await writeFile(join(cwd, "tracked.txt"), "one\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial");
  }
  return cwd;
}

const run = <A, E>(effect: Effect.Effect<A, E, Git>) =>
  Effect.runPromise(Effect.provide(effect, Git.layer.pipe(Layer.provide(NodeServices.layer))));

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "gyst-git-")));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("Git", () => {
  it("resolves the real repository root and rejects directories outside a repository", async () => {
    const cwd = await repo("root");
    await mkdir(join(cwd, "nested", "deep"), { recursive: true });
    expect(await run(Git.use((g) => g.repoRoot(join(cwd, "nested", "deep"))))).toBe(cwd);
    const outside = await mkdtemp(join(tmpdir(), "gyst-not-a-repo-"));
    const error = await run(Effect.flip(Git.use((g) => g.repoRoot(outside))));
    expect(error._tag).toBe("bad_args");
    await rm(outside, { recursive: true, force: true });
  });

  it("captures HEAD against the working tree plus untracked files, running no configured programs", async () => {
    const cwd = await repo("uncommitted");
    const marker = join(cwd, "..", "uncommitted-ran");
    const script = join(root, "record.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`, { mode: 0o755 });
    git(cwd, "config", "color.ui", "always");
    git(cwd, "config", "diff.external", script);
    git(cwd, "config", "diff.recorded.textconv", script);
    git(cwd, "config", "diff.relative", "true");
    await writeFile(join(cwd, ".gitattributes"), "*.txt diff=recorded\n");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "tracked.txt"), "colored\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    await writeFile(join(cwd, "sub", "inner.txt"), "inner\n");
    const patch = await run(Git.use((g) => g.capture(cwd, { kind: "uncommitted" })));
    expect(patch).toContain("@@ -1 +1 @@\n-one\n+colored\n");
    expect(patch.match(/^\+\+\+ (.*)$/gm)).toEqual([
      "+++ b/tracked.txt",
      "+++ b/.gitattributes",
      "+++ b/sub/inner.txt",
      "+++ b/untracked.txt",
    ]);
    expect(patch).not.toContain("\u001b[");
    expect(existsSync(marker)).toBe(false);
  });

  it("diffs against the empty tree in a repository without HEAD", async () => {
    const cwd = await repo("unborn", false);
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");
    const patch = await run(Git.use((g) => g.capture(cwd, { kind: "uncommitted" })));
    expect(patch).toContain("+++ b/staged.txt");
    expect(patch).toContain("+++ b/untracked.txt");
  });

  it("resolves two- and three-dot ranges at capture, excluding the working tree", async () => {
    const cwd = await repo("range");
    git(cwd, "branch", "-M", "main");
    git(cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "feature.txt"), "feature\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "feature");
    git(cwd, "switch", "-q", "main");
    await writeFile(join(cwd, "tracked.txt"), "main moved\n");
    git(cwd, "commit", "-qam", "main");
    await writeFile(join(cwd, "tracked.txt"), "uncommitted\n");
    const files = async (range: string) =>
      (await run(Git.use((g) => g.capture(cwd, { kind: "range", range })))).match(
        /^\+\+\+ (.*)$/gm,
      );
    expect(await files("main...feature")).toEqual(["+++ b/feature.txt"]);
    expect(await files("main..feature")).toEqual(["+++ b/feature.txt", "+++ b/tracked.txt"]);
    // An omitted endpoint is HEAD, as in Git.
    expect(await files("feature...")).toEqual(["+++ b/tracked.txt"]);
    git(cwd, "checkout", "--", "tracked.txt");
    git(cwd, "switch", "-q", "feature");
    await writeFile(join(cwd, "feature.txt"), "feature moved\n");
    git(cwd, "commit", "-qam", "feature moved");
    const moved = await run(
      Git.use((g) => g.capture(cwd, { kind: "range", range: "main...feature" })),
    );
    expect(moved).toContain("+feature moved");
  });

  it("rejects ranges that are not ranges, name unknown revisions, or look like options", async () => {
    const cwd = await repo("range-input");
    const written = join(root, "range-output");
    for (const [range, message] of [
      ["HEAD", "expected a Git range"],
      ["HEAD..HEAD -- tracked.txt", "expected a Git range"],
      [`--output=${written}..HEAD`, "expected a Git range"],
      [`HEAD..--output=${written}`, "expected a Git range"],
      ["HEAD..no-such-rev", "unknown revision in range: no-such-rev"],
      ["HEAD:tracked.txt..HEAD", "unknown revision in range: HEAD:tracked.txt"],
    ] as const) {
      const error = await run(
        Effect.flip(Git.use((g) => g.capture(cwd, { kind: "range", range }))),
      );
      expect(error).toMatchObject({ _tag: "bad_args", message: expect.stringContaining(message) });
    }
    expect(existsSync(written)).toBe(false);
  });
});
