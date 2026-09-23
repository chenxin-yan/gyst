import { skill } from "@crustjs/skills";

// Authored workflow skills ship next to the generated `gyst-cli` command reference.
export const coReviewSkill = skill({
  name: "gyst-cli",
  description:
    "Use before running a gyst command whose exact arguments, flags or subcommands are uncertain, and after a gyst call fails with bad_args.",
  extras: ["skills/gyst", "skills/gyst-ask", "skills/gyst-refresh"],
  defaultScope: "global",
});
