import { defineConfig } from "vite-plus";

import core from "../../packages/core/package.json" with { type: "json" };
import cli from "./package.json" with { type: "json" };

// The private workspace core is bundled; every other import stays an npm dependency of the
// published package, so the installed CLI shares one Effect instance with crust.
const publishedDependencies = Object.keys({ ...cli.dependencies, ...core.dependencies }).filter(
  (name) => name !== "@gyst/core",
);

export default defineConfig({
  pack: {
    // `cli` is the installed executable (also `gyst daemon run`); `app` is the side-effect-free
    // command tree that scripts/stage-package.mjs renders into skills.
    entry: { cli: "src/index.ts", app: "src/cli/app.ts" },
    platform: "node",
    target: "node24.11",
    dts: false,
    deps: {
      neverBundle: true,
      alwaysBundle: ["@gyst/core"],
      onlyImport: publishedDependencies,
    },
  },
});
