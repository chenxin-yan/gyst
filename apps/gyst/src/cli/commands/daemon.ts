import { defineCommand } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { Git } from "../../daemon/git.ts";
import { Paths } from "../../daemon/paths.ts";
import { DaemonServer } from "../../daemon/server.ts";
import { Sessions } from "../../daemon/sessions.ts";
import { SessionStore } from "../../daemon/store.ts";

const daemonServer = layer(
  "daemonServer",
  DaemonServer.layer.pipe(
    Layer.provide(
      Sessions.layer.pipe(Layer.provide(Layer.mergeAll(Git.layer, SessionStore.layer))),
    ),
    Layer.provide(Paths.layer),
    Layer.provide(BunServices.layer),
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
