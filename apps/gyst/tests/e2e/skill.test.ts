import { ApplyEnvelopeSchema, ApplyOpSchema, ErrorCodeSchema, inspectMarkdown } from "@gyst/core";
import { Schema } from "effect";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { installed, run, sandbox, succeeded } from "./installed-gyst.ts";

const authoredDir = fileURLToPath(new URL("../../skills/", import.meta.url));
// crust resolves packaged skills from the installed package, not the checkout.
const skills = join(installed.packageDir, "skills");
const workflows = ["gyst", "gyst-respond"];

/** Every file under `dir`, as sorted paths relative to it. */
const filesOf = async (dir: string) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
};
/** Each shipped Markdown file of the authored workflows, by `<skill>/<path>`. */
const shippedMarkdown = async () => {
  const texts = new Map<string, string>();
  for (const name of workflows)
    for (const file of await filesOf(join(skills, name)))
      if (file.endsWith(".md"))
        texts.set(join(name, file), await readFile(join(skills, name, file), "utf8"));
  return texts;
};

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
  it("ships the two workflows with their shared references, as authored, and the generated reference", async () => {
    expect((await readdir(skills)).sort()).toEqual(["gyst", "gyst-cli", "gyst-respond"]);
    expect((await readdir(authoredDir)).sort()).toEqual(workflows);
    for (const name of workflows) {
      const files = await filesOf(join(authoredDir, name));
      expect(await filesOf(join(skills, name))).toEqual(files);
      for (const file of files)
        expect(await readFile(join(skills, name, file), "utf8")).toBe(
          await readFile(join(authoredDir, name, file), "utf8"),
        );
    }
    expect(await filesOf(join(skills, "gyst"))).toEqual([
      "SKILL.md",
      "agents/openai.yaml",
      "references/authoring.md",
      "references/examples.md",
    ]);

    // The human invokes the response workflow; the preparation workflow may be chosen implicitly.
    const respond = await readFile(join(skills, "gyst-respond", "SKILL.md"), "utf8");
    expect(respond).toContain("disable-model-invocation: true");
    expect(await readFile(join(skills, "gyst-respond", "agents", "openai.yaml"), "utf8")).toContain(
      "allow_implicit_invocation: false",
    );
    expect(await readFile(join(skills, "gyst", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    expect(await readFile(join(skills, "gyst", "agents", "openai.yaml"), "utf8")).toContain(
      "allow_implicit_invocation: true",
    );

    for (const name of [...workflows, "gyst-cli"])
      for (const file of await filesOf(join(skills, name))) {
        const text = await readFile(join(skills, name, file), "utf8");
        // Removed workflows and superseded plain-text note rules are gone.
        expect(text).not.toMatch(/gyst-ask|gyst-refresh|400|hunkId"|plain text, at most/);
        // Nothing points into the checkout or a private skill location.
        expect(text).not.toMatch(/apps\/gyst|node_modules|\/home\/|~\/\.|\.claude\/|\.agents\//);
      }
  });

  it("ships example batches that decode as apply envelopes with safe Markdown", async () => {
    const examples = await readFile(join(skills, "gyst", "references", "examples.md"), "utf8");
    const blocks = [...examples.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const decode = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" });
    const types = new Set<string>();
    for (const block of blocks) {
      const batch = decode(JSON.parse(block));
      const created = new Set<string>();
      for (const op of batch.ops) {
        types.add(op.type);
        if (op.type === "group.create") created.add(op.id);
        if (op.type === "note.create") expect([...created, "reject-expired"]).toContain(op.group);
        for (const markdown of [
          "overview" in op ? op.overview : undefined,
          "markdown" in op ? op.markdown : undefined,
        ])
          if (typeof markdown === "string") expect(inspectMarkdown(markdown).problems).toEqual([]);
      }
    }
    const referenceTypes = ApplyOpSchema.members.map(({ fields }) => fields.type.literal);
    for (const type of [
      "walkthrough.update",
      "group.create",
      "group.update",
      "note.create",
      "note.update",
      "note.revalidate",
      "walkthrough.revalidate",
      "thread.reply",
    ]) {
      expect(referenceTypes).toContain(type);
      expect(types).toContain(type);
    }
  });

  it("names only commands and flags the generated reference documents", async () => {
    const reference = join(skills, "gyst-cli", "commands", "session");
    const invocations: string[] = [];
    for (const text of (await shippedMarkdown()).values())
      for (const [, command, rest] of text.matchAll(/gyst session ([a-z]+)([^`\n]*)/g)) {
        invocations.push(command!);
        const doc = await readFile(join(reference, `${command}.md`), "utf8");
        for (const [flag] of rest!.matchAll(/--[a-z-]+/g)) expect(doc).toContain(`\`${flag}\``);
      }
    expect(new Set(invocations)).toEqual(
      new Set([
        "open",
        "list",
        "status",
        "diff",
        "files",
        "code",
        "apply",
        "refresh",
        "check",
        "threads",
      ]),
    );

    // Output, errors, the apply envelope and replay rules come from the command definitions.
    const session = await readFile(join(skills, "gyst-cli", "commands", "session.md"), "utf8");
    for (const code of ErrorCodeSchema.literals) expect(session).toContain(`\`${code}\``);
    const apply = await readFile(join(reference, "apply.md"), "utf8");
    expect(apply).toContain("## Input");
    expect(apply).toContain("- `thread.reply`: thread, markdown");
    for (const command of ["apply", "threads", "refresh", "delete"])
      expect(await readFile(join(reference, `${command}.md`), "utf8")).toContain("## Retry");
  });

  it("installs both workflows and the generated reference, whose relative links resolve, for universal and Claude harnesses", async () => {
    const { home, gyst } = await withClaude();
    await gyst("skill", "--all");

    const texts = await shippedMarkdown();
    for (const agentSkills of [join(home, ".agents", "skills"), join(home, ".claude", "skills")]) {
      for (const name of [...workflows, "gyst-cli"])
        await expectLink(join(agentSkills, name), name);
      expect(existsSync(join(agentSkills, "gyst-ask"))).toBe(false);
      expect(existsSync(join(agentSkills, "gyst-refresh"))).toBe(false);
      // Both workflows reach the one authoring reference, through the installed links alone.
      for (const [file, text] of texts)
        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (/^(https?|gyst):/.test(target!)) continue;
          const path = join(agentSkills, dirname(file), target!);
          expect((await stat(path)).isFile(), `${file} links ${target}`).toBe(true);
          expect((await realpath(path)).startsWith(`${skills}/`)).toBe(true);
        }
    }
    expect(texts.get("gyst-respond/SKILL.md")).toContain("../gyst/references/authoring.md");
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
