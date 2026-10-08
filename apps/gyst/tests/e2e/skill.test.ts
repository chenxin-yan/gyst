import { ApplyEnvelopeSchema } from "@gyst/core";
import { Schema } from "effect";
import { mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { installed, run, sandbox, succeeded } from "./installed-gyst.ts";

const authoredDir = fileURLToPath(new URL("../../skills/", import.meta.url));
// crust resolves packaged skills from the installed package, not the checkout.
const skills = join(installed.packageDir, "skills");

async function expectLink(path: string, name = "gyst") {
  expect(resolve(dirname(path), await readlink(path))).toBe(join(skills, name));
  expect(await readFile(join(path, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
}

/** A sandbox whose PATH also holds a stub `claude`, so crust detects the Claude harness. */
async function withClaude() {
  const box = await sandbox();
  const bin = join(box.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...box.env, PATH: `${bin}${delimiter}${box.env.PATH}` };
  return {
    ...box,
    gyst: async (...args: string[]) =>
      succeeded(await run(installed.bin, args, { cwd: box.root, env })),
  };
}

describe("installed gyst skills", () => {
  it("ships a schema-valid walkthrough example and authored skills unchanged", async () => {
    for (const name of ["gyst", "gyst-refresh", "gyst-ask"]) {
      const authored = await readFile(join(authoredDir, name, "SKILL.md"), "utf8");
      expect(await readFile(join(skills, name, "SKILL.md"), "utf8")).toBe(authored);
      // The superseded plain-text note rules are gone.
      expect(authored).not.toMatch(/400|hunkId"|plain text, at most/);
      if (name === "gyst") {
        const example = authored.match(/```json\n([\s\S]*?)\n```/)![1]!;
        const batch = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" })(
          JSON.parse(example),
        );
        expect(batch.ops.map(({ type }) => type)).toEqual([
          "walkthrough.update",
          "group.create",
          "note.create",
        ]);
        const [, create, note] = batch.ops;
        if (create?.type === "group.create" && note?.type === "note.create")
          expect(note.group).toBe(create.id);
        else throw new Error("the example must create a group and then its note");
      }
      if (name === "gyst-ask") expect(authored).toContain("disable-model-invocation: true");
    }
  });

  it("installs the authored skills and the generated command reference for universal and Claude harnesses", async () => {
    const { home, gyst } = await withClaude();
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
      await readFile(join(skills, "gyst-cli", "commands", "session", "open.md"), "utf8"),
    ).toContain("A Git range such as main...feature");
  }, 20_000);

  it("repairs version-stale links explicitly and before ordinary commands", async () => {
    const { root, home, gyst } = await withClaude();
    await gyst("skill", "--all");
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
  }, 20_000);
});
