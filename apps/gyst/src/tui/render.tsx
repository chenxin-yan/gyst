import { constants } from "node:os";
import { runTui } from "@crustjs/tui";
import { BunServices } from "@effect/platform-bun";
import { destroyTreeSitterClient } from "@opentui/core";
import { render } from "@opentui/solid";
import { Layer, ManagedRuntime } from "effect";
import { DaemonClient } from "../daemon/client.ts";
import { Paths } from "../daemon/paths.ts";
import { App } from "./app.tsx";
import { daemonTuiClient } from "./client.ts";
import { registerParsers } from "./parsers.ts";
import { editorHandoff } from "./editor.ts";

/** One runtime for the TUI's lifetime: every poll and keypress shares the built client services. */
export async function renderTui(): Promise<void> {
  await using runtime = ManagedRuntime.make(
    DaemonClient.layer.pipe(Layer.provide(Paths.layer), Layer.provide(BunServices.layer)),
  );
  let cancelled = false;
  let handoff: ReturnType<typeof editorHandoff> | undefined;
  let terminated: NodeJS.Signals | undefined;
  registerParsers();
  try {
    // The App owns Ctrl+C so queued verdicts drain before the renderer goes; crust still sees the cancellation.
    await runTui(
      (renderer) => {
        const editor = (handoff = editorHandoff(renderer, (signal) => {
          terminated ??= signal;
        }));
        return render(
          () => (
            <App
              client={daemonTuiClient(runtime)}
              onEdit={(request) => editor.edit(request)}
              onQuit={(byCtrlC) => {
                cancelled = byCtrlC;
                renderer.destroy();
              }}
            />
          ),
          renderer,
        );
      },
      { exitOnCtrlC: false },
    );
  } finally {
    await handoff?.shutdown();
    // The highlighter's worker would otherwise keep the process alive after the renderer is gone.
    await destroyTreeSitterClient();
  }
  if (terminated) process.exitCode = 128 + (constants.signals[terminated] ?? 1);
  else if (cancelled) throw Object.assign(new Error("TUI cancelled"), { name: "AbortError" });
}
