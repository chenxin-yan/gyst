import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const binary = join(root, "dist", "gyst");

function run(command: string[], label: string, cwd = root, env?: Record<string, string>): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    console.error(stderr);
    throw new Error(`${label} exited ${result.exitCode}`);
  }
  return stdout;
}

run(["bun", "run", "build:compile"], "bun build --compile");

// Run a copied binary away from this checkout so node_modules cannot mask missing embedded natives.
const isolated = await mkdtemp(join(tmpdir(), "gyst-compile-smoke-"));
const isolatedBinary = join(isolated, "gyst");
try {
  await copyFile(binary, isolatedBinary);
  await cp(join(root, "dist", "skills"), join(isolated, "skills"), { recursive: true });
  await chmod(isolatedBinary, 0o755);

  const frame = run([isolatedBinary], "compiled OpenTUI frame", isolated, { GYST_COMPILE_SMOKE: "1" });
  if (!frame.includes("gyst · OpenTUI compile smoke")) throw new Error("compiled frame missing");

  const rootHelp = run([isolatedBinary, "--help"], "compiled root help", isolated);
  if (!rootHelp.includes("Usage:") || !rootHelp.includes("session")) {
    throw new Error("compiled root help missing crust output");
  }

  const sessionHelp = run(
    [isolatedBinary, "session", "--help"],
    "compiled session help",
    isolated,
  );
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
  for (const name of ["gyst", "gyst-ask"]) {
    const link = join(home, ".agents", "skills", name);
    if (!(await lstat(link)).isSymbolicLink()) throw new Error(`${name} install is not a symlink`);
    if (resolve(dirname(link), await readlink(link)) !== join(isolated, "skills", name)) {
      throw new Error(`${name} install does not target packaged skills`);
    }
    if (!(await readFile(join(link, "SKILL.md"), "utf8")).includes(`name: ${name}`)) {
      throw new Error(`${name} packaged skill is unreadable`);
    }
  }
} finally {
  await rm(isolated, { recursive: true, force: true });
}

console.log("compile smoke OK — isolated OpenTUI frame, crust help, and packaged skill install");
