import { type AddonDiscovery, navigationAddon } from "@gyst/core";
import { Effect, FileSystem, Option, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { delimiter, isAbsolute, join } from "node:path";
import { handshakeAddon } from "./addon-handshake.ts";

/**
 * Finds the navigation add-on on a CLI invocation's PATH, as a shell would, and validates it by its
 * `--version` handshake. Only an absolute PATH entry counts: a relative one would resolve against
 * whichever directory gyst runs in. Only an available add-on's result names a host path: its real
 * `entry`, which the daemon later runs with gyst's own Node and no shell.
 */
export const discoverAddon = Effect.fn("discoverAddon")(function* (
  launchPath: string | undefined,
  runningVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const candidates = (launchPath ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && isAbsolute(dir))
    .map((dir) => join(dir, navigationAddon.bin));
  const executable = yield* Effect.findFirst(candidates, (file) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    ),
  );
  if (Option.isNone(executable)) return { kind: "missing" } satisfies AddonDiscovery;
  const entry = yield* fs.realPath(executable.value).pipe(Effect.option);
  if (Option.isNone(entry))
    return {
      kind: "unusable",
      reason: `the ${navigationAddon.bin} found on PATH could not be resolved`,
    } satisfies AddonDiscovery;
  return yield* handshakeAddon(entry.value, runningVersion);
});

/**
 * Each session's add-on, discovered on the PATH of the latest CLI invocation that opened it, never
 * the daemon's own PATH (which may be stale) or anything a browser sends. Kept in memory: after a
 * daemon restart a session finds no add-on until a CLI opens it again.
 */
export interface NavigationAddons {
  /**
   * Records the PATH a CLI invocation opened the session with. A new invocation replaces the
   * last one and its discovery, so a changed Node, npm prefix or PATH takes effect.
   */
  record(sessionId: string, launchPath: string): Effect.Effect<void>;
  /** Gives a layer opened from its PR session's viewer that session's PATH, unless it has its own. */
  inherit(fromSessionId: string, toSessionId: string): Effect.Effect<void>;
  forget(sessionId: string): Effect.Effect<void>;
  /** The latest discovery, made on first use: a session that never navigates never looks. */
  current(sessionId: string): Effect.Effect<AddonDiscovery>;
  /**
   * Discovers again on the same PATH (Check again), so an install into one of its existing
   * directories is seen without restarting; later navigation uses the result.
   */
  recheck(sessionId: string): Effect.Effect<AddonDiscovery>;
}

type Launch = { readonly path: string; latest?: AddonDiscovery };

export const makeNavigationAddons = Effect.fnUntraced(function* (runningVersion: string) {
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Discoveries run one at a time, so a slower earlier one never overwrites a recheck.
  const serialized = Semaphore.withPermit(yield* Semaphore.make(1));
  const launches = new Map<string, Launch>();
  const discover = (sessionId: string) =>
    Effect.suspend(() => {
      const launch = launches.get(sessionId);
      if (launch === undefined) return Effect.succeed<AddonDiscovery>({ kind: "missing" });
      return discoverAddon(launch.path, runningVersion).pipe(
        Effect.provideContext(context),
        // A PATH recorded meanwhile has replaced `launch`, and with it this result.
        Effect.tap((found) => Effect.sync(() => void (launch.latest = found))),
      );
    });
  return {
    record: (sessionId, launchPath) =>
      Effect.sync(() => void launches.set(sessionId, { path: launchPath })),
    inherit: (fromSessionId, toSessionId) =>
      Effect.sync(() => {
        const from = launches.get(fromSessionId);
        if (from !== undefined && !launches.has(toSessionId))
          launches.set(toSessionId, { path: from.path });
      }),
    forget: (sessionId) => Effect.sync(() => void launches.delete(sessionId)),
    current: (sessionId) =>
      serialized(
        Effect.suspend(() => {
          const latest = launches.get(sessionId)?.latest;
          return latest ? Effect.succeed(latest) : discover(sessionId);
        }),
      ),
    recheck: (sessionId) => serialized(discover(sessionId)),
  } satisfies NavigationAddons;
});
