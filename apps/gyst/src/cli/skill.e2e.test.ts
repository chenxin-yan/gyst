import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isolatedHome } from "./test-env.ts";

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
const appDir = join(import.meta.dir, "../..");
// Source runs resolve packaged skills at the staged root, so the test builds first.
const skills = join(appDir, ".crust/root/skills");

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
  if (exitCode !== 0)
    throw new Error(`gyst ${args.join(" ")} failed (${exitCode}):\n${stdout}\n${stderr}`);
}

async function expectLink(path: string, name = "gyst") {
  expect(resolve(dirname(path), await readlink(path))).toBe(join(skills, name));
  expect(await readFile(join(path, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gyst-skill-"));
  home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const claude = join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  env = { ...isolatedHome(home), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`crust build failed:\n${build.stderr}`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gyst skill installer", () => {
  it("installs the authored /gyst and /gyst-ask skills for universal and Claude harnesses", async () => {
    await gyst("skill", "--all");

    for (const name of ["gyst", "gyst-ask"]) {
      await expectLink(join(home, ".agents", "skills", name), name);
      await expectLink(join(home, ".claude", "skills", name), name);
    }
  });

  it("repairs version-stale links explicitly and before ordinary commands", async () => {
    const stale = join(root, "v1", "skills", "gyst");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "---\nname: gyst\ndescription: old\n---\n");
    const universal = join(home, ".agents", "skills", "gyst");
    const claude = join(home, ".claude", "skills", "gyst");

    for (const args of [["skill", "update", "--scope", "global"], ["--help"]]) {
      await rm(universal);
      await rm(claude);
      await symlink(stale, universal);
      await symlink(stale, claude);
      await gyst(...args);
      await expectLink(universal);
      await expectLink(claude);
    }
  });
});
