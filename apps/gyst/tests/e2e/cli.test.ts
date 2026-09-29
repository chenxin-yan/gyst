import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import { failed, installed, json, sandbox, succeeded, waitFor } from "./installed-gyst.ts";

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
    expect(await readdir(join(installed.packageDir, "dist"))).toEqual(["web-ui"]);
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

  it("serves the packaged viewer for bare gyst until SIGINT, leaving the session to the CLI", async () => {
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

    const viewer = spawn(installed.bin, [], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    // Exit (or spawn failure) is recorded from the start, so cleanup can await it.
    let exit: number | NodeJS.Signals | Error | undefined;
    viewer.once("error", (error) => (exit ??= error));
    viewer.once("close", (code, signal) => (exit ??= code ?? signal ?? "SIGKILL"));
    const exited = async (description: string) => {
      await waitFor(() => exit !== undefined, description);
      if (exit instanceof Error) throw exit;
      return exit;
    };
    // onTestFinished hooks run in reverse, so this finishes before the sandbox is removed.
    onTestFinished(async () => {
      if (exit === undefined) viewer.kill("SIGKILL");
      await waitFor(() => exit !== undefined, "the viewer to exit during cleanup");
    });
    let stdout = "";
    let stderr = "";
    viewer.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    viewer.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    await waitFor(
      () => stdout.includes("Press Ctrl-C") || exit !== undefined,
      "the viewer to print its launch URL",
      10_000,
    );
    if (exit !== undefined) throw new Error(`the viewer exited ${String(exit)} early: ${stderr}`);
    // The URL carries the bootstrap secret, so only its shape is compared, never printed.
    const url = stdout.split("\n").find((line) => line.startsWith("http://"));
    const launch = url?.match(
      /^http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+)\/session\/([^/#]+)#[\w-]{43}$/,
    );
    expect(launch !== null && launch !== undefined).toBe(true);
    const [, hostname, port, id] = launch!;

    const served = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpGet(
          {
            host: "127.0.0.1",
            port,
            path: `/session/${id}`,
            headers: { host: `${hostname}:${port}` },
          },
          (response) => {
            let body = "";
            response.once("error", reject);
            response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
            response.once("end", () => resolve({ status: response.statusCode, body }));
          },
        );
        request.setTimeout(5_000, () => request.destroy(new Error("shell request timed out")));
        request.once("error", reject);
      },
    );
    expect(served.status).toBe(200);
    expect(served.body).toContain('<div id="root">');

    viewer.kill("SIGINT");
    expect(await exited("the viewer to exit on SIGINT")).toBe(130);
    expect(json(await gyst(cwd, ["session", "list"])).sessions).toEqual([
      expect.objectContaining({ id: decodeURIComponent(id!), scope: { kind: "uncommitted" } }),
    ]);
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
