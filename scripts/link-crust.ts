import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const checkout = process.env.CRUST_CHECKOUT;
if (!checkout) {
  console.error("CRUST_CHECKOUT must point to the local crust checkout");
  process.exit(1);
}

const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
const linkRoot = join(bunInstall, "install", "global", "node_modules", "@crustjs");
mkdirSync(linkRoot, { recursive: true });

for (const name of ["core", "extensions"]) {
  const packageDir = resolve(checkout, "packages", name);
  if (!existsSync(join(packageDir, "dist", "index.js"))) {
    console.error(
      `Built crust package not found at ${packageDir}; install and build the crust workspace first`,
    );
    process.exit(1);
  }

  const target = join(linkRoot, name);
  rmSync(target, { recursive: true, force: true });
  symlinkSync(packageDir, target, "dir");
  console.log(`linked @crustjs/${name} from ${packageDir}`);
}
