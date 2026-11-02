import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The platform opener when a local graphical browser is plausible; otherwise the operator gets the
 * link. Over SSH the browser belongs on the other end of a forward.
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
export const openBrowser = (opener: string, url: string) =>
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
