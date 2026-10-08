import { skill } from "@crustjs/skills";

export const coReviewSkill = skill({
  name: "gyst-cli",
  description:
    "Use for exact gyst command syntax, the session apply envelope and its ops, JSON output and error codes, or after a bad_args error.",
  extras: ["skills/gyst", "skills/gyst-respond"],
  defaultScope: "global",
});
