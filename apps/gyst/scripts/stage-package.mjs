// Runs after `vp pack`: renders packaged skills from the built app, then assembles the publishable
// @gyst/cli directory in `stage/` (`npm pack ./apps/gyst/stage`). The staged manifest drops the
// private workspace core, which `vp pack` bundled, and inherits its npm dependencies instead.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { writeSkills } from "@crustjs/skills";

const appDir = new URL("../", import.meta.url);
const repoDir = new URL("../../", appDir);
const stageDir = new URL("stage/", appDir);
const skillsDir = new URL(".crust/root/skills/", appDir);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const manifest = await readJson(new URL("package.json", appDir));
const core = await readJson(new URL("packages/core/package.json", repoDir));

// crust's runtime reads skills from `<installed package>/.crust/root/skills`.
// Name, description and extras mirror `coReviewSkill` in src/cli/extensions/co-review-skill.ts.
const { app } = await import(new URL("dist/app.mjs", appDir).href);
await writeSkills({
  app,
  outDir: fileURLToPath(skillsDir),
  version: manifest.version,
  name: "gyst-cli",
  description: "Use for uncertain gyst command syntax or after a bad_args error.",
  extras: ["gyst", "gyst-ask", "gyst-refresh"].map((name) => new URL(`skills/${name}`, appDir)),
});

const dependencies = { ...manifest.dependencies };
delete dependencies[core.name];
for (const [name, range] of Object.entries(core.dependencies)) {
  if (dependencies[name] !== undefined && dependencies[name] !== range) {
    throw new Error(
      `${name} is ${dependencies[name]} in ${manifest.name} but ${range} in ${core.name}`,
    );
  }
  dependencies[name] = range;
}
const published = { ...manifest, dependencies };
delete published.scripts;

await rm(stageDir, { recursive: true, force: true });
await cp(new URL("dist/", appDir), new URL("dist/", stageDir), { recursive: true });
await cp(skillsDir, new URL(".crust/root/skills/", stageDir), { recursive: true });
await cp(new URL("README.md", repoDir), new URL("README.md", stageDir));
await cp(new URL("LICENSE", repoDir), new URL("LICENSE", stageDir));
await writeFile(new URL("package.json", stageDir), `${JSON.stringify(published, null, 2)}\n`);
