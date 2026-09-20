import { skill } from "@crustjs/skills";
import { join } from "node:path";

// Resolved at `crust build` time, when the extension copies the authored skills into the package.
const authoredSkills = join(import.meta.dir, "../../../../../skills");

export const coReviewSkill = skill({
  extras: [join(authoredSkills, "gyst"), join(authoredSkills, "gyst-ask")],
  defaultScope: "global",
});
