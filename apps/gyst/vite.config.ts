import { defineConfig } from "vite-plus";

// `vp pack` defaults: bundles src/index.ts and the devDependency @gyst/core into dist/index.mjs,
// keeping `dependencies` external so the installed CLI shares one Effect instance with crust.
export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack && node scripts/package-assets.ts",
        // Skill rendering reads its previous output before replacing it.
        cache: { input: [{ auto: true }, "!.crust/**", "!README.md"] },
      },
    },
  },
});
