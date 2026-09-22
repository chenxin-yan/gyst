import { join } from "node:path";

// @crustjs/skills repairs global skill links before ordinary commands, resolving the universal
// root from homedir() and the Claude root from CLAUDE_CONFIG_DIR (XDG_CONFIG_HOME for others).
// Bun fixes homedir() at process start, so tests must spawn the app with this environment rather
// than mutate process.env in-process.
export const isolatedHome = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
});
