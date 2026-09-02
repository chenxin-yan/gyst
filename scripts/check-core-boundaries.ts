import { builtinModules } from "node:module";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "packages", "core", "src");
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const pureNodeBuiltins = new Set(["path"]);

function isForbidden(module: string): boolean {
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

export function findForbiddenImports(source: string): string[] {
  return new Bun.Transpiler({ loader: "tsx" })
    .scan(source)
    .imports.map(({ path }) => path)
    .filter(isForbidden);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

if (import.meta.main) {
  const violations: string[] = [];
  for (const file of await sourceFiles(root)) {
    if (findForbiddenImports(await Bun.file(file).text()).length > 0) {
      violations.push(relative(root, file));
    }
  }

  if (violations.length > 0) {
    console.error(`packages/core must stay I/O-free; forbidden imports in: ${violations.join(", ")}`);
    process.exit(1);
  }
  console.log("core boundary OK");
}
