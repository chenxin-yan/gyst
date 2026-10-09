import { BadArgs, type DaemonError, DaemonUnreachable, NoSession } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { TransportError } from "./api.ts";
import {
  behind,
  initialLive,
  type LiveEvent,
  liveReducer,
  type LiveState,
  retryDelay,
  synchronizing,
} from "./live.ts";

const [a, b] = ["a".repeat(64), "b".repeat(64)];
const run = (...events: LiveEvent[]) => events.reduce(liveReducer, initialLive);
const ready = (generation: number, revision: number, daemon = "d1"): LiveEvent => ({
  type: "frame",
  generation,
  event: { kind: "ready", daemon, sessionId: "s1", snapshotId: a, revision, conversations: "v1" },
});
const changed = (
  generation: number,
  revision: number,
  snapshotId = a,
  conversations = "v1",
): LiveEvent => ({
  type: "frame",
  generation,
  event: { kind: "changed", sessionId: "s1", snapshotId, revision, conversations },
});
const failed = (generation: number, error: DaemonError): LiveEvent => ({
  type: "frame",
  generation,
  event: { kind: "failed", error },
});
const connect: LiveEvent = { type: "connect" };

describe("liveReducer", () => {
  it("goes live on ready, which names the daemon and the committed version", () => {
    const connecting = run(connect);
    expect(connecting).toMatchObject({ generation: 1, phase: "connecting", attempts: 0 });
    expect(liveReducer(connecting, ready(1, 4))).toEqual({
      generation: 1,
      phase: "live",
      daemon: "d1",
      known: { snapshotId: a, revision: 4, conversations: "v1" },
      ready: { snapshotId: a, revision: 4, conversations: "v1" },
      attempts: 0,
    });
  });

  it("keeps the newest announced version when changes arrive out of order", () => {
    const live = run(connect, ready(1, 4), changed(1, 6), changed(1, 5));
    expect(live.known).toEqual({ snapshotId: a, revision: 6, conversations: "v1" });
    // A refresh names its new snapshot.
    expect(liveReducer(live, changed(1, 7, b)).known).toEqual({
      snapshotId: b,
      revision: 7,
      conversations: "v1",
    });
  });

  it("carries the announced identity of the session's conversations, apart from the revision", () => {
    const live = run(connect, ready(1, 4), changed(1, 5, a, "v2"));
    expect(live.known).toEqual({ snapshotId: a, revision: 5, conversations: "v2" });
    // A Viewed change moves the revision alone, so conversations are not read again for it.
    expect(liveReducer(live, changed(1, 6, a, "v2")).known?.conversations).toBe("v2");
  });

  it("ignores frames and losses of a connection that is no longer current", () => {
    const lost = run(connect, ready(1, 4), { type: "lost", generation: 1 });
    const reconnecting = liveReducer(lost, connect);
    expect(reconnecting.generation).toBeGreaterThan(1);
    for (const late of [
      changed(1, 9),
      ready(1, 9),
      { type: "lost", generation: 1 } as const,
      { type: "frame", generation: 1, event: { kind: "deleted", sessionId: "s1" } } as const,
    ])
      expect(liveReducer(reconnecting, late)).toBe(reconnecting);
    // A connection's loss is counted once, though both the reader and the stream report it.
    const once = run(connect, ready(1, 4), { type: "lost", generation: 1 });
    expect(liveReducer(once, { type: "lost", generation: 1 })).toBe(once);
    expect(once.attempts).toBe(1);
  });

  it("recovers from a lost or failed connection, backing off, and resynchronizes from ready", () => {
    const down = new TransportError("unavailable", "down");
    const lost = run(connect, ready(1, 4), changed(1, 5), {
      type: "lost",
      generation: 1,
      error: down,
    });
    expect(lost).toMatchObject({ phase: "recovering", attempts: 1, failure: down });
    // Still recovering while it connects again, and each failure counts.
    const again = liveReducer(lost, connect);
    expect(again.phase).toBe("recovering");
    const unreachable = new DaemonUnreachable({ message: "restarting" });
    const failing = liveReducer(again, failed(again.generation, unreachable));
    expect(failing).toMatchObject({ phase: "recovering", attempts: 2, failure: unreachable });
    const bad = liveReducer(liveReducer(failing, connect), {
      type: "lost",
      generation: failing.generation + 1,
      error: new BadArgs({ message: "x" }),
    });
    expect(bad).toMatchObject({ phase: "recovering", attempts: 3 });
    // A new daemon's ready replaces what was known, even an older revision, and resets the backoff.
    const back = liveReducer(liveReducer(bad, connect), ready(bad.generation + 1, 3, "d2"));
    expect(back).toEqual({
      generation: bad.generation + 1,
      phase: "live",
      daemon: "d2",
      known: { snapshotId: a, revision: 3, conversations: "v1" },
      ready: { snapshotId: a, revision: 3, conversations: "v1" },
      attempts: 0,
    });
  });

  it("ends for good when the session is deleted or gyst refuses this browser", () => {
    const ended: LiveState[] = [
      run(connect, ready(1, 4), {
        type: "frame",
        generation: 1,
        event: { kind: "deleted", sessionId: "s1" },
      }),
      run(connect, failed(1, new NoSession({ message: "gone" }))),
      run(connect, { type: "lost", generation: 1, error: new TransportError("forbidden", "m") }),
    ];
    expect(ended.map(({ phase }) => phase)).toEqual(["deleted", "deleted", "refused"]);
    for (const state of ended) {
      expect(liveReducer(state, connect)).toBe(state);
      expect(liveReducer(state, ready(state.generation, 9))).toBe(state);
      expect(liveReducer(state, { type: "lost", generation: state.generation })).toBe(state);
    }
  });
});

