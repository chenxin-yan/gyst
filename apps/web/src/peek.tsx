// A followed reference, read inline where it was followed: a highlighted preview of its captured
// lines beside its location, with compact Expand and Close. Never a modal. Under a note it spans
// the whole diff, both split columns; in an overview it reads in flow.
//
// TODO(#106): replace with @pierre/diffs' native full-width line slot. 1.4.3 has none (annotations
// are side-specific), so the owner-approved workaround on public APIs lives here and only here: a
// side annotation renders an empty `PeekSpacer`, which the renderer reserves as a row across both
// split columns, and `InlinePeek` places an app-owned full-width element over it in the panel's
// scroll coordinates, syncing the spacer's height to its own. Nothing reads or styles the
// renderer's shadow roots.
import type { CapturedRange } from "@gyst/core/wire";
import { getFiletypeFromFileName, getSharedHighlighter, type ThemedToken } from "@pierre/diffs";
import * as stylex from "@stylexjs/stylex";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Availability, RangeRead } from "./captured.ts";
import type { Peek } from "./navigation.ts";
import { referenceLabel } from "./rich.ts";
import { codeTheme } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";

/** The row a peek under a note reserves in the diff, as tall as the peek placed over it. */
export function PeekSpacer(props: { ref: Ref<HTMLDivElement> }) {
  return <div ref={props.ref} data-annotation data-peek-spacer aria-hidden />;
}

/** What the reader asks an overlay peek to do: place itself again after the diff moved. */
export type PeekHandle = { place(): void };

/** A box's horizontal extent in the panel's scroll coordinates. */
export type Extent = { left: number; width: number };

/**
 * An open reference peek. With a `spacer` it is the full-width overlay over that spacer, spanning
 * `extent` (the rendered diff item); without one it reads in flow. Expand is offered only for an
 * available target; Esc closes it through the reader's keys.
 */
export function InlinePeek(props: {
  peek: Peek;
  availability: Availability;
  read: () => Promise<RangeRead>;
  /** Stack the preview and its location instead of setting them side by side. */
  narrow: boolean;
  /** The current snapshot, to name the target's own. */
  snapshotId: string;
  onExpand: () => void;
  onClose: () => void;
  /** The overlay's spacer and the diff item's extent; absent in flow. */
  overlay?: { spacer: HTMLDivElement | null; extent: () => Extent | undefined };
  handle?: Ref<PeekHandle>;
}) {
  const { peek, overlay } = props;
  const inFlow = overlay === undefined;
  const box = useRef<HTMLElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const latest = useRef(overlay);
  latest.current = overlay;

  // Focus Expand (or Close) once the peek is where the reader sees it, so Enter expands and Back
  // returns here.
  const focus = useCallback(() => {
    if (focused.current) return;
    focused.current = true;
    const control = expand.current ?? box.current?.querySelector("button");
    control?.focus({ preventScroll: true });
  }, []);

  const place = useCallback(() => {
    const element = box.current;
    const at = latest.current;
    if (element === null || at === undefined) return;
    const parent = element.offsetParent;
    const extent = at.extent();
    const spacer = at.spacer;
    if (!(parent instanceof HTMLElement) || spacer === null || !spacer.isConnected || !extent) {
      // Its row is virtualized away, or not rendered yet.
      element.style.visibility = "hidden";
      return;
    }
    const top =
      spacer.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
    element.style.top = `${top}px`;
    element.style.left = `${extent.left}px`;
    element.style.width = `${extent.width}px`;
    element.style.visibility = "visible";
    focus();
  }, [focus]);
  useImperativeHandle(props.handle, () => ({ place }), [place]);

  // The spacer reserves exactly the overlay's height, which the renderer then lays out.
  const spacer = overlay?.spacer ?? null;
  useEffect(() => {
    const element = box.current;
    if (element === null || inFlow) return;
    const sync = () => {
      if (spacer) spacer.style.height = `${element.offsetHeight}px`;
      place();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [spacer, inFlow, place]);
  useEffect(() => {
    if (inFlow) focus();
  }, [inFlow, focus]);

  const { target } = peek;
  const label = referenceLabel(target);
  const snapshot = target.snapshotId.slice(0, 7);
  return (
    <section
      ref={box}
      aria-label={`Reference ${label}`}
      data-peek
      {...stylex.props(styles.peek, overlay ? styles.overlay : styles.flow)}
    >
      <div {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.title)}>{label}</span>
        {props.availability.available && (
          <button
            ref={expand}
            type="button"
            onClick={props.onExpand}
            {...stylex.props(styles.control)}
          >
            Expand
          </button>
        )}
        <button
          type="button"
          aria-label="Close reference"
          onClick={props.onClose}
          {...stylex.props(styles.control)}
        >
          Close
        </button>
      </div>
      <div {...stylex.props(styles.body, props.narrow && styles.stacked)}>
        <div {...stylex.props(styles.preview)}>
          {props.availability.available ? (
            <PeekPreview target={target} read={props.read} />
          ) : (
            <p role="status" {...stylex.props(styles.unavailable)}>
              Unavailable: {props.availability.reason}.
            </p>
          )}
        </div>
        <ul aria-label="Reference location" {...stylex.props(styles.locations)}>
          <li aria-current="true" {...stylex.props(styles.location)}>
            <span {...stylex.props(styles.path)}>{target.path}</span>
            <span {...stylex.props(styles.meta)}>
              {`L${target.startLine}${target.endLine > target.startLine ? `–${target.endLine}` : ""}`}{" "}
              · {target.side} side · snapshot {snapshot}
              {target.snapshotId !== props.snapshotId && " (earlier)"}
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}

type Preview =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | (RangeRead & { tokens?: ThemedToken[][] });

/**
 * The target's captured lines with a few around them, numbered as in the file, the target's
 * highlighted, and colored by the diff renderer's shared Shiki highlighter once it is ready.
 */
export function PeekPreview(props: { target: CapturedRange; read: () => Promise<RangeRead> }) {
  const { target, read } = props;
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setPreview({ kind: "loading" });
    void (async () => {
      let lines: RangeRead;
      try {
        lines = await read();
      } catch (error) {
        if (current)
          setPreview({ kind: "failed", message: error instanceof Error ? error.message : "" });
        return;
      }
      if (!current) return;
      setPreview(lines);
      if (lines.kind !== "text") return;
      const lang = getFiletypeFromFileName(target.path);
      if (lang === "text") return;
      try {
        const highlighter = await getSharedHighlighter({ themes: [codeTheme], langs: [lang] });
        const { tokens } = highlighter.codeToTokens(lines.lines.join("\n"), {
          lang,
          theme: codeTheme,
        });
        if (current) setPreview({ ...lines, tokens });
      } catch {
        // The plain lines stay.
      }
    })();
    return () => {
      current = false;
    };
  }, [read, target.path]);

  if (preview.kind === "loading")
    return (
      <p role="status" {...stylex.props(styles.unavailable)}>
        Reading the captured lines…
      </p>
    );
  if (preview.kind === "failed")
    return (
      <p role="alert" {...stylex.props(styles.failure)}>
        Couldn't read the captured lines{preview.message ? `: ${preview.message}` : ""}.
      </p>
    );
  if (preview.kind === "unavailable")
    return (
      <p role="status" {...stylex.props(styles.unavailable)}>
        Unavailable: {preview.reason}.
      </p>
    );
  return (
    <pre data-peek-preview {...stylex.props(styles.code)}>
      {preview.lines.map((text, index) => {
        const line = preview.startLine + index;
        const inside = line >= target.startLine && line <= target.endLine;
        return (
          <div
            key={line}
            data-target={inside || undefined}
            {...stylex.props(styles.row, inside && styles.target)}
          >
            <span {...stylex.props(styles.number)}>{line}</span>
            <code {...stylex.props(styles.text)}>
              {preview.tokens?.[index]?.map((token, at) => (
                <span key={at} style={{ color: token.color }}>
                  {token.content}
                </span>
              )) ?? text}
            </code>
          </div>
        );
      })}
    </pre>
  );
}

