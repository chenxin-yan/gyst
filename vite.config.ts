import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Scripts in package.json are the entry points; these back the ones that need task settings.
      "check:task": "vp check",
      "test:unit:task": "vp test --project unit",
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
      {
        extends: true,
        test: {
          name: "unit",
          include: ["{apps,packages}/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["apps/gyst/tests/**/*.test.ts"],
          // Files share one private install, and session.test.ts counts that install's daemons.
          fileParallelism: false,
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
      // Annotated return types already make TypeScript check every path; this JS-era rule only
      // misfires on exhaustive switches and on effects that return a cleanup on one branch.
      "typescript/consistent-return": "off",
      // `.then` callbacks that only set state are fine; the rule demands a return value anyway.
      "promise/always-return": "off",

      "import/no-cycle": "error",
      "typescript/no-import-type-side-effects": "error",
      "oxc/bad-bitwise-operator": "error",
      "oxc/no-accumulating-spread": "error",
      "typescript/no-misused-promises": "error",
      "typescript/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
    overrides: [
      {
        files: ["apps/web/**"],
        jsPlugins: ["@stylexjs/eslint-plugin"],
        rules: {
          // Vite loads stylesheets through side-effect imports.
          "import/no-unassigned-import": ["error", { allow: ["**/*.css"] }],
          // TypeScript accepts any key and value in stylex.create; only these rules check them.
          "@stylexjs/valid-styles": "error",
          "@stylexjs/no-unused": "error",
        },
      },
    ],
  },
});
