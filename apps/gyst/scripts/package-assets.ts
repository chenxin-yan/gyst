// Adds the package's non-code files: the packaged skills that crust's `skill()` extension serves
// from `<package>/.crust/root/skills` (as `crust build` would, without its Bun-based bundler), and
// the repository README, which pnpm does not pack from the workspace root as it does LICENSE.
import { writeSkills } from "@crustjs/skills";
import { readFile, writeFile } from "node:fs/promises";

import packageJson from "../package.json" with { type: "json" };
import { app, coReviewSkillOptions } from "../src/cli/app.ts";

const { name, description, extras } = coReviewSkillOptions;
await writeSkills({
  app,
  outDir: ".crust/root/skills",
  version: packageJson.version,
  name,
  description,
  extras,
});
await writeFile("README.md", await readFile("../../README.md"));
