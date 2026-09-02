import { render } from "@opentui/solid";
import { App } from "./app.tsx";
import { daemonTuiClient } from "./client.ts";

export async function renderTui(): Promise<void> {
  await render(() => <App client={daemonTuiClient()} onQuit={() => process.exit(0)} />);
}
