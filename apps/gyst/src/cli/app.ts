import { Crust, defineArg } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { help, version } from "@crustjs/extensions";
import { BadArgs } from "@gyst/core";
import packageJson from "../../package.json" with { type: "json" };

import { browserOpener, serveViewer, type ViewerOpen } from "../web/launcher.ts";
import { installedWebUiDir } from "../web/server.ts";
import { daemon } from "./commands/daemon.ts";
import {
  daemonClient,
  openRequestOf,
  prFlag,
  scopeArgDescription,
  session,
  terminalProgress,
} from "./commands/session.ts";
import { coReviewSkill } from "./extensions/co-review-skill.ts";
import { jsonErrors } from "./extensions/json-errors.ts";

const launch = (request: ViewerOpen, stdout: (line: string) => void) =>
  serveViewer(request, {
    webUiDir: installedWebUiDir,
    opener: browserOpener(process.platform, process.env, process.stdout.isTTY),
    stdout,
    progress: terminalProgress(process.stderr),
  });

export const app = new Crust("gyst", {
  description: "Keyboard-centric agent/human co-review",
  version: packageJson.version,
})
  .extend(jsonErrors, coReviewSkill)
  .extend(version(), help())
  .provide(daemonClient())
  .flags(
    {
      name: "session",
      type: "string",
      description: "View this exact saved session id instead of selecting by scope",
    },
    prFlag,
  )
  .args(defineArg("range", { type: "string", description: scopeArgDescription }))
  .action(
    handler(function* ({ args, flags, rawArgs, stdout }) {
      if (rawArgs.length > 0)
        return yield* new BadArgs({ message: "gyst takes at most one Git range" });
      yield* launch(
        yield* openRequestOf({ range: args.range, pr: flags.pr, session: flags.session }),
        stdout,
      );
    }),
  )
  .add(session)
  .add(daemon);
