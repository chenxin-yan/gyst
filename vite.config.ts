import { defineConfig } from "vite-plus";

export default defineConfig({
  // Canonical commands: `vp run check`, `vp run test`, `vp run @gyst/cli#build`.
  run: {
    tasks: {
      check: "vp check",
      // Tests spawn daemons and read Git and temporary state that input tracking cannot see.
      test: { command: "vp test", cache: false },
    },
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    sortPackageJson: false,
    ignorePatterns: [".github/workflows/pullfrog.yml"],
  },
  test: {
    // Only the installed project builds (through the cached task), packs and globally installs the
    // CLI once per run, so `vp test --project unit` never builds.
    projects: [
      { extends: true, test: { name: "unit", include: ["{apps,packages}/*/src/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "installed",
          include: ["apps/gyst/tests/**/*.test.ts"],
          globalSetup: ["apps/gyst/tests/e2e/global-setup.ts"],
        },
      },
    ],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: "deny",
    },
    plugins: ["unicorn", "typescript", "oxc", "import", "promise", "node"],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      "eslint/no-restricted-properties": [
        "error",
        {
          object: "Reflect",
          property: "apply",
          message:
            "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
        },
        {
          object: "Reflect",
          property: "get",
          message:
            "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
        },
        {
          object: "Reflect",
          property: "set",
          message:
            "Replace `Reflect.set` with typed property assignment. Parse dynamic input into a named domain type before writing it.",
        },
      ],
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/no-base-to-string": "off",
      "typescript/consistent-return": "off",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/restrict-template-expressions": "off",

      "import/no-cycle": "error",
      "promise/no-multiple-resolved": "error",
      "typescript/no-import-type-side-effects": "error",
      "oxc/bad-bitwise-operator": "error",
      "oxc/no-accumulating-spread": "error",

      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],

      "promise/always-return": "off",
    },
    overrides: [
      {
        files: ["**/*.test.ts", "**/tests/**/*.ts"],
        rules: {
          "eslint/no-shadow": "off",
          "typescript/await-thenable": "off",
        },
      },
    ],
  },
});
