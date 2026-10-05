// `pnpm dev` and `apps/gyst/dev/gyst`: a source-run gyst launcher behind the Vite dev server. The
// browser opens the launch's own `g-<hex>.localhost` hostname on Vite's port, so Vite serves the
// viewer with Fast Refresh and proxies the bridge paths with their Host and Origin unchanged: the
// launcher authenticates them exactly as it does a browser behind an SSH forward.
import { webPaths } from "@gyst/core/web";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Plugin } from "vite-plus";

const checkout = resolve(import.meta.dirname, "../..");
// apps/gyst/dev/gyst sets the same directory for the source CLI, so both reach one dev daemon.
const data = join(checkout, ".dev", "data");
const entry = join(checkout, "apps/gyst/src/index.ts");
// The source launcher resolves the packaged SPA beside its entry and refuses to start without an
// index.html. Vite serves the real viewer, so a placeholder satisfies it; `dist/` is ignored.
const webUiStub = join(checkout, "apps/gyst/src/dist/web-ui/index.html");

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops the previous run's daemon, which outlives Ctrl-C as it does in production and would keep
 * serving the old source. Only a `daemon run` of this checkout's entry is signalled, never a pid
 * a stale daemon.pid happens to name.
 */
async function stopStaleDaemon() {
  const pid = Number(await readFile(join(data, "daemon.pid"), "utf8").catch(() => ""));
  if (!pid || !isAlive(pid)) return;
  const args = execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  if (!args.includes(`${entry} daemon run`)) return;
  process.kill(pid, "SIGTERM");
  for (let waited = 0; isAlive(pid); waited += 50) {
    if (waited > 5_000) throw new Error(`the previous dev daemon (pid ${pid}) did not exit`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Starts the launcher; resolves its private URL once printed. Its stderr shows capture progress. */
function startLauncher(launch: DevLaunch): Promise<{ launcher: ChildProcess; url: URL }> {
  const launcher = spawn(process.execPath, [entry, ...launch.args], {
    cwd: launch.cwd,
    env: { ...process.env, GYST_DATA_DIR: data },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((done, reject) => {
    let out = "";
    launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n").find((text) => text.startsWith("http://"));
      if (line) done({ launcher, url: new URL(line) });
    });
    launcher.once("error", reject);
    launcher.once("exit", (code, signal) =>
      reject(new Error(`the gyst launcher exited ${code ?? signal} before printing its URL`)),
    );
  });
}

/** What the launcher opens: `gyst`'s own arguments (a range or `--session <id>`), run in `cwd`. */
export type DevLaunch = { readonly cwd: string; readonly args: ReadonlyArray<string> };

export function devLauncher(launch: DevLaunch): Plugin {
  let started: Awaited<ReturnType<typeof startLauncher>>;
  return {
    name: "gyst-dev-launcher",
    // Runs again on every server restart (`r`), relaunching from the current source.
    async config() {
      await mkdir(data, { recursive: true });
      await stopStaleDaemon();
      if (!existsSync(webUiStub)) {
        await mkdir(join(webUiStub, ".."), { recursive: true });
        await writeFile(webUiStub, "<!doctype html><p>Served by Vite in development.</p>\n");
      }
      started = await startLauncher(launch);
      // An object, not Vite's string shorthand, which would set changeOrigin and rewrite the Host.
      const bridge = { target: `http://127.0.0.1:${started.url.port}` };
      return { server: { proxy: { [webPaths.bootstrap]: bridge, [webPaths.operation]: bridge } } };
    },
    configureServer(server) {
      const { launcher, url } = started;
      const exited = (code: number | null, signal: NodeJS.Signals | null) =>
        server.config.logger.error(`gyst launcher exited ${code ?? signal}; press r to restart`);
      launcher.once("exit", exited);
      server.httpServer?.once("close", () => {
        launcher.off("exit", exited);
        launcher.kill("SIGINT");
      });
      // Vite's own localhost URLs are refused by the launcher's Host check, so print only the
      // launch URL, on Vite's port; a restart has a new launch and so a new URL.
      server.printUrls = () => {};
      server.httpServer?.once("listening", () => {
        const viewer = new URL(url);
        viewer.port = String((server.httpServer!.address() as AddressInfo).port);
        server.config.logger.info(`\n  gyst  ${viewer.href}\n`);
      });
    },
  };
}
