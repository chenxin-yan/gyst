import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import type { CaptureProgress, OpenPayload, Request } from "@gyst/core";
import { Clock, Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DaemonClient } from "../daemon/client.ts";
import { daemonVersion } from "../daemon/protocol.ts";
import { makeLaunch } from "./auth.ts";
import { makeNavigationAddon } from "./navigation-addon.ts";
import { browserApp, loadWebAssets } from "./server.ts";

/** A trusted-entry open: this process's cwd and scope, or an exact saved id. */
export type ViewerOpen = Extract<Request, { command: "open" }>;

/**
 * The platform opener when a local graphical browser is plausible; otherwise the operator gets the
 * private URL. Over SSH the browser belongs on the other end of a forward.
 */
export function browserOpener(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  interactive: boolean,
): string | undefined {
  if (!interactive || env.SSH_CONNECTION || env.SSH_TTY) return undefined;
  if (platform === "darwin") return "open";
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return "xdg-open";
  return undefined;
}

/** True only when the opener exits 0 promptly; it is unref'd, so a browser it started outlives us. */
const openBrowser = (opener: string, url: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(opener, [url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    );
    yield* handle.unref;
    return (yield* handle.exitCode) === 0;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption("5 seconds"),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * The foreground viewer: opens (creates or reuses) the session through the daemon, then serves this
 * launch's SPA and bridge on an ephemeral `127.0.0.1` port until interrupted. Interruption closes
 * only this HTTP server and its connections; the daemon and saved sessions are untouched.
 */
export const serveViewer = Effect.fn("serveViewer")(function* (
  open: ViewerOpen,
  options: {
    readonly webUiDir: string;
    readonly opener: string | undefined;
    readonly stdout: (text: string) => void;
    /**
     * The PATH this launch was started with: the only place it looks for the navigation add-on,
     * never the daemon's PATH or one changed later.
     */
    readonly launchPath: string | undefined;
    /** Shows a capture's progress while the open waits for it, then clears it. */
    readonly progress?:
      | {
          readonly report: (progress: CaptureProgress) => Effect.Effect<void>;
          readonly clear: Effect.Effect<void>;
        }
      | undefined;
  },
) {
  const assets = yield* loadWebAssets(options.webUiDir);
  const client = yield* DaemonClient;
  // The client decoded this reply with `OpenPayloadSchema`.
  const opened = (yield* client
    .request(open, options.progress?.report)
    .pipe(Effect.ensuring(options.progress?.clear ?? Effect.void))) as OpenPayload;
  const launch = makeLaunch(yield* Clock.currentTimeMillis);
  const addon = yield* makeNavigationAddon(options.launchPath, daemonVersion);

  const server = createServer();
  const http = yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port: 0 });
  yield* http.serve(browserApp(launch, assets, addon));
  // Runs before the server's own close, so open browser connections cannot hold shutdown.
  yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));

  const { port } = server.address() as AddressInfo;
  const sessionPath = `/session/${encodeURIComponent(opened.session.id)}`;
  const url = `http://${launch.hostname}:${port}${sessionPath}#${launch.bootstrap}`;
  const shown = options.opener !== undefined && (yield* openBrowser(options.opener, url));
  options.stdout(
    shown
      ? `Opened session ${opened.session.id} in your browser. Press Ctrl-C to stop the viewer.`
      : `Open this private URL in a browser. Over SSH, forward a local port to 127.0.0.1:${port} and use that port in the URL.\n${url}\nPress Ctrl-C to stop the viewer.`,
  );
  return yield* Effect.never;
}, Effect.scoped);
