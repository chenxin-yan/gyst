import { existsSync } from "node:fs";
import { join } from "node:path";

const checkout = process.env.CRUST_CHECKOUT;
if (!checkout) {
  console.error("CRUST_CHECKOUT must point to the local crust checkout");
  process.exit(1);
}

const core = join(checkout, "packages", "core");
if (!existsSync(join(core, "dist", "index.js"))) {
  console.error(`Built crust core not found at ${core}; install and build the crust workspace first`);
  process.exit(1);
}

const result = Bun.spawnSync(["bun", "link"], { cwd: core, stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);
console.log(`linked @crustjs/core from ${core}`);
