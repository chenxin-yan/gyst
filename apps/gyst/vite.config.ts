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
        // Crust's embedded bundler reads source files outside Vite+'s automatic tracking.
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
