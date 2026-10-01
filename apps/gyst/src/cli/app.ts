import { Crust, defineArg } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { help, version } from "@crustjs/extensions";
import { BadArgs } from "@gyst/core";
import packageJson from "../../package.json" with { type: "json" };

import { browserOpener, serveViewer } from "../web/launcher.ts";
import { installedWebUiDir } from "../web/server.ts";
import { daemon } from "./commands/daemon.ts";
import { daemonClient, session } from "./commands/session.ts";
import { coReviewSkill } from "./extensions/co-review-skill.ts";
import { jsonErrors } from "./extensions/json-errors.ts";

export const app = new Crust("gyst", {
  description: "Keyboard-centric agent/human co-review",
  version: packageJson.version,
})
  .extend(jsonErrors, coReviewSkill)
  .extend(version(), help())
  .provide(daemonClient())
  .flags({
    name: "session",
    type: "string",
    description: "View this exact saved session id instead of selecting by scope",
  })
  .args(
    defineArg("range", {
      type: "string",
      description: "A Git range such as main...feature; omitted, uncommitted changes",
    }),
  )
  .action(
    handler(function* ({ args, flags, rawArgs, stdout }) {
      if (rawArgs.length > 0)
        return yield* new BadArgs({ message: "gyst takes at most one Git range" });
      if (flags.session !== undefined && args.range !== undefined)
        return yield* new BadArgs({ message: "choose a Git range or --session, not both" });
      yield* serveViewer(
        flags.session !== undefined
          ? { command: "open", session: flags.session }
          : {
              command: "open",
              cwd: process.cwd(),
              scope:
                args.range === undefined
                  ? { kind: "uncommitted" }
                  : { kind: "range", range: args.range },
            },
        {
          webUiDir: installedWebUiDir,
          opener: browserOpener(process.platform, process.env, process.stdout.isTTY),
          stdout,
        },
      );
    }),
  )
  .add(session)
  .add(daemon);
