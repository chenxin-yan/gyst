import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const checkout = process.env.CRUST_CHECKOUT;
if (!checkout) {
  console.error("CRUST_CHECKOUT must point to the local crust checkout");
  process.exit(1);
}

const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
const linkRoot = join(bunInstall, "install", "global", "node_modules", "@crustjs");
mkdirSync(linkRoot, { recursive: true });

for (const name of ["core", "extensions", "skills", "crust"]) {
  const packageDir = join(checkout, "packages", name);
  const builtEntry = name === "crust" ? join(packageDir, "dist", "cli.js") : join(packageDir, "dist", "index.js");
  if (!existsSync(builtEntry)) {
    console.error(`Built crust package not found at ${packageDir}; install and build the crust workspace first`);
    process.exit(1);
  }

  const target = join(linkRoot, name);
  rmSync(target, { recursive: true, force: true });
  symlinkSync(packageDir, target, "dir");
  console.log(`linked @crustjs/${name} from ${packageDir}`);
}
