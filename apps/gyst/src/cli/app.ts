import { Crust, defineCommand } from "@crustjs/core";
import { help, version } from "@crustjs/extensions";
import packageJson from "../../package.json" with { type: "json" };

import { renderCompileSmoke } from "../tui/compile-smoke.tsx";

const session = defineCommand("session", { description: "Manage a co-review session" }, (command) => command);

export const app = new Crust("gyst", {
  description: "Keyboard-centric agent/human co-review",
})
  .extend(help())
  .extend(version(packageJson.version))
  .add(session)
  .action(renderCompileSmoke);
