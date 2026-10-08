import { defineCommand } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { CapturedContent } from "../../daemon/content.ts";
import { Git } from "../../daemon/git.ts";
import { GitHub } from "../../daemon/github.ts";
import { Navigation } from "../../daemon/navigation.ts";
import { Paths } from "../../daemon/paths.ts";
import { DaemonServer } from "../../daemon/server.ts";
import { Sessions } from "../../daemon/sessions.ts";
import { SessionStore } from "../../daemon/store.ts";

const daemonServer = layer(
  "daemonServer",
  DaemonServer.layer.pipe(
    Layer.provide(
      Navigation.layer.pipe(
        Layer.provideMerge(Sessions.layer),
        Layer.provideMerge(
          Layer.mergeAll(Git.layer, GitHub.layer, SessionStore.layer).pipe(
            Layer.provideMerge(CapturedContent.layer),
          ),
        ),
      ),
    ),
    Layer.provide(Paths.layer),
    Layer.provide(NodeServices.layer),
  ),
);

const run = defineCommand("run", { description: "Run the session daemon" }, (command) =>
  command.provide(daemonServer()).action(handler(() => DaemonServer.use((server) => server.run))),
);

/** Spawned detached by the client; hidden from help, completions and skill manifests. */
export const daemon = defineCommand(
  "daemon",
  { description: "Internal", hidden: true },
  (command) => command.add(run),
);
