import { expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function makeCheckout(root: string): Promise<string> {
  const checkout = join(root, "crust");
  for (const name of ["core", "extensions", "skills", "crust"]) {
    const dist = join(checkout, "packages", name, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "index.js"), "");
    await writeFile(join(dist, "cli.js"), "");
  }
  return checkout;
}

function runSetup(project: string, bunInstall: string) {
  return Bun.spawnSync(
    [process.execPath, fileURLToPath(new URL("./link-crust.ts", import.meta.url))],
    {
      cwd: project,
      env: { ...process.env, CRUST_CHECKOUT: "../crust", BUN_INSTALL: bunInstall },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function linkRoot(bunInstall: string): string {
  return join(bunInstall, "install", "global", "node_modules", "@crustjs");
}

it("registers usable package links from a relative crust checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "gyst-crust-links-"));
  try {
    const checkout = await makeCheckout(root);
    const project = join(root, "project");
    const bunInstall = join(root, "bun");
    await mkdir(project);

    expect(runSetup(project, bunInstall).exitCode).toBe(0);
    const links = linkRoot(bunInstall);
    const names = await readdir(links);
    expect(names).toContain("core");
    expect(names).toContain("extensions");
    for (const name of names) {
      expect(await realpath(join(links, name))).toBe(
        await realpath(join(checkout, "packages", name)),
      );
    }

    const again = runSetup(project, bunInstall);
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString()).toContain("already linked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to replace an existing real directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gyst-crust-links-"));
  try {
    await makeCheckout(root);
    const project = join(root, "project");
    const bunInstall = join(root, "bun");
    await mkdir(project);
    const existing = join(linkRoot(bunInstall), "core");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "sentinel"), "keep");

    const result = runSetup(project, bunInstall);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(existing);
    expect(await Bun.file(join(existing, "sentinel")).text()).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to replace a symlink to a different checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "gyst-crust-links-"));
  try {
    await makeCheckout(root);
    const project = join(root, "project");
    const bunInstall = join(root, "bun");
    const other = join(root, "other-core");
    await mkdir(project);
    await mkdir(other);
    const existing = join(linkRoot(bunInstall), "core");
    await mkdir(linkRoot(bunInstall), { recursive: true });
    await symlink(other, existing, "dir");

    const result = runSetup(project, bunInstall);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(existing);
    expect(await readlink(existing)).toBe(other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