const styles = stylex.create({
  peek: {
    display: "grid",
    gap: "6px",
    padding: "8px 10px 10px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `0 0 0 1px ${theme["--accent"]}`,
    fontFamily: theme.sans,
    fontSize: "12.5px",
    color: theme.ink,
    whiteSpace: "normal",
  },
  // Placed by `place`; hidden until its spacer is rendered. Above the diff and its cursor overlay.
  overlay: { position: "absolute", zIndex: 2, visibility: "hidden", boxSizing: "border-box" },
  flow: { marginTop: "10px" },
  bar: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
  title: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: theme["--mono"],
    fontSize: "12px",
    color: theme.muted,
  },
  control: {
    flexShrink: 0,
    paddingBlock: "1px",
    paddingInline: "8px",
    borderRadius: "4px",
    color: { default: theme.muted, ":hover": theme.ink, ":focus-visible": theme.ink },
    backgroundColor: { default: theme.line, ":hover": theme.select },
    fontSize: "12px",
  },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(160px, 240px)",
    gap: "10px",
    alignItems: "start",
  },
  stacked: { gridTemplateColumns: "minmax(0, 1fr)" },
  preview: { minWidth: 0 },
  code: {
    margin: 0,
    paddingBlock: "6px",
    overflowX: "auto",
    borderRadius: "4px",
    backgroundColor: theme.panelBg,
    fontFamily: theme["--mono"],
    fontSize: "12px",
    lineHeight: "18px",
  },
  row: { display: "flex", minWidth: "max-content", paddingInlineEnd: "10px" },
  target: {
    backgroundColor: `color-mix(in srgb, ${theme["--accent"]} 12%, transparent)`,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
  number: {
    flexShrink: 0,
    width: "5ch",
    paddingInlineEnd: "1ch",
    textAlign: "right",
    color: theme.faint,
    userSelect: "none",
  },
  text: { whiteSpace: "pre", fontFamily: "inherit" },
  locations: { display: "grid", gap: "2px", minWidth: 0 },
  location: {
    display: "grid",
    gap: "2px",
    padding: "6px 8px",
    borderRadius: "4px",
    backgroundColor: theme.select,
  },
  path: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: theme["--mono"],
    fontSize: "12px",
  },
  meta: { color: theme.muted, fontSize: "11.5px" },
  unavailable: { color: theme.muted },
  failure: { color: theme.del },
});
