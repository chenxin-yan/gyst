import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Scripts in package.json are the entry points; these back the ones that need task settings.
      "check:task": "vp check",
      // Vite+ does not fingerprint the Node runtime; PATH names the mise-selected version, so a run
      // on another Node reruns instead of replaying. A same-path in-place upgrade is not detected.
      "test:unit:task": { command: "vp test --project unit", cache: { env: ["PATH"] } },
      // E2E tests spawn daemons and read Git and temporary state that input tracking cannot see.
      "test:e2e:task": { command: "vp test --project e2e", cache: false },
    },
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    sortPackageJson: false,
    ignorePatterns: [".github/workflows/pullfrog.yml"],
  },
  test: {
    // Unit-only runs must not build or install the CLI.
    projects: [
      { extends: true, test: { name: "unit", include: ["{apps,packages}/*/src/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "e2e",
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
