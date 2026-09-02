import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "packages", "core", "src");
const forbidden = /(?:from\s*|import\s*(?:\(\s*)?)["'](?:(?:node:)?(?:fs(?:\/promises)?|net|dgram|child_process)|bun|solid-js|@opentui\/)/;

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

const violations: string[] = [];
for (const file of await sourceFiles(root)) {
  if (forbidden.test(await Bun.file(file).text())) violations.push(relative(root, file));
}

if (violations.length > 0) {
  console.error(`packages/core must stay I/O-free; forbidden imports in: ${violations.join(", ")}`);
  process.exit(1);
}
console.log("core boundary OK");
