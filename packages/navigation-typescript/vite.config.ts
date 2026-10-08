import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "build:task": {
        // A plain CLI, not a Crust app: it has no Command Snapshot for the build to validate.
        command: "crust build --no-validate",
        // Crust bundles with Bun, whose file reads Vite+ doesn't track on Linux
        // (https://github.com/voidzero-dev/vite-task/issues/777).
        cache: {
          input: [{ auto: true }, "src/**", "package.json", "tsconfig.json", "!.crust/**"],
          output: [".crust/**"],
        },
      },
    },
  },
});
