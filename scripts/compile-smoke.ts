import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const app = join(root, "apps", "gyst");
const stageDir = join(app, ".crust");

type Manifest = { packages: Array<{ dir: string; bins: Record<string, string> }> };

function run(command: string[], label: string, cwd = root, env?: Record<string, string>): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    console.error(stderr);
    throw new Error(`${label} exited ${result.exitCode}`);
  }
  return stdout;
}

run(["bun", "run", "build"], "crust build --target host", app);
// SAFETY: crust build wrote this manifest in the same run; a shape mismatch fails the smoke below.
const manifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8")) as Manifest;
const platform = manifest.packages[0];
if (manifest.packages.length !== 1 || !platform?.bins.gyst) {
  throw new Error("host build must stage exactly one platform package with a gyst binary");
}
const binary = join(stageDir, platform.dir, platform.bins.gyst);

// Run a copied binary away from this checkout so node_modules cannot mask missing embedded natives.
const isolated = await mkdtemp(join(tmpdir(), "gyst-compile-smoke-"));
const isolatedBinary = join(isolated, "gyst");
try {
  await copyFile(binary, isolatedBinary);
  // The binary resolves packaged skills beside itself, where crust stages them.
  await cp(join(dirname(binary), "skills"), join(isolated, "skills"), { recursive: true });
  await chmod(isolatedBinary, 0o755);

  const frame = run([isolatedBinary], "compiled OpenTUI frame", isolated, {
    GYST_COMPILE_SMOKE: "1",
  });
  if (!frame.includes("gyst · Solid signal updated")) throw new Error("compiled frame missing");

  const rootHelp = run([isolatedBinary, "--help"], "compiled root help", isolated);
  if (!rootHelp.includes("Usage:") || !rootHelp.includes("session")) {
    throw new Error("compiled root help missing crust output");
  }

  const sessionHelp = run([isolatedBinary, "session", "--help"], "compiled session help", isolated);
  if (!sessionHelp.includes("Usage:") || !sessionHelp.includes("gyst session")) {
    throw new Error("compiled session help missing crust output");
  }

  const home = join(isolated, "home");
  const bin = join(isolated, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  run([isolatedBinary, "skill", "--all"], "compiled skill install", isolated, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  for (const [name, authoredText] of [
    ["gyst", "Use gyst to prepare one diff"],
    ["gyst-ask", "Resolve `cursor.itemId`"],
  ]) {
    const link = join(home, ".agents", "skills", name);
    if (resolve(dirname(link), await readlink(link)) !== join(isolated, "skills", name)) {
      throw new Error(`${name} install does not target packaged skills`);
    }
    const contents = await readFile(join(link, "SKILL.md"), "utf8");
    if (!contents.includes(`name: ${name}`) || !contents.includes(authoredText)) {
      throw new Error(`${name} packaged skill is not the authored extra`);
    }
  }
} finally {
  await rm(isolated, { recursive: true, force: true });
}

console.log("compile smoke OK — isolated OpenTUI frame, crust help, and packaged skill install");
