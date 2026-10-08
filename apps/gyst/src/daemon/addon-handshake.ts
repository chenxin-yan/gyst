import { type AddonDiscovery, AddonHandshakeSchema, navigationAddon } from "@gyst/core";
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname } from "node:path";

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
 * Runs the add-on script at `entry` (a real path) with gyst's own Node and judges its `--version`
 * handshake against this gyst. The launcher runs it on what it finds on its PATH; the daemon runs
 * it again when an engine from a discovered `entry` fails to start, to tell a replaced or broken
 * install from an engine failure.
 */
export const handshakeAddon = Effect.fn("handshakeAddon")(function* (
  entry: string,
  runningVersion: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const unusable = (reason: string): AddonDiscovery => ({ kind: "unusable", reason });
  const answer = yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [entry, "--version"], {
        // Nothing from this shell (NODE_OPTIONS, PATH) reaches the handshake. The add-on's own
        // directory exists whenever `entry` does, unlike gyst's cwd, which may be a deleted
        // checkout; the native engine refuses to start without a working directory.
        cwd: dirname(entry),
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
  return { kind: "available", entry, version } satisfies AddonDiscovery;
});
