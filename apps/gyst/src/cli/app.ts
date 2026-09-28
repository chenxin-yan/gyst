import { Crust } from "@crustjs/core";
import { help, version } from "@crustjs/extensions";
import packageJson from "../../package.json" with { type: "json" };

import { daemon } from "./commands/daemon.ts";
import { session } from "./commands/session.ts";
import { coReviewSkill } from "./extensions/co-review-skill.ts";
import { jsonErrors } from "./extensions/json-errors.ts";

export { coReviewSkillOptions } from "./extensions/co-review-skill.ts";

export const app = new Crust("gyst", {
  description: "Keyboard-centric agent/human co-review",
  version: packageJson.version,
})
  .extend(jsonErrors, coReviewSkill)
  .extend(version(), help())
  .add(session)
  .add(daemon);
