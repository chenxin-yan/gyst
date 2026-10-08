import { type AddonDiscovery, navigationAddon } from "@gyst/core";
import { Effect, FileSystem, Option, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { delimiter, isAbsolute, join } from "node:path";
import { handshakeAddon } from "../daemon/addon-handshake.ts";

/**
 * Finds the navigation add-on on a launcher's own PATH, as a shell would, and validates it by its
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

/** One launcher's add-on, discovered on the PATH it was launched with. */
export interface NavigationAddon {
  /** The latest discovery, made on first use: a launch that never navigates never looks. */
  readonly current: Effect.Effect<AddonDiscovery>;
  /**
   * Discovers again on the same launch PATH (Check again), so an install into one of its existing
   * directories is seen without restarting; later navigation uses the result. A changed PATH or
   * npm prefix needs a new launch.
   */
  readonly recheck: Effect.Effect<AddonDiscovery>;
}

export const makeNavigationAddon = Effect.fnUntraced(function* (
  launchPath: string | undefined,
  runningVersion: string,
) {
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Discoveries run one at a time, so a slower earlier one never overwrites a recheck.
  const serialized = Semaphore.withPermit(yield* Semaphore.make(1));
  let latest: AddonDiscovery | undefined;
  const discover = discoverAddon(launchPath, runningVersion).pipe(
    Effect.provideContext(context),
    Effect.tap((found) =>
      Effect.sync(() => {
        latest = found;
      }),
    ),
  );
  return {
    current: serialized(Effect.suspend(() => (latest ? Effect.succeed(latest) : discover))),
    recheck: serialized(discover),
  } satisfies NavigationAddon;
});
