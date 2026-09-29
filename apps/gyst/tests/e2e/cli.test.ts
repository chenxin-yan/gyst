import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import { failed, installed, sandbox, succeeded } from "./installed-gyst.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("installed gyst CLI", () => {
  it("is installed outside the checkout without workspace-only packages or sources", async () => {
    expect(relative(repoRoot, installed.packageDir).startsWith("..")).toBe(true);
    const manifest = JSON.parse(await readFile(join(installed.packageDir, "package.json"), "utf8"));
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.bin).toEqual({ gyst: "bin/gyst.js" });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(existsSync(join(installed.prefix, "lib", "node_modules", "@gyst", "core"))).toBe(false);
    expect(existsSync(join(installed.packageDir, "node_modules", "@gyst", "core"))).toBe(false);
    expect(
      (await readdir(installed.packageDir)).filter((name) => name !== "node_modules").sort(),
    ).toEqual(["LICENSE", "README.md", "bin", "package.json", "skills"]);
    expect(await readdir(join(installed.packageDir, "bin"))).toEqual(["gyst.js"]);
  });

  it("prints help for the root and session commands without the hidden daemon", async () => {
    const { root, env, gyst } = await sandbox();
    const help = succeeded(await gyst(root, ["--help"])).stdout;
    expect(help).toContain("Commands:");
    expect(help).toContain("Agent skills");
    expect(help).toContain("gyst [range]");
    expect(help).toContain("--session");
    expect(help).not.toContain("daemon");
    expect(succeeded(await gyst(root, ["session", "--help"])).stdout).toContain("gyst session");
    expect(succeeded(await gyst(root, ["session", "open", "--help"])).stdout).toContain(
      "gyst session open",
    );
    // Help never touches the data dir, so no daemon was started.
    expect(existsSync(env.GYST_DATA_DIR!)).toBe(false);
  }, 20_000);

  // Integration pending: the web UI owner ships dist/web-ui. Until then bare `gyst` must fail
  // explicitly, from the installed package's own path, before contacting any daemon; the
  // integrated installed browser test replaces this.
  it("launches the web viewer for bare gyst instead of help, from the installed package", async () => {
    const { root, env, gyst } = await sandbox();
    expect(failed(await gyst(root, []))).toEqual({
      code: "internal_error",
      message: "the gyst web UI is not installed; reinstall @gyst/cli",
      detail: expect.stringContaining(join(installed.packageDir, "dist", "web-ui")),
    });
    expect(existsSync(env.GYST_DATA_DIR!)).toBe(false);
  });

  it("reports the package version", async () => {
    const { root, gyst } = await sandbox();
    expect(succeeded(await gyst(root, ["--version"])).stdout.trim()).toBe(
      `gyst v${packageJson.version}`,
    );
  });

  it("rejects invalid arguments through the JSON error contract", async () => {
    const { root, gyst } = await sandbox();
    expect(failed(await gyst(root, ["--no-such-flag"]))).toEqual({
      code: "bad_args",
      message: expect.stringContaining("no-such-flag"),
    });
    expect(failed(await gyst(root, ["main...feature", "--session", "s1"]))).toEqual({
      code: "bad_args",
      message: "choose a Git range or --session, not both",
    });
    expect(failed(await gyst(root, ["main...feature", "extra"]))).toMatchObject({
      code: "bad_args",
    });
    expect(failed(await gyst(root, ["session", "status", "--no-such-flag"]))).toEqual({
      code: "bad_args",
      message: expect.stringContaining("no-such-flag"),
    });
  });
});
