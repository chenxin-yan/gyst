import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "./git.ts";

let root: string;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

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
  Effect.runPromise(Effect.provide(effect, Git.layer.pipe(Layer.provide(BunServices.layer))));

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

  it("diffs HEAD plus untracked files for the bare scope, ignoring presentation config", async () => {
    const cwd = await repo("bare");
    git(cwd, "config", "color.ui", "always");
    git(cwd, "config", "diff.external", "/bin/false");
    await writeFile(join(cwd, "tracked.txt"), "colored\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    const patch = await run(Git.use((g) => g.patch(cwd, cwd, [], true)));
    expect(patch).toContain("@@ -1 +1 @@\n-one\n+colored\n");
    expect(patch).toContain("+++ b/untracked.txt");
    expect(patch).not.toContain("\u001b[");
    const tracked = await run(Git.use((g) => g.patch(cwd, cwd, [], false)));
    expect(tracked).not.toContain("untracked.txt");
  });

  it("runs the bare scope from the root so diff.relative cannot hide changes outside cwd", async () => {
    const cwd = await repo("relative");
    git(cwd, "config", "diff.relative", "true");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "sub", "inner.txt"), "inner\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "sub");
    await writeFile(join(cwd, "tracked.txt"), "changed at root\n");
    await writeFile(join(cwd, "sub", "inner.txt"), "changed in sub\n");
    const patch = await run(Git.use((g) => g.patch(cwd, join(cwd, "sub"), [], false)));
    expect(patch.match(/^\+\+\+ (.*)$/gm)).toEqual(["+++ b/sub/inner.txt", "+++ b/tracked.txt"]);
  });

  it("diffs against the empty tree in a repository without HEAD", async () => {
    const cwd = await repo("unborn", false);
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");
    const patch = await run(Git.use((g) => g.patch(cwd, cwd, [], true)));
    expect(patch).toContain("+++ b/staged.txt");
    expect(patch).toContain("+++ b/untracked.txt");
  });

  it("runs explicit revisions and pathspecs from the caller's directory", async () => {
    const cwd = await repo("pathspec");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "same.txt"), "root\n");
    await writeFile(join(cwd, "sub", "same.txt"), "sub\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "two files");
    await writeFile(join(cwd, "same.txt"), "root changed\n");
    await writeFile(join(cwd, "sub", "same.txt"), "sub changed\n");
    const patch = await run(
      Git.use((g) => g.patch(cwd, join(cwd, "sub"), ["HEAD", "--", "same.txt"], false)),
    );
    expect(patch.match(/^\+\+\+ (.*)$/gm)).toEqual(["+++ b/sub/same.txt"]);
    const error = await run(Effect.flip(Git.use((g) => g.patch(cwd, cwd, ["no-such-rev"], false))));
    expect(error._tag).toBe("bad_args");
    expect(error.message).toContain("no-such-rev");
  });
});
