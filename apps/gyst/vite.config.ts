import { defineConfig } from "vite-plus";

// TODO: drop the explicit inputs once Vite+ tracks Bun's file reads on Linux
// (https://github.com/voidzero-dev/vite-task/issues/777); Crust bundles with Bun.
const coreInputs = [
  "../../packages/core/src/**",
  "../../packages/core/package.json",
  "../../packages/core/tsconfig.json",
  "../../tsconfig.json",
  "../../pnpm-lock.yaml",
];

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
      "web-ui": {
        command: "vp build src/web-ui",
        cache: {
          input: [
            { auto: true },
            "src/web-ui/**",
            "src/web/contract.ts",
            ...coreInputs,
            "!dist/**",
          ],
          output: ["dist/web-ui/**"],
        },
      },
      "build:task": {
        command: "crust build",
        // crust.include copies the viewer, so it must be built first.
        dependsOn: ["package-docs", "web-ui"],
        cache: {
          input: [
            { auto: true },
            "src/**",
            "tsconfig.json",
            "dist/web-ui/**",
            ...coreInputs,
            "!.crust/**",
          ],
          output: [".crust/**"],
        },
      },
    },
  },
});
