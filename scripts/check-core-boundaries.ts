import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import { builtinModules } from "node:module";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..", "packages", "core", "src");
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const pureNodeBuiltins = new Set(["path"]);

function isForbidden(module: string, file: string): boolean {
  if (module.startsWith(".")) {
    const target = relative(root, resolve(dirname(file), module));
    if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return true;
  }
  const bare = module.replace(/^node:/, "");
  return (
    (nodeBuiltins.has(bare) && !pureNodeBuiltins.has(bare)) ||
    module === "bun" ||
    module.startsWith("bun:") ||
    module === "solid-js" ||
    module.startsWith("solid-js/") ||
    module.startsWith("@opentui/")
  );
}

export function findForbiddenImports(source: string, file = join(root, "index.ts")): string[] {
  const forbidden: string[] = [];
  const ast = parse(source, {
    sourceType: "module",
    plugins: /\.[jt]sx$/.test(file) ? ["typescript", "jsx"] : ["typescript"],
    createImportExpressions: true,
  });
  traverseFast(ast, (node) => {
    if (
      node.type !== "ImportDeclaration" &&
      node.type !== "ExportNamedDeclaration" &&
      node.type !== "ExportAllDeclaration" &&
      node.type !== "ImportExpression"
    )
      return;
    if (
      ("importKind" in node && node.importKind === "type") ||
      ("exportKind" in node && node.exportKind === "type")
    )
      return;
    if (
      "specifiers" in node &&
      node.specifiers.length > 0 &&
      node.specifiers.every(
        (specifier) =>
          (specifier.type === "ImportSpecifier" && specifier.importKind === "type") ||
          (specifier.type === "ExportSpecifier" && specifier.exportKind === "type"),
      )
    )
      return;

    const moduleSource = node.source;
    const module =
      moduleSource?.type === "StringLiteral"
        ? moduleSource.value
        : moduleSource?.type === "TemplateLiteral" && moduleSource.expressions.length === 0
          ? moduleSource.quasis[0]?.value.cooked
          : undefined;
    if (module != null) {
      if (isForbidden(module, file)) forbidden.push(module);
    } else if (node.type === "ImportExpression") {
      forbidden.push("<computed import>");
    }
  });
  return forbidden;
}

if (import.meta.main) {
  const violations: string[] = [];
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => join(root, file));
  for (const file of files) {
    if (findForbiddenImports(await Bun.file(file).text(), file).length > 0) {
      violations.push(relative(root, file));
    }
  }

  if (violations.length > 0) {
    console.error(
      `packages/core must stay I/O-free; forbidden imports in: ${violations.join(", ")}`,
    );
    process.exit(1);
  }
  console.log("core boundary OK");
}
