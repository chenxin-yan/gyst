import { describe, expect, test } from "bun:test";
import { findForbiddenImports } from "./check-core-boundaries";

describe("core import boundary", () => {
  test("parses imports without matching comments", () => {
    expect(findForbiddenImports('// from "node:fs"\nconst note = `import("node:http")`;')).toEqual([]);
    expect(findForbiddenImports('import /* comment */ { readFile } from "node:fs";')).toEqual([
      "node:fs",
    ]);
  });

  test("blocks dynamic and effectful Node imports", () => {
    const source = ['await import("node:http")', 'import dns from "node:dns"'].join(";");
    expect(findForbiddenImports(source).sort()).toEqual(["node:dns", "node:http"]);
  });

  test("allows pure domain dependencies", () => {
    expect(findForbiddenImports('import { join } from "node:path"; import { Effect } from "effect";')).toEqual(
      [],
    );
  });
});
