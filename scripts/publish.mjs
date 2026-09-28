// Publish the staged @gyst/cli package, then let changesets tag the release.
// A version already on the registry is skipped, so a rerun after a partial failure still tags;
// `changeset git-tag` then writes the tag events changesets/action reads (CHANGESETS_OUTPUT) to
// create the GitHub release. `npm run build` must have staged apps/gyst/stage first.
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = `${root}apps/gyst/stage`;
const { name, version } = JSON.parse(await readFile(`${stage}/package.json`, "utf8"));
const preState = await readFile(`${root}.changeset/pre.json`, "utf8").then(JSON.parse, () => null);
// In prerelease mode the npm dist-tag is the pre tag, as changesets' own publish would do.
const tag = preState?.mode === "pre" ? ["--tag", preState.tag] : [];

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
// npm reports E404 for an unpublished version; any other failure must stop the release.
const view = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
  cwd: root,
  encoding: "utf8",
});
if (view.status !== 0 && !view.stderr.includes("E404")) {
  throw new Error(`npm view ${name}@${version} failed:\n${view.stderr}`);
}

if (view.stdout.trim() === version) {
  console.log(`${name}@${version} is already published; skipping.`);
} else {
  run("npm", ["publish", stage, ...tag]);
}
run("npx", ["changeset", "git-tag"]);
