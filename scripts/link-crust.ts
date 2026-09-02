import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const checkout = process.env.CRUST_CHECKOUT;
if (!checkout) {
  console.error("CRUST_CHECKOUT must point to the local crust checkout");
  process.exit(1);
}

const globalBin = Bun.spawnSync(["bun", "pm", "bin", "-g"], { stdout: "pipe", stderr: "inherit" });
if (globalBin.exitCode !== 0) process.exit(globalBin.exitCode);
const linkRoot = join(
  dirname(globalBin.stdout.toString().trim()),
  "install",
  "global",
  "node_modules",
  "@crustjs",
);
mkdirSync(linkRoot, { recursive: true });

for (const name of ["core", "extensions", "skills"]) {
  const packageDir = resolve(checkout, "packages", name);
  if (!existsSync(join(packageDir, "dist", "index.js"))) {
    console.error(
      `Built crust package not found at ${packageDir}; install and build the crust workspace first`,
    );
    process.exit(1);
  }

  const target = join(linkRoot, name);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === packageDir) {
    console.log(`already linked @crustjs/${name} from ${packageDir}`);
    continue;
  }
  if (existing) {
    const kind = existing.isSymbolicLink()
      ? `a link to ${readlinkSync(target)}`
      : existing.isDirectory()
        ? "a directory"
        : "a file";
    console.error(
      `${target} already exists and is ${kind}; remove it or set an isolated BUN_INSTALL before linking @crustjs/${name}`,
    );
    process.exit(1);
  }
  symlinkSync(packageDir, target, "dir");
  console.log(`linked @crustjs/${name} from ${packageDir}`);
}
