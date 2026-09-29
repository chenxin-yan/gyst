import { skill } from "@crustjs/skills";

export const coReviewSkill = skill({
  name: "gyst-cli",
  description: "Use for uncertain gyst command syntax or after a bad_args error.",
  extras: ["skills/gyst", "skills/gyst-ask", "skills/gyst-refresh"],
  defaultScope: "global",
});
