import { skill } from "@crustjs/skills";

// Authored workflow skills ship next to the generated `gyst-cli` command reference.
export const coReviewSkill = skill({
  name: "gyst-cli",
  description: "Use for uncertain gyst command syntax or after a bad_args error.",
  extras: ["skills/gyst", "skills/gyst-ask", "skills/gyst-refresh"],
  defaultScope: "global",
});
