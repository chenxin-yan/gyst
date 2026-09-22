// Publish the staged @gyst/cli packages, then let changesets tag the release.
// `crust publish` orders platform packages before the root and skips versions already on the
// registry, so a rerun after a partial failure finishes the cohort; `changeset git-tag` then
// writes the tag events changesets/action reads (CHANGESETS_OUTPUT) to create the GitHub release.
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const preState = await Bun.file(`${root}.changeset/pre.json`)
  .json()
  .catch(() => null);
// In prerelease mode the npm dist-tag is the pre tag, as changesets' own publish would do.
const tag: string[] = preState?.mode === "pre" ? ["--tag", preState.tag] : [];

await $`bun x crust publish ${tag}`.cwd(`${root}apps/gyst`);
await $`bun x changeset git-tag`.cwd(root);
