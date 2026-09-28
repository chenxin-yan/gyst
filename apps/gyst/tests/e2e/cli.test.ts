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
    expect(manifest.bin).toEqual({ gyst: "dist/cli.mjs" });
    expect(Object.keys(manifest.dependencies)).not.toContain("@gyst/core");
    expect(manifest.scripts).toBeUndefined();
    expect(existsSync(join(installed.prefix, "lib", "node_modules", "@gyst", "core"))).toBe(false);
    expect(existsSync(join(installed.packageDir, "node_modules", "@gyst", "core"))).toBe(false);
    expect(
      (await readdir(installed.packageDir)).filter((name) => name !== "node_modules").sort(),
    ).toEqual([".crust", "LICENSE", "README.md", "dist", "package.json"]);
    const dist = await readdir(join(installed.packageDir, "dist"));
    expect(dist).toContain("cli.mjs");
    expect(dist).toContain("app.mjs");
  });

  it("prints help for the root and session commands without the hidden daemon", async () => {
    const { root, env, gyst } = await sandbox();
    const help = succeeded(await gyst(root, ["--help"])).stdout;
    expect(help).toContain("Commands:");
    expect(help).toContain("Agent skills");
    expect(help).not.toContain("daemon");
    expect(succeeded(await gyst(root, ["session", "--help"])).stdout).toContain("gyst session");
    expect(succeeded(await gyst(root, ["session", "create", "--help"])).stdout).toContain(
      "gyst session create",
    );
    // Help never touches the data dir, so no daemon was started.
    expect(existsSync(env.GYST_DATA_DIR!)).toBe(false);
  }, 20_000);

  it("reports the package version", async () => {
    const { root, gyst } = await sandbox();
    expect(succeeded(await gyst(root, ["--version"])).stdout.trim()).toBe(
      `gyst v${packageJson.version}`,
    );
  });

  it("rejects invalid arguments through the JSON error contract", async () => {
    const { root, gyst } = await sandbox();
    expect(failed(await gyst(root, ["sesion"]))).toEqual({
      code: "bad_args",
      message: expect.stringContaining("sesion"),
    });
    expect(failed(await gyst(root, ["session", "status", "--no-such-flag"]))).toEqual({
      code: "bad_args",
      message: expect.stringContaining("no-such-flag"),
    });
  });
});
