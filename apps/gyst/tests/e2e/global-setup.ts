// Test the published packages through npm consumer installs outside the checkout.
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

/** The packed navigation add-on, installed globally into its own private npm prefix. */
export type InstalledNavigation = {
  /** The packed `@gyst/navigation-typescript` tarball, for installs a test makes itself. */
  readonly tarball: string;
  /** Private npm global prefix, never on a launch PATH unless a test puts `<prefix>/bin` there. */
  readonly prefix: string;
  /** The npm-created `gyst-navigation-typescript` bin link. */
  readonly bin: string;
};

declare module "vitest" {
  export interface ProvidedContext {
    installedGyst: InstalledGyst;
    installedNavigation: InstalledNavigation;
  }
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageDir = join(repoRoot, "apps", "gyst");
const navigationDir = join(repoRoot, "packages", "navigation-typescript");

// The npm shipped beside the Node running the tests, so the package is installed by the runtime
// under test rather than whatever else is on PATH.
const withTestedNpm = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ""}`,
});

function exec(
  command: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
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

export default async function setup(project: Pick<TestProject, "provide">) {
  const testedEnv = withTestedNpm(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "gyst-installed-")));
  const prefix = join(root, "prefix");
  const navigationPrefix = join(root, "navigation-prefix");
  let navigationTarball: string;
  try {
    // Vitest sets NODE_ENV=test, which would ship a React development build; test what npm users get.
    await exec("pnpm", packageDir, ["build"], { ...testedEnv, NODE_ENV: "production" });
    const packed = JSON.parse(
      await exec("pnpm", packageDir, ["pack", "--pack-destination", root, "--json"], testedEnv),
    ) as { filename: string };
    await exec(
      "npm",
      root,
      ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", packed.filename],
      testedEnv,
    );
    // The add-on's own install fetches its pinned engine from the registry (or npm's cache).
    navigationTarball = (
      JSON.parse(
        await exec(
          "pnpm",
          navigationDir,
          ["pack", "--pack-destination", root, "--json"],
          testedEnv,
        ),
      ) as { filename: string }
    ).filename;
    await exec(
      "npm",
      root,
      [
        "install",
        "--global",
        "--prefix",
        navigationPrefix,
        "--no-audit",
        "--no-fund",
        navigationTarball,
      ],
      testedEnv,
    );
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
  project.provide("installedNavigation", {
    tarball: navigationTarball,
    prefix: navigationPrefix,
    bin: join(navigationPrefix, "bin", "gyst-navigation-typescript"),
  });
  return () => rm(root, { recursive: true, force: true });
}
