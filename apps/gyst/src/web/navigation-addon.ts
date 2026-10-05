import { type AddonDiscovery, AddonHandshakeSchema, navigationAddon } from "@gyst/core";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { delimiter, isAbsolute, join } from "node:path";

const handshakeTimeout = "5 seconds";
const handshakeBytes = 64 * 1024;
const decodeHandshake = Schema.decodeUnknownOption(Schema.fromJsonString(AddonHandshakeSchema));
const found = `the ${navigationAddon.bin} found on PATH`;

/** Bounded in memory; a process that keeps writing is stopped by the handshake timeout. */
const collect = <E>(stdout: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    stdout,
    () => Buffer.alloc(0),
    (kept: Buffer, chunk: Uint8Array) =>
      kept.byteLength > handshakeBytes ? kept : Buffer.concat([kept, chunk]),
  );

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
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const unusable = (reason: string): AddonDiscovery => ({ kind: "unusable", reason });

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
  if (Option.isNone(entry)) return unusable(`${found} could not be resolved`);

  const answer = yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [entry.value, "--version"], {
        // Nothing from this shell (NODE_OPTIONS, PATH) reaches the handshake.
        env: {},
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "500 millis",
      }),
    );
    const [stdout, exitCode] = yield* Effect.all([collect(handle.stdout), handle.exitCode], {
      concurrency: "unbounded",
    });
    return { stdout, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(handshakeTimeout),
    Effect.map(Option.getOrUndefined),
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
  );
  if (answer === null) return unusable(`${found} could not be run`);
  if (answer === undefined) return unusable(`${found} did not answer within 5 seconds`);
  if (answer.stdout.byteLength > handshakeBytes)
    return unusable(`${found} printed more than 64 KiB`);
  if (answer.exitCode !== 0) return unusable(`${found} exited with code ${answer.exitCode}`);
  const handshake = decodeHandshake(answer.stdout.toString("utf8"));
  if (Option.isNone(handshake) || handshake.value.name !== navigationAddon.name)
    return unusable(`${found} is not ${navigationAddon.name}`);
  const { version, protocol, engine } = handshake.value;
  if (version !== runningVersion) return { kind: "mismatched", found: version } as const;
  if (protocol !== navigationAddon.protocol)
    return unusable(`${found} speaks protocol ${protocol}, not ${navigationAddon.protocol}`);
  if (!engine.ok) return unusable(engine.problem);
  return { kind: "available", entry: entry.value, version } satisfies AddonDiscovery;
});
