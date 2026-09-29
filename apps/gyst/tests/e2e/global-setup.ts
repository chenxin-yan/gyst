// Test the published package through an npm consumer install outside the checkout.
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vite-plus/test/node";

export type InstalledGyst = {
  /** Private npm global prefix; removed after the run. */
  readonly prefix: string;
  /** The npm-created `gyst` bin link. */
  readonly bin: string;
  /** The installed `@gyst/cli` package directory. */
  readonly packageDir: string;
};

declare module "vitest" {
  export interface ProvidedContext {
    installedGyst: InstalledGyst;
  }
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageDir = join(repoRoot, "apps", "gyst");

// The npm shipped beside the Node running the tests, so the package is installed by the runtime
// under test rather than whatever else is on PATH.
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};

function exec(command: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `${command} ${args.join(" ")} (cwd ${cwd}) exited ${code ?? signal}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
            ),
          ),
    );
  });
}

export default async function setup(project: TestProject) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gyst-installed-")));
  const prefix = join(root, "prefix");
  try {
    await exec(join(repoRoot, "node_modules", ".bin", "vp"), repoRoot, ["run", "@gyst/cli#build"]);
    const packed = JSON.parse(
      await exec("pnpm", packageDir, ["pack", "--pack-destination", root, "--json"]),
    ) as { filename: string };
    await exec("npm", root, [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      packed.filename,
    ]);
  } catch (error) {
    // Keep the scratch directory for diagnosis; it is named in the failure.
    throw new Error(
      `installed-package setup failed; scratch kept at ${root}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  project.provide("installedGyst", {
    prefix,
    bin: join(prefix, "bin", "gyst"),
    packageDir: join(prefix, "lib", "node_modules", "@gyst", "cli"),
  });
  return () => rm(root, { recursive: true, force: true });
}
