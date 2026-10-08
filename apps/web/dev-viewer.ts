// `pnpm dev` and `apps/gyst/dev/gyst`: Vite serves the viewer with Fast Refresh in front of the dev
// daemon. The source `gyst` opens the session once and prints its link, which names the daemon's
// port; Vite proxies the API paths there with their Host and Origin unchanged, so the daemon checks
// them exactly as it does for a browser behind an SSH forward on another local port.
import { webPaths } from "@gyst/core/web";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Plugin } from "vite-plus";

const checkout = resolve(import.meta.dirname, "../..");
// apps/gyst/dev/gyst sets the same directory for the source CLI, so both reach one dev daemon.
const data = join(checkout, ".dev", "data");
const entry = join(checkout, "apps/gyst/src/index.ts");
// The source daemon serves the packaged SPA from beside its entry, which a dev checkout has not
// built; Vite serves the real viewer, so a placeholder says where it is. `dist/` is ignored.
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

/** Runs the source `gyst` once; resolves the link it prints. Its stderr shows capture progress. */
function openSession(launch: DevLaunch): Promise<URL> {
  const gyst = spawn(process.execPath, [entry, ...launch.args], {
    cwd: launch.cwd,
    env: { ...process.env, GYST_DATA_DIR: data },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((done, reject) => {
    let out = "";
    gyst.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    gyst.once("error", reject);
    gyst.once("close", (code, signal) => {
      const link = out.split("\n").find((line) => line.startsWith("http://"));
      if (code === 0 && link) done(new URL(link));
      else reject(new Error(`gyst exited ${code ?? signal} without printing a link`));
    });
  });
}

/** What the session opens: `gyst`'s own arguments (a range or `--session <id>`), run in `cwd`. */
export type DevLaunch = { readonly cwd: string; readonly args: ReadonlyArray<string> };

export function devViewer(launch: DevLaunch): Plugin {
  let link: URL;
  return {
    name: "gyst-dev-viewer",
    // Runs again on every server restart (`r`), restarting the daemon from the current source.
    async config() {
      await mkdir(data, { recursive: true });
      await stopStaleDaemon();
      await mkdir(join(webUiStub, ".."), { recursive: true });
      await writeFile(
        webUiStub,
        "<!doctype html><p>In development Vite serves the viewer: open the link apps/gyst/dev/gyst prints.</p>\n",
      );
      link = await openSession(launch);
      // An object, not Vite's string shorthand, which would set changeOrigin and rewrite the Host.
      // `ws` forwards the session subscription's WebSocket upgrade too.
      const daemon = { target: `http://127.0.0.1:${link.port}`, ws: true };
      const proxy = Object.fromEntries(Object.values(webPaths).map((path) => [path, daemon]));
      return { server: { proxy } };
    },
    configureServer(server) {
      // Print the session's link on Vite's port rather than Vite's own URLs.
      server.printUrls = () => {};
      server.httpServer?.once("listening", () => {
        const viewer = new URL(link);
        viewer.port = String((server.httpServer!.address() as AddressInfo).port);
        server.config.logger.info(`\n  gyst  ${viewer.href}\n`);
      });
    },
  };
}
