import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

let root: string;
let home: string;
let env: Record<string, string | undefined>;
const appDir = join(import.meta.dir, "../..");
const source = resolve(appDir, "../../skills/gyst");

async function gyst(...args: string[]) {
  const child = Bun.spawn(["bun", "src/index.tsx", ...args], {
    cwd: appDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`gyst ${args.join(" ")} failed (${exitCode}):\n${stdout}\n${stderr}`);
  return { stdout, stderr };
}

async function expectLink(path: string, target = source) {
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(resolve(dirname(path), await readlink(path))).toBe(target);
  expect(await readFile(join(path, "SKILL.md"), "utf8")).toContain("# Gyst co-review");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gyst-skill-"));
  home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const claude = join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n");
  await chmod(claude, 0o755);
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gyst skill installer", () => {
  it("installs the authored /gyst skill for universal and Claude harnesses", async () => {
    await gyst("skill", "--all");

    await expectLink(join(home, ".agents", "skills", "gyst"));
    await expectLink(join(home, ".claude", "skills", "gyst"));
  });

  it("repairs version-stale links explicitly and before ordinary commands", async () => {
    const stale = join(root, "v1", "skills", "gyst");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "---\nname: gyst\ndescription: old\n---\n");
    const universal = join(home, ".agents", "skills", "gyst");
    const claude = join(home, ".claude", "skills", "gyst");

    await rm(universal);
    await rm(claude);
    await symlink(stale, universal);
    await symlink(stale, claude);
    await gyst("skill", "update", "--scope", "global");
    await expectLink(universal);
    await expectLink(claude);

    await rm(universal);
    await rm(claude);
    await symlink(stale, universal);
    await symlink(stale, claude);
    await gyst("--help");
    await expectLink(universal);
    await expectLink(claude);
  });
});
