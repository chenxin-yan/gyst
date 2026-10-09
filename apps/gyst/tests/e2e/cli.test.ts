import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import { failed, installed, json, sandbox, succeeded, viewerLink } from "./installed-gyst.ts";

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
    ).toEqual(["LICENSE", "README.md", "bin", "dist", "package.json", "skills"]);
    expect(await readdir(join(installed.packageDir, "bin"))).toEqual(["gyst.js"]);
    expect((await readdir(join(installed.packageDir, "dist"))).sort()).toEqual([
      "export",
      "web-ui",
    ]);
    // The standalone walkthrough reader is one self-contained file.
    expect(await readdir(join(installed.packageDir, "dist", "export"))).toEqual(["index.html"]);
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

  it("prints the daemon-served link for bare gyst and exits, as session open replies with it", async () => {
    const { root, env, gyst } = await sandbox();
    const cwd = join(root, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
    await mkdir(cwd);
    git("init", "-q");
    git(
      "-c",
      "user.email=t@gyst.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    await writeFile(join(cwd, "new.txt"), "hello\n");

    // Bare gyst opens the session, prints its link and exits; without a terminal it opens no browser.
    const opened = succeeded(await gyst(cwd, []));
    const { link, port, id } = viewerLink(opened.stdout);
    expect(opened.stdout).toBe(`${link}\n`);
    expect(port).toBe(Number(env.GYST_PORT));
    const get = (path: string, host = `localhost:${port}`) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpGet(
          { host: "127.0.0.1", port, path, headers: { host } },
          (response) => {
            let body = "";
            response.once("error", reject);
            response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
            response.once("end", () => resolve({ status: response.statusCode, body }));
          },
        );
        request.setTimeout(5_000, () => request.destroy(new Error("shell request timed out")));
        request.once("error", reject);
      });
    // The daemon serves the packaged viewer after the command exits, at the link's own path.
    const served = await get(new URL(link).pathname);
    expect(served.status).toBe(200);
    expect(served.body).toContain('<div id="app">');
    const asset = served.body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect((await get(asset!)).status).toBe(200);
    expect((await get("/", `attacker.example:${port}`)).status).toBe(403);

    // `session open` takes the same selection and replies with the same link, opening nothing.
    expect(json(await gyst(cwd, ["session", "open"]))).toMatchObject({
      created: false,
      session: { id },
      link,
    });
    expect(json(await gyst(cwd, ["session", "list"])).sessions).toEqual([
      expect.objectContaining({ id, scope: { kind: "uncommitted" } }),
    ]);
    expect(succeeded(await gyst(cwd, ["--session", id])).stdout).toBe(`${link}\n`);
  }, 30_000);

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
      message: "choose one of a Git range, --pr or --session",
    });
    expect(failed(await gyst(root, ["--pr", "2", "--session", "s1"]))).toEqual({
      code: "bad_args",
      message: "choose one of a Git range, --pr or --session",
    });
    expect(failed(await gyst(root, ["main...feature", "extra"]))).toMatchObject({
      code: "bad_args",
    });
    expect(failed(await gyst(root, ["https://github.com/acme/widgets/pull/2"]))).toEqual({
      code: "bad_args",
      message: "expected a Git range such as main...feature; pass a GitHub PR with --pr",
      detail: "https://github.com/acme/widgets/pull/2",
    });
    expect(failed(await gyst(root, ["--pr", "main...feature"]))).toEqual({
      code: "bad_args",
      message:
        "expected a PR number or a GitHub PR URL such as https://github.com/owner/name/pull/123",
      detail: "main...feature",
    });
    expect(failed(await gyst(root, ["session", "status", "--no-such-flag"]))).toEqual({
      code: "bad_args",
      message: expect.stringContaining("no-such-flag"),
    });
  });
});
