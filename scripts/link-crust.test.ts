import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it("registers usable package links from a relative crust checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "gyst-crust-links-"));
  try {
    const checkout = join(root, "crust");
    const project = join(root, "project");
    const bunInstall = join(root, "bun");
    await mkdir(project);
    for (const name of ["core", "extensions", "skills", "crust"]) {
      const dist = join(checkout, "packages", name, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "index.js"), "");
      await writeFile(join(dist, "cli.js"), "");
    }

    const result = Bun.spawnSync(
      [process.execPath, fileURLToPath(new URL("./link-crust.ts", import.meta.url))],
      {
        cwd: project,
        env: { ...process.env, CRUST_CHECKOUT: "../crust", BUN_INSTALL: bunInstall },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    const links = join(bunInstall, "install", "global", "node_modules", "@crustjs");
    const names = await readdir(links);
    expect(names).toContain("core");
    expect(names).toContain("extensions");
    for (const name of names) {
      expect(await realpath(join(links, name))).toBe(
        await realpath(join(checkout, "packages", name)),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
