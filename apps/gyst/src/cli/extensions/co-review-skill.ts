import { skill } from "@crustjs/skills";

// Authored workflow skills ship next to the generated `gyst-cli` command reference. Exported so
// package staging renders the same skills without a second copy of these options.
export const coReviewSkillOptions = {
  name: "gyst-cli",
  description: "Use for uncertain gyst command syntax or after a bad_args error.",
  extras: ["skills/gyst", "skills/gyst-ask", "skills/gyst-refresh"],
  defaultScope: "global",
} as const;

export const coReviewSkill = skill(coReviewSkillOptions);
