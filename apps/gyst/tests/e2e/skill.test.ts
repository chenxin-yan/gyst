import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApplyEnvelopeSchema } from "@gyst/core";
import { Schema } from "effect";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isolatedHome } from "./isolated-home.ts";

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
  // Only the staged skills are needed, so build the host target rather than the release set.
  const build = Bun.spawnSync(["bun", "x", "crust", "build", "--target", "host"], {
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
  it("ships schema-valid note examples and authored skills unchanged", async () => {
    for (const name of ["gyst", "gyst-refresh", "gyst-ask"]) {
      const authored = await readFile(join(appDir, "skills", name, "SKILL.md"), "utf8");
      expect(await readFile(join(skills, name, "SKILL.md"), "utf8")).toBe(authored);
      expect(authored).not.toMatch(/overview|mermaid/i);
      if (name === "gyst") {
        const example = authored.match(/```json\n([\s\S]*?)\n```/)![1]!;
        const batch = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" })(
          JSON.parse(example),
        );
        const create = batch.ops[0]!;
        expect(create.type).toBe("group.create");
        if (create.type === "group.create") {
          expect(create.notes).toHaveLength(2);
          expect(create.notes.every(({ hunkId }) => create.memberHunkIds.includes(hunkId))).toBe(
            true,
          );
        }
      }
      if (name === "gyst-ask") expect(authored).toContain("disable-model-invocation: true");
    }
  });
  it("installs the authored skills and the generated command reference for universal and Claude harnesses", async () => {
    await gyst("skill", "--all");

    for (const name of ["gyst", "gyst-ask", "gyst-refresh", "gyst-cli"]) {
      await expectLink(join(home, ".agents", "skills", name), name);
      await expectLink(join(home, ".claude", "skills", name), name);
    }
    for (const name of ["gyst", "gyst-refresh"]) {
      expect(await readFile(join(skills, name, "SKILL.md"), "utf8")).not.toContain(
        "disable-model-invocation: true",
      );
    }
    expect(await readFile(join(skills, "gyst", "agents", "openai.yaml"), "utf8")).toContain(
      "allow_implicit_invocation: true",
    );
    expect(
      await readFile(join(skills, "gyst-cli", "commands", "session", "create.md"), "utf8"),
    ).toContain("git options are rejected");
  });

  it("repairs version-stale links explicitly and before ordinary commands", async () => {
    const stale = join(root, "v1", "skills", "gyst");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "---\nname: gyst\ndescription: old\n---\n");
    const universal = join(home, ".agents", "skills", "gyst");
    const claude = join(home, ".claude", "skills", "gyst");

    for (const args of [["skills", "repair", "--scope", "global"], ["--help"]]) {
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