it("backs off exponentially, capped at 5 seconds", () => {
  expect([0, 1, 2, 3, 4, 5, 10, 50].map(retryDelay)).toEqual([
    250, 500, 1000, 2000, 4000, 5000, 5000, 5000,
  ]);
});

describe("behind", () => {
  it("compares shown progress with the newest announced version", () => {
    const shown = { snapshotId: a, revision: 4 };
    expect(behind(initialLive, shown)).toBe("current");
    expect(behind(run(connect, ready(1, 4)), shown)).toBe("current");
    expect(behind(run(connect, ready(1, 3)), shown)).toBe("current");
    expect(behind(run(connect, ready(1, 4), changed(1, 5)), shown)).toBe("read");
    expect(behind(run(connect, ready(1, 4), changed(1, 5, b)), shown)).toBe("replaced");
  });

  it("reads again when a PR session's stack context changes at the same revision", () => {
    const at = (context: string, kind: "ready" | "changed" = "changed"): LiveEvent => ({
      type: "frame",
      generation: 1,
      event:
        kind === "ready"
          ? {
              kind,
              daemon: "d1",
              sessionId: "s1",
              snapshotId: a,
              revision: 4,
              conversations: "v1",
              context,
            }
          : { kind, sessionId: "s1", snapshotId: a, revision: 4, conversations: "v1", context },
    });
    const live = run(connect, at("c1", "ready"));
    expect(live.known).toEqual({ snapshotId: a, revision: 4, context: "c1", conversations: "v1" });
    // Status not yet read at any context, then read at the announced one.
    expect(behind(live, { snapshotId: a, revision: 4 })).toBe("read");
    expect(behind(live, { snapshotId: a, revision: 4, context: "c1" })).toBe("current");
    const rechecked = liveReducer(live, at("c2"));
    expect(rechecked.known).toEqual({
      snapshotId: a,
      revision: 4,
      context: "c2",
      conversations: "v1",
    });
    expect(behind(rechecked, { snapshotId: a, revision: 4, context: "c1" })).toBe("read");
    expect(behind(rechecked, { snapshotId: a, revision: 5, context: "c1" })).toBe("read");
    // Its context never pauses Viewed changes: only the revision a ready names does.
    expect(synchronizing(rechecked, { snapshotId: a, revision: 4, context: "c1" })).toBe(false);
  });
});

describe("synchronizing", () => {
  it("holds from a ready the reader trails until it shows that version, never for later changes", () => {
    const shown = { snapshotId: a, revision: 4 };
    // Not yet connected: the reader isn't live, which the phase says.
    expect(synchronizing(run(connect), shown)).toBe(false);
    expect(synchronizing(run(connect, ready(1, 4)), shown)).toBe(false);
    expect(synchronizing(run(connect, ready(1, 3)), shown)).toBe(false);
    // Changes after ready are ordinary invalidations, read without pausing the reader.
    expect(synchronizing(run(connect, ready(1, 4), changed(1, 6)), shown)).toBe(false);
    const reconnected = run(connect, ready(1, 4), { type: "lost", generation: 1 }, connect);
    expect(synchronizing(reconnected, shown)).toBe(false);
    const behindReady = liveReducer(reconnected, ready(reconnected.generation, 6, "d2"));
    expect(synchronizing(behindReady, shown)).toBe(true);
    expect(synchronizing(behindReady, { snapshotId: a, revision: 6 })).toBe(false);
    // A refresh that replaced the shown snapshot asks for a reload instead.
    expect(
      synchronizing(liveReducer(behindReady, changed(behindReady.generation, 7, b)), shown),
    ).toBe(false);
  });
});
