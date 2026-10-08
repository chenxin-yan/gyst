import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { navigationAddon } from "@gyst/core";
import { Effect } from "effect";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonVersion } from "../daemon/protocol.ts";
import { discoverAddon } from "./navigation-addon.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const addonDir = join(repo, "packages", "navigation-typescript");
const addonCli = join(addonDir, "src", "cli.ts");
const readJson = async (...path: ReadonlyArray<string>) =>
  JSON.parse(await readFile(join(repo, ...path), "utf8"));

const discover = (launchPath: string | undefined, version = daemonVersion) =>
  Effect.runPromise(discoverAddon(launchPath, version).pipe(Effect.provide(NodeServices.layer)));

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gyst-navigation-discovery-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** A bin directory holding `gyst-navigation-typescript`, as npm's global bin links it. */
const binWith = async (target: string) => {
  const bin = await mkdtemp(join(await tempDir(), "bin-"));
  await symlink(target, join(bin, navigationAddon.bin));
  return bin;
};

/** A bin directory whose `gyst-navigation-typescript` is the given Node script. */
const binRunning = async (script: string) => {
  const dir = await tempDir();
  const file = join(dir, "fake.js");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return binWith(file);
};

const handshake = (fields: object) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify({
    name: navigationAddon.name,
    version: daemonVersion,
    protocol: navigationAddon.protocol,
    engine: { ok: true, version: "7.0.2" },
    ...fields,
  })}) + "\\n");`;

describe("discoverAddon", () => {
  it("finds the workspace add-on through a bin link and returns its real entry", async () => {
    const bin = await binWith(addonCli);
    expect(await discover(bin)).toEqual({
      kind: "available",
      entry: await realpath(addonCli),
      version: daemonVersion,
    });
  });

  it("takes the first match in PATH order", async () => {
    const real = await binWith(addonCli);
    const garbage = await binRunning('console.log("hello");');
    expect((await discover(`${real}:${garbage}`)).kind).toBe("available");
    expect((await discover(`${garbage}:${real}`)).kind).toBe("unusable");
  });

  it("ignores empty and relative entries, directories and non-executable files", async () => {
    const real = await binWith(addonCli);
    const garbage = await binRunning('console.log("hello");');
    const directory = await tempDir();
    await mkdir(join(directory, navigationAddon.bin));
    const plain = await tempDir();
    await cp(addonCli, join(plain, navigationAddon.bin));
    await chmod(join(plain, navigationAddon.bin), 0o644);
    const path = ["", relative(process.cwd(), garbage), directory, plain, "", real].join(":");
    expect((await discover(path)).kind).toBe("available");
  });

  it("reports a missing add-on", async () => {
    const empty = await tempDir();
    for (const path of [undefined, "", empty, `${empty}:/nonexistent-gyst-bin`])
      expect(await discover(path)).toEqual({ kind: "missing" });
  });

  it("reports another release as mismatched with the version it found", async () => {
    // A copy of the real add-on with only its version changed, using the workspace's engine.
    const copy = join(await tempDir(), "addon");
    await mkdir(join(copy, "src"), { recursive: true });
    const manifest = await readJson("packages", "navigation-typescript", "package.json");
    await writeFile(join(copy, "package.json"), JSON.stringify({ ...manifest, version: "0.0.1" }));
    await cp(addonCli, join(copy, "src", "cli.ts"));
    await symlink(join(addonDir, "node_modules"), join(copy, "node_modules"));
    expect(await discover(await binWith(join(copy, "src", "cli.ts")))).toEqual({
      kind: "mismatched",
      found: "0.0.1",
    });
    // The exact version check is against the running gyst, not any fixed release.
    expect(await discover(await binWith(addonCli), "9.9.9")).toEqual({
      kind: "mismatched",
      found: daemonVersion,
    });
  });

  it("refuses foreign, failing, oversized and protocol-mismatched executables", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['console.log("hello");', "is not @gyst/navigation-typescript"],
      [handshake({ name: "something-else" }), "is not @gyst/navigation-typescript"],
      [handshake({ protocol: 2 }), "speaks protocol 2, not 1"],
      ["process.exit(3);", "exited with code 3"],
      ['process.stdout.write("x".repeat(70 * 1024));', "printed more than 64 KiB"],
      ["syntax error here", "exited with code 1"],
    ];
    for (const [script, reason] of cases) {
      const result = await discover(await binRunning(script));
      expect(result, script).toMatchObject({ kind: "unusable" });
      expect(result.kind === "unusable" && result.reason, script).toContain(reason);
    }
  });

  it("passes on the add-on's engine problem and none of this shell's environment", async () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--no-warnings";
    onTestFinished(() => {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    });
    const result = await discover(
      await binRunning(
        `process.stdout.write(JSON.stringify({
          name: ${JSON.stringify(navigationAddon.name)},
          version: ${JSON.stringify(daemonVersion)},
          protocol: ${navigationAddon.protocol},
          engine: { ok: false, problem: JSON.stringify(Object.keys(process.env)) },
        }));`,
      ),
    );
    expect(result.kind).toBe("unusable");
    // A host's Node launcher may add its own variables (NixOS adds LD_LIBRARY_PATH); none of ours.
    const keys: ReadonlyArray<string> = JSON.parse(result.kind === "unusable" ? result.reason : "");
    for (const key of ["NODE_OPTIONS", "PATH", "HOME"]) expect(keys).not.toContain(key);
  });

  it("runs the handshake in the add-on's own directory, never this process's", async () => {
    // A deleted checkout as gyst's cwd must not stop the add-on's engine check from running.
    const script = handshake({ engine: { ok: false, problem: "<cwd>" } }).replace(
      '"<cwd>"',
      "process.cwd()",
    );
    const result = await discover(await binRunning(script));
    const cwd = result.kind === "unusable" ? result.reason : "";
    expect(cwd).not.toBe(process.cwd());
    expect(await readFile(join(cwd, "fake.js"), "utf8")).toBe(script);
  });

  it("stops a handshake that never answers", async () => {
    const dir = await tempDir();
    const pidFile = join(dir, "pid");
    const result = await discover(
      await binRunning(
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ),
    );
    expect(result).toEqual({
      kind: "unusable",
      reason: `the ${navigationAddon.bin} found on PATH did not answer within 5 seconds`,
    });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});

describe("navigation add-on release", () => {
  it("is versioned in lockstep with @gyst/cli under the names gyst looks for", async () => {
    const addon = await readJson("packages", "navigation-typescript", "package.json");
    const cli = await readJson("apps", "gyst", "package.json");
    expect(addon.version).toBe(cli.version);
    expect(addon.version).toBe(daemonVersion);
    expect(addon.name).toBe(navigationAddon.name);
    expect(addon.bin).toEqual({ [navigationAddon.bin]: "src/cli.ts" });
    // Crust stages the published package, with the engine kept a dependency beside the bundle.
    expect(addon.publishConfig.directory).toBe(".crust/root");
    expect(addon.crust.external).toEqual(["typescript"]);
    const changesets = await readJson(".changeset", "config.json");
    expect(changesets.fixed).toContainEqual(["@gyst/cli", navigationAddon.name]);
  });

  it("is optional: @gyst/cli does not depend on it", async () => {
    const cli = await readJson("apps", "gyst", "package.json");
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      expect(Object.keys(cli[field] ?? {}), field).not.toContain(navigationAddon.name);
  });
});
