// The reader's live link to its session's committed state: which connection is current, whether
// gyst can be reached, and the newest version the daemon announced. No React or DOM here, so the
// fencing and recovery rules are unit tested on their own.
import type { SubscriptionEvent } from "@gyst/core/wire";
import { TransportError } from "./api.ts";

/** A version of the session's committed state, as a status read or an announcement names it. */
export type Version = { snapshotId: string; revision: number };

export type LivePhase = "connecting" | "live" | "recovering" | "deleted" | "refused";

export type LiveState = {
  /**
   * The connection that counts. Every connection and every loss starts a new one, so a late frame
   * or loss of a connection already given up changes nothing.
   */
  generation: number;
  phase: LivePhase;
  /** The daemon instance that answered the current connection's `ready`. */
  daemon?: string | undefined;
  /** The newest committed version announced; a status read catches the reader up to it. */
  known?: Version | undefined;
  /**
   * The version the current connection's `ready` named. Until the reader shows it, a reconnect is
   * not over: being reachable again is not yet being current.
   */
  ready?: Version | undefined;
  /** Connections lost in a row since the last `ready`, which sets the backoff. */
  attempts: number;
  failure?: unknown;
};

export type LiveEvent =
  | { type: "connect" }
  | { type: "frame"; generation: number; event: SubscriptionEvent }
  | { type: "lost"; generation: number; error?: unknown };

export const initialLive: LiveState = { generation: 0, phase: "connecting", attempts: 0 };

const isRefusal = (error: unknown) =>
  error instanceof TransportError &&
  (error.reason === "unauthorized" || error.reason === "forbidden");

/**
 * The next state after an event. `ready` resynchronizes: its version replaces what was known.
 * Deletion and a refused browser end the link for good; any other end or failure is recovered by
 * connecting again.
 */
export function liveReducer(state: LiveState, event: LiveEvent): LiveState {
  if (state.phase === "deleted" || state.phase === "refused") return state;
  if (event.type === "connect")
    return {
      ...state,
      generation: state.generation + 1,
      phase: state.phase === "recovering" ? "recovering" : "connecting",
    };
  if (event.generation !== state.generation) return state;
  if (event.type === "lost")
    return isRefusal(event.error)
      ? { ...state, phase: "refused", failure: event.error }
      : {
          ...state,
          generation: state.generation + 1,
          phase: "recovering",
          attempts: state.attempts + 1,
          failure: event.error,
        };
  const frame = event.event;
  switch (frame.kind) {
    case "ready": {
      const version = { snapshotId: frame.snapshotId, revision: frame.revision };
      return {
        generation: state.generation,
        phase: "live",
        daemon: frame.daemon,
        known: version,
        ready: version,
        attempts: 0,
      };
    }
    case "changed":
      if (state.known !== undefined && frame.revision < state.known.revision) return state;
      return { ...state, known: { snapshotId: frame.snapshotId, revision: frame.revision } };
    case "deleted":
      return { ...state, phase: "deleted" };
    case "failed":
      if (frame.error._tag === "no_session") return { ...state, phase: "deleted" };
      return liveReducer(state, { type: "lost", generation: state.generation, error: frame.error });
  }
}

/** How long to wait before connecting again after `attempts` losses in a row. */
export const retryDelay = (attempts: number) => Math.min(250 * 2 ** attempts, 5_000);

/**
 * Whether shown progress trails the committed state: current, behind so status is read again, or
 * of a snapshot a refresh replaced, which only a session reload can show.
 */
export function behind(live: LiveState, shown: Version): "current" | "read" | "replaced" {
  const { known } = live;
  if (known === undefined) return "current";
  if (known.snapshotId !== shown.snapshotId) return "replaced";
  return known.revision > shown.revision ? "read" : "current";
}

/**
 * Whether the reader is connected but not yet showing what its connection's `ready` named, so
 * Viewed changes stay paused until status is read. Only `ready` counts, not later announcements,
 * so ordinary changes elsewhere never pause the reader; a replaced snapshot is `behind`'s to say.
 */
export const synchronizing = (live: LiveState, shown: Version) =>
  live.phase === "live" &&
  live.ready !== undefined &&
  behind(live, shown) !== "replaced" &&
  shown.revision < live.ready.revision;
