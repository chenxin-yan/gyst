import { Crust, defineArg } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { help, version } from "@crustjs/extensions";
import { BadArgs, OpenPayloadSchema } from "@gyst/core";
import { Effect, Schema } from "effect";
import packageJson from "../../package.json" with { type: "json" };

import { DaemonClient } from "../daemon/client.ts";
import { browserOpener, openBrowser } from "./browser.ts";
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
      description: "Open this exact saved session id instead of selecting by scope",
    },
    prFlag,
  )
  .args(defineArg("range", { type: "string", description: scopeArgDescription }))
  .action(
    handler(function* ({ args, flags, rawArgs, stdout }) {
      if (rawArgs.length > 0)
        return yield* new BadArgs({ message: "gyst takes at most one Git range" });
      const request = yield* openRequestOf({
        range: args.range,
        pr: flags.pr,
        session: flags.session,
      });
      const progress = terminalProgress(process.stderr);
      const client = yield* DaemonClient;
      const opened = yield* client
        .request(request, progress?.report)
        .pipe(Effect.ensuring(progress?.clear ?? Effect.void));
      // The client decoded this reply with `OpenPayloadSchema`; this only narrows its type.
      if (!Schema.is(OpenPayloadSchema)(opened)) return yield* Effect.die("not an open payload");
      const { link } = opened;
      const opener = browserOpener(process.platform, process.env, process.stdout.isTTY);
      const shown = opener !== undefined && (yield* openBrowser(opener, link));
      stdout(shown ? `Opened ${link} in your browser.` : link);
    }),
  )
  .add(session)
  .add(daemon);
