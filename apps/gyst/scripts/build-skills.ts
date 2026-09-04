import { writeSkills } from "@crustjs/skills";
import { join } from "node:path";

import { app, authoredSkillDirs } from "../src/cli/app.ts";

await writeSkills({ app, outDir: join(import.meta.dir, "../dist/skills"), extras: authoredSkillDirs });
