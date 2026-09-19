import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findForbiddenImports } from "./check-core-boundaries";

describe("core import boundary", () => {
  test("parses imports without matching comments", () => {
    expect(findForbiddenImports('// from "node:fs"\nconst note = `import("node:http")`;')).toEqual(
      [],
    );
    expect(findForbiddenImports('import /* comment */ { readFile } from "node:fs";')).toEqual([
      "node:fs",
    ]);
  });

  test("parses TypeScript assertions and TSX according to the filename", () => {
    expect(findForbiddenImports('const value = <number>1; import "node:fs";')).toEqual(["node:fs"]);
    const file = join(import.meta.dir, "../packages/core/src/view.tsx");
    expect(findForbiddenImports('const view = <div />; import "node:fs";', file)).toEqual([
      "node:fs",
    ]);
  });

  test("blocks dynamic and effectful Node imports", () => {
    const source = ['await import("node:http")', 'import dns from "node:dns"'].join(";");
    expect(findForbiddenImports(source).sort()).toEqual(["node:dns", "node:http"]);
  });

  test("rejects computed imports without mistaking comments or strings for code", () => {
    for (const source of ["import(name)", "import(`node:${name}`)", 'import("node:" + name)']) {
      expect(findForbiddenImports(source)).toEqual(["<computed import>"]);
    }
    expect(findForbiddenImports('const note = "import(name)"; // import(name)')).toEqual([]);
    expect(findForbiddenImports("import(`node:fs`)")).toEqual(["node:fs"]);
  });

  test("resolves relative imports and re-exports from the importing file", () => {
    const file = join(import.meta.dir, "../packages/core/src/nested/module.ts");
    expect(findForbiddenImports('import "../index.ts"; export * from "./local.ts"', file)).toEqual(
      [],
    );
    for (const source of [
      'import "../../../../apps/gyst/src/tui/compile-smoke.tsx"',
      'export * from "../../outside.ts"',
      'await import("../../src-other/index.ts")',
    ]) {
      expect(findForbiddenImports(source, file)).toHaveLength(1);
    }
  });

  test("rejects absolute imports, re-exports, and dynamic imports", () => {
    const outside = JSON.stringify(
      join(import.meta.dir, "..", "apps", "gyst", "src", "tui", "compile-smoke.tsx"),
    );
    for (const source of [
      `import ${outside}`,
      `export * from ${outside}`,
      `await import(${outside})`,
    ]) {
      expect(findForbiddenImports(source)).toEqual([JSON.parse(outside)]);
    }
  });

  test("rejects bare packages and subpaths outside the allowlist", () => {
    const source = [
      'import "oxfmt"',
      'export * from "typescript"',
      'await import("effect/Schema")',
      'import "node:path/posix"',
    ].join(";");
    expect(findForbiddenImports(source).sort()).toEqual([
      "effect/Schema",
      "node:path/posix",
      "oxfmt",
      "typescript",
    ]);
    expect(
      findForbiddenImports('import type { X } from "solid-js"; import type { Y } from "oxfmt";'),
    ).toEqual([]);
  });

  test("preserves type-only imports and checks runtime re-exports", () => {
    expect(
      findForbiddenImports(
        'import type { X } from "node:fs"; export type { Y } from "node:http"; import { type Z } from "node:os";',
      ),
    ).toEqual([]);
    expect(
      findForbiddenImports('export { readFile } from "node:fs"; export * from "node:http";').sort(),
    ).toEqual(["node:fs", "node:http"]);
  });

  test("allows pure domain dependencies", () => {
    expect(
      findForbiddenImports('import { join } from "node:path"; import { Effect } from "effect";'),
    ).toEqual([]);
  });
});
