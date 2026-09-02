import { Crust, defineCommand, type CommandSnapshot } from "@crustjs/core";
import { buildCommandDocumentation } from "@crustjs/core/tooling";

import { renderCompileSmoke } from "../tui/compile-smoke.tsx";

const helpFlag = {
  name: "help",
  type: "boolean",
  short: "h",
  noNegate: true,
  description: "Show help",
} as const;

function renderHelp(command: CommandSnapshot, path?: readonly string[]): string {
  const docs = buildCommandDocumentation(command, path);
  const lines = [docs.description ? `${docs.path.join(" ")} - ${docs.description}` : docs.path.join(" "), "", "Usage:", `  ${docs.usage}`];
  if (docs.children.length > 0) {
    lines.push("", "Commands:", ...docs.children.map((child) => `  ${child.name.padEnd(12)} ${child.description ?? ""}`.trimEnd()));
  }
  if (docs.flags.length > 0) {
    lines.push("", "Options:", ...docs.flags.map((flag) => `  ${flag.spellings.join(", ").padEnd(18)} ${flag.description ?? ""}`.trimEnd()));
  }
  return lines.join("\n");
}

const session = defineCommand(
  "session",
  { description: "Manage a co-review session" },
  (command) =>
    command.flags(helpFlag).action(({ command, rootCommand, stdout }) => {
      stdout(renderHelp(command, [rootCommand.meta.name, command.meta.name]));
    }),
);

export const app = new Crust("gyst", {
  description: "Keyboard-centric agent/human co-review",
})
  .flags(helpFlag)
  .add(session)
  .action(async ({ flags, rootCommand, stdout }) => {
    if (flags.help) return stdout(renderHelp(rootCommand));
    await renderCompileSmoke();
  });
