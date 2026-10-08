#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type Manifest = { name: string; version: string; dependencies: { typescript: string } };
// Read where the add-on is installed rather than bundled, so a copy reports its own release.
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Manifest;

/** The handshake and launch contract; gyst's `navigationAddon.protocol` must equal it. */
const protocol = 1;
const pinnedEngine = packageJson.dependencies.typescript;

// The engine's Automatic Type Acquisition runs `npm install` from PATH. gyst also turns it off in
// the engine's settings; with no PATH there is no package manager to run even if a setting is
// ignored.
const engineEnv = { ...process.env };
delete engineEnv.PATH;

/** The pinned engine's `tsc`, resolved from this add-on's own install, never the reviewed project. */
const engineBin = () =>
  join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

type EngineCheck = { ok: true; version: string } | { ok: false; problem: string };

/** Runs the engine, so a missing native platform package is reported rather than assumed away. */
const engineCheck = () =>
  new Promise<EngineCheck>((resolve) => {
    let bin: string;
    try {
      bin = engineBin();
    } catch {
      resolve({
        ok: false,
        problem: `TypeScript ${pinnedEngine} is not installed with the add-on`,
      });
      return;
    }
    execFile(
      process.execPath,
      [bin, "--version"],
      // Under gyst's 5 second handshake bound, so a slow engine is reported, not timed out.
      { env: engineEnv, timeout: 4000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const lines = stderr.split("\n").map((line) => line.trim());
          // Not `error.message`: it restates the command line, host paths included.
          const reason =
            lines.find((line) => /^\w*Error\b/.test(line)) ??
            `it exited with ${error.code ?? error.signal}`;
          resolve({ ok: false, problem: `TypeScript did not start: ${reason}` });
          return;
        }
        const version = /^Version (\S+)$/.exec(stdout.trim())?.[1];
        if (version === pinnedEngine) resolve({ ok: true, version });
        else
          resolve({
            ok: false,
            problem: `TypeScript reported ${JSON.stringify(stdout.trim())}, not ${pinnedEngine}`,
          });
      },
    );
  });

const [command, ...rest] = process.argv.slice(2);
if (command === "--version" && rest.length === 0) {
  const engine = await engineCheck();
  process.stdout.write(
    `${JSON.stringify({ name: packageJson.name, version: packageJson.version, protocol, engine })}\n`,
  );
} else if (command === "lsp" && rest.length === 2 && rest[0] === "--expect") {
  // gyst validated this executable's handshake earlier; refusing here closes the window in which
  // the install was replaced by another release before the daemon started it.
  if (rest[1] !== packageJson.version) {
    process.stderr.write(
      `${packageJson.name} ${packageJson.version} was started by gyst ${rest[1]}; install the matching release.\n`,
    );
    process.exit(2);
  }
  if (process.execve === undefined) {
    process.stderr.write(`${packageJson.name} needs a Node.js with process.execve.\n`);
    process.exit(1);
  }
  // Replacing this process keeps the PID gyst spawned, so stopping it stops the engine.
  process.execve(process.execPath, [process.execPath, engineBin(), "--lsp", "--stdio"], engineEnv);
} else {
  process.stderr.write("usage: gyst-navigation-typescript --version | lsp --expect <version>\n");
  process.exit(2);
}
