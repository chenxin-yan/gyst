import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const binary = join(root, "dist", "gyst");
await mkdir(join(root, "dist"), { recursive: true });

function run(command: string[], label: string, cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
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
  await chmod(isolatedBinary, 0o755);

  const frame = run([isolatedBinary], "compiled OpenTUI frame", isolated);
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
} finally {
  await rm(isolated, { recursive: true, force: true });
}

console.log("compile smoke OK — isolated native OpenTUI frame + crust root/session help");
