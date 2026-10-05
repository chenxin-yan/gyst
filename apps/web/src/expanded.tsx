// A reference's captured file expanded in the main panel: its identity above the code, and the
// whole captured side of a file without changes, read once and kept for the session (#108). A file
// with changes reads as its full diff, every hunk a real change; Viewed never changes here.
import type { CapturedRange } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useRef, useState } from "react";
import { type CodeRead, readWholeSide } from "./captured.ts";
import { useMounted } from "./components.tsx";
import { rangeLabel } from "./rich.ts";
import { theme } from "./tokens.stylex.ts";

/** A whole captured side being read, its text, or why the read failed. */
export type WholeSide = "loading" | { text: string } | { failure: unknown };

const sideKey = (target: CapturedRange) => `${target.side}\0${target.path}`;

/**
 * The whole captured sides read for expanded files without changes, by side and path. A side is
 * read once; a failed read is read again on the next `load`.
 */
export function useWholeSides(read: CodeRead) {
  const [sides, setSides] = useState<ReadonlyMap<string, WholeSide>>(new Map());
  const latest = useRef(sides);
  latest.current = sides;
  const mounted = useMounted();
  const set = useCallback(
    (key: string, side: WholeSide) => {
      if (mounted.current) setSides((before) => new Map(before).set(key, side));
    },
    [mounted],
  );
  const load = useCallback(
    (target: CapturedRange) => {
      const key = sideKey(target);
      const known = latest.current.get(key);
      if (known === "loading" || (typeof known === "object" && "text" in known)) return;
      set(key, "loading");
      readWholeSide(target, read).then(
        (text) => set(key, { text }),
        (failure: unknown) => set(key, { failure }),
      );
    },
    [read, set],
  );
  const of = useCallback((target: CapturedRange) => sides.get(sideKey(target)), [sides]);
  return { of, load };
}

/**
 * Names what the main panel shows when a reference is expanded: captured code at an exact
 * snapshot, path and side, not a current change, and how to go back.
 */
export function CapturedHeader(props: {
  target: CapturedRange;
  /** Whether the target's snapshot is the session's current one. */
  current: boolean;
  /** Reading a whole side, or why it failed. */
  load: WholeSide | undefined;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { target, load } = props;
  return (
    <section aria-label="Captured file" {...stylex.props(styles.box)}>
      <p {...stylex.props(styles.identity)}>
        <span {...stylex.props(styles.kind)}>Captured</span> · <code>{target.path}</code> ·{" "}
        {target.side} side · snapshot <code>{target.snapshotId.slice(0, 7)}</code>
        {!props.current && " (earlier snapshot)"}
      </p>
      <p {...stylex.props(styles.note)}>
        Highlighted: {rangeLabel(target)}. Viewed doesn't change here.
      </p>
      {load === "loading" && (
        <p role="status" {...stylex.props(styles.note)}>
          Reading the captured file…
        </p>
      )}
      {typeof load === "object" && "failure" in load && (
        <p role="alert" {...stylex.props(styles.failure)}>
          Couldn't read the captured file
          {load.failure instanceof Error ? `: ${load.failure.message}` : ""}.{" "}
          <button type="button" onClick={props.onRetry} {...stylex.props(styles.button)}>
            Retry
          </button>
        </p>
      )}
      <button type="button" onClick={props.onBack} {...stylex.props(styles.button)}>
        Back <kbd>⌫</kbd>
      </button>
    </section>
  );
}

const styles = stylex.create({
  box: {
    display: "grid",
    justifyItems: "start",
    gap: "4px",
    marginTop: "24px",
    padding: "10px 14px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `0 0 0 1px ${theme.line}`,
    fontFamily: theme.sans,
    fontSize: "13px",
    color: theme.ink,
  },
  identity: { overflowWrap: "anywhere" },
  kind: { fontWeight: 600 },
  note: { fontSize: "12px", color: theme.muted },
  failure: { fontSize: "12px", color: theme.del },
  button: {
    paddingBlock: "1px",
    paddingInline: "8px",
    borderRadius: "4px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: theme.line, ":hover": theme.select },
    fontSize: "12px",
  },
});
