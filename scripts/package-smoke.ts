import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const appDir = resolve(import.meta.dir, "../apps/gyst");
const stageDir = join(appDir, "dist/npm");
const temporary = await mkdtemp(join(tmpdir(), "gyst-package-smoke-"));

type Manifest = {
  version: string;
  root: { name: string; dir: string; bin: string };
  packages: Array<{ name: string; dir: string; os: string; cpu: string; bin: string }>;
  publishOrder: string[];
};

function run(command: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.toString();
}

async function pack(directory: string): Promise<string> {
  const output = run(["npm", "pack", directory, "--pack-destination", temporary], temporary);
  const filename = output.trim().split("\n").at(-1);
  if (!filename) throw new Error(`npm pack returned no tarball for ${directory}`);
  return join(temporary, filename);
}

try {
  const manifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.root.name !== "@gyst/cli" || manifest.root.bin !== "gyst") {
    throw new Error("staged root package is not @gyst/cli with bin gyst");
  }
  if (manifest.packages.length !== 1)
    throw new Error("host smoke expects exactly one platform package");
  const platform = manifest.packages[0]!;
  if (platform.os !== process.platform || platform.cpu !== process.arch) {
    throw new Error(
      `staged ${platform.os}-${platform.cpu}, running on ${process.platform}-${process.arch}`,
    );
  }
  if (manifest.publishOrder.join(",") !== `${platform.dir},${manifest.root.dir}`) {
    throw new Error("platform package must publish before the root package");
  }

  const rootDir = join(stageDir, manifest.root.dir);
  const platformDir = join(stageDir, platform.dir);
  const rootPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const platformPackage = JSON.parse(await readFile(join(platformDir, "package.json"), "utf8"));
  if (rootPackage.optionalDependencies?.[platform.name] !== manifest.version) {
    throw new Error("root optionalDependencies does not select the staged platform package");
  }
  if (rootPackage.files?.slice().sort().join(",") !== "bin,skills") {
    throw new Error("staged root contains artifacts other than its resolver and authored skill");
  }
  if (platformPackage.os?.[0] !== process.platform || platformPackage.cpu?.[0] !== process.arch) {
    throw new Error("platform npm os/cpu metadata is missing or wrong");
  }

  const rootTarball = await pack(rootDir);
  const platformTarball = await pack(platformDir);
  const rootFiles = run(["tar", "-tf", rootTarball], temporary);
  const platformFiles = run(["tar", "-tf", platformTarball], temporary);
  if (
    !rootFiles.includes("package/bin/gyst.js") ||
    !rootFiles.includes("package/skills/gyst/SKILL.md")
  ) {
    throw new Error("packed root is missing its resolver or authored skill");
  }
  if (rootFiles.includes("package/release/")) {
    throw new Error("packed root contains raw release binaries");
  }
  if (
    !platformFiles.includes(`package/${platform.bin}`) ||
    !platformFiles.includes("package/bin/skills/gyst/SKILL.md")
  ) {
    throw new Error("packed platform package is missing its compiled binary or authored skill");
  }
  if (platformFiles.includes("package/bin/release/")) {
    throw new Error("packed platform package contains raw release binaries");
  }

  const installDir = join(temporary, "install");
  const home = join(temporary, "home");
  await mkdir(installDir, { recursive: true });
  run(
    [
      "npm",
      "install",
      "--global",
      "--prefix",
      installDir,
      "--ignore-scripts",
      rootTarball,
      platformTarball,
    ],
    installDir,
  );

  const installed = (await readdir(join(installDir, "lib/node_modules/@gyst"))).sort();
  const expected = [manifest.root.name.split("/")[1]!, platform.name.split("/")[1]!].sort();
  if (installed.join(",") !== expected.join(",")) {
    throw new Error(`wrong-platform packages installed: ${installed.join(", ")}`);
  }

  const executable = join(installDir, "bin/gyst");
  await chmod(executable, 0o755);
  const node = Bun.which("node");
  if (!node) throw new Error("node is required to execute the npm package resolver");
  const runtimeBin = join(temporary, "runtime-bin");
  await mkdir(runtimeBin);
  await symlink(node, join(runtimeBin, "node"));
  const systemPath = [runtimeBin, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  if (
    Bun.spawnSync(["sh", "-c", "command -v bun"], { env: { ...process.env, PATH: systemPath } })
      .exitCode === 0
  ) {
    throw new Error("package smoke PATH unexpectedly contains Bun");
  }
  const help = run([executable, "--help"], installDir, {
    ...process.env,
    PATH: systemPath,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  });
  if (!help.includes("Keyboard-centric agent/human co-review")) {
    throw new Error("installed compiled gyst did not print its help");
  }

  await writeFile(join(runtimeBin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  run([executable, "skill", "--all"], installDir, {
    ...process.env,
    PATH: systemPath,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  });
  const platformInstall = join(installDir, "lib/node_modules", ...platform.name.split("/"));
  for (const name of ["gyst", "gyst-ask"]) {
    const packagedSkill = join(platformInstall, dirname(platform.bin), "skills", name);
    for (const link of [join(home, ".agents/skills", name), join(home, ".claude/skills", name)]) {
      if (resolve(dirname(link), await readlink(link)) !== packagedSkill) {
        throw new Error(`${name} install does not target the packed platform skill`);
      }
      if (!(await readFile(join(link, "SKILL.md"), "utf8")).includes(`name: ${name}`)) {
        throw new Error(`${name} packed skill is unreadable`);
      }
    }
  }

  console.log(
    `package smoke OK — packed, installed, ran ${platform.name} without Bun, and installed its authored skills`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
