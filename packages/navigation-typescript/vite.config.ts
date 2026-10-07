import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "build:task": {
        command: "vp pack",
        cache: { input: [{ auto: true }, "src/**", "!src/**/*.test.ts"], output: ["dist/**"] },
      },
    },
  },
  // The engine stays a dependency: it brings native binaries the CLI runs, never imports. The
  // manifest is read where it is installed, so the release a copy reports is its package.json's.
  pack: {
    entry: ["src/cli.ts"],
    platform: "node",
    format: "esm",
    deps: { neverBundle: ["../package.json"] },
  },
});
