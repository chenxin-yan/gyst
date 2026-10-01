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
      // crust.include only takes directories inside this package, so the viewer build is copied in.
      "web-ui": {
        command: "rm -rf dist/web-ui && mkdir -p dist && cp -R ../web/dist dist/web-ui",
        dependsOn: ["@gyst/web#build:task"],
        cache: { input: ["../web/dist/**"], output: ["dist/web-ui/**"] },
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
