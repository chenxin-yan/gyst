import { runTui } from "@crustjs/tui";
import { render } from "@opentui/solid";
import { App } from "./app.tsx";
import { daemonTuiClient } from "./client.ts";

export async function renderTui(): Promise<void> {
  await runTui((renderer) =>
    render(() => <App client={daemonTuiClient()} onQuit={() => renderer.destroy()} />, renderer),
  );
}
