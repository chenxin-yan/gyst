import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "package-docs": {
        command: "cp ../../README.md ../../LICENSE .",
        cache: {
          input: ["../../README.md", "../../LICENSE"],
          output: ["README.md", "LICENSE"],
        },
      },
      build: {
        command: "crust build",
        dependsOn: ["package-docs"],
        // TODO: drop the explicit inputs once Vite+ tracks Bun's file reads on Linux
        // (https://github.com/voidzero-dev/vite-task/issues/777); Crust bundles with Bun.
        cache: {
          input: [
            { auto: true },
            "src/**",
            "tsconfig.json",
            "../../packages/core/src/**",
            "../../packages/core/package.json",
            "../../packages/core/tsconfig.json",
            "../../tsconfig.json",
            "../../pnpm-lock.yaml",
            "!.crust/**",
          ],
          output: [".crust/**"],
        },
      },
    },
  },
});
