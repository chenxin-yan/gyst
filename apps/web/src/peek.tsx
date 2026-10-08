// A peek read inline where it was opened: a followed reference, or a semantic query's symbols and
// results, with a highlighted preview of captured lines beside a vertical selector and compact
// Expand and Close. Never a modal. Under a code line or a note it spans the whole diff, both split
// columns; in an overview it reads in flow.
//
// TODO(#106): replace with @pierre/diffs' native full-width line slot. 1.4.3 has none (annotations
// are side-specific), so the owner-approved workaround on public APIs lives here and only here: a
// side annotation renders an empty `PeekSpacer`, which the renderer reserves as a row across both
// split columns, and `InlinePeek` places an app-owned full-width element over it in the panel's
// scroll coordinates, syncing the spacer's height to its own. Nothing reads or styles the
// renderer's shadow roots.
import type { CapturedRange, TextRange } from "@gyst/core/wire";
import { getFiletypeFromFileName, getSharedHighlighter, type ThemedToken } from "@pierre/diffs";
import * as stylex from "@stylexjs/stylex";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Availability, RangeRead } from "./captured.ts";
import type { ReferencePeek as ReferencePeekState } from "./navigation.ts";
import { referenceLabel } from "./rich.ts";
import { codeTheme } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";

/** The row a peek under a note or code line reserves in the diff, as tall as the peek over it. */
export function PeekSpacer(props: { ref: Ref<HTMLDivElement> }) {
  return <div ref={props.ref} data-annotation data-peek-spacer aria-hidden />;
}

/** What the reader asks an overlay peek to do: place itself again after the diff moved. */
export type PeekHandle = { place(): void };

/** A box's horizontal extent in the panel's scroll coordinates. */
export type Extent = { left: number; width: number };

/** The overlay's spacer and the diff item's extent. */
export type PeekOverlay = { spacer: HTMLDivElement | null; extent: () => Extent | undefined };

/**
 * An open peek. With an `overlay` it is the full-width element over that spacer, spanning the
 * rendered diff item; without one it reads in flow. Once placed it focuses its selector
 * (`data-peek-focus`), else Expand, else Close: always, unless the reader is typing or in a dialog
 * (`free`, for an answer that arrives later), or never.
 */
export function InlinePeek(props: {
  label: string;
  title: ReactNode;
  /** Absent when there is nothing to expand. */
  onExpand?: (() => void) | undefined;
  onClose: () => void;
  closeLabel: string;
  preview: ReactNode;
  /** The vertical list beside the preview; absent, the preview takes the whole width. */
  selector?: ReactNode;
  /** Under both, across the peek. */
  footer?: ReactNode;
  /** Stack the preview and its selector instead of setting them side by side. */
  narrow: boolean;
  focus?: "always" | "free" | "never";
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  overlay?: PeekOverlay | undefined;
  handle?: Ref<PeekHandle> | undefined;
}) {
  const { overlay, focus: focusing = "always" } = props;
  const inFlow = overlay === undefined;
  const box = useRef<HTMLElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const latest = useRef(overlay);
  latest.current = overlay;

  // Focus moves in once the peek is where the reader sees it, so Enter acts in it and Back
  // returns here.
  const focus = useCallback(() => {
    const element = box.current;
    if (focused.current || focusing === "never" || element === null) return;
    focused.current = true;
    const active = document.activeElement;
    if (
      focusing === "free" &&
      active !== null &&
      !element.contains(active) &&
      (active.closest("dialog") !== null ||
        active.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
    )
      return;
    const control =
      element.querySelector<HTMLElement>("[data-peek-focus]") ??
      expand.current ??
      element.querySelector("button");
    control?.focus({ preventScroll: true });
  }, [focusing]);

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

  return (
    <section
      ref={box}
      aria-label={props.label}
      data-peek
      onKeyDown={props.onKeyDown}
      {...stylex.props(styles.peek, overlay ? styles.overlay : styles.flow)}
    >
      <div {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.title)}>{props.title}</span>
        {props.onExpand && (
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
          aria-label={props.closeLabel}
          onClick={props.onClose}
          {...stylex.props(styles.control)}
        >
          Close
        </button>
      </div>
      <div
        {...stylex.props(
          styles.body,
          (props.narrow || props.selector === undefined) && styles.stacked,
        )}
      >
        <div {...stylex.props(styles.preview)}>{props.preview}</div>
        {props.selector}
      </div>
      {props.footer}
    </section>
  );
}

/** A followed reference's peek: its target's lines beside its one location. */
export function ReferencePeek(props: {
  peek: ReferencePeekState;
  availability: Availability;
  read: () => Promise<RangeRead>;
  narrow: boolean;
  /** The current snapshot, to name the target's own. */
  snapshotId: string;
  onExpand: () => void;
  onClose: () => void;
  overlay?: PeekOverlay;
  handle?: Ref<PeekHandle>;
}) {
  const { target } = props.peek;
  const label = referenceLabel(target);
  const snapshot = target.snapshotId.slice(0, 7);
  return (
    <InlinePeek
      label={`Reference ${label}`}
      title={label}
      onExpand={props.availability.available ? props.onExpand : undefined}
      onClose={props.onClose}
      closeLabel="Close reference"
      narrow={props.narrow}
      overlay={props.overlay}
      handle={props.handle}
      preview={
        props.availability.available ? (
          <PeekPreview target={target} read={props.read} />
        ) : (
          <p role="status" {...stylex.props(styles.unavailable)}>
            Unavailable: {props.availability.reason}.
          </p>
        )
      }
      selector={
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
      }
    />
  );
}

type Preview =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | (RangeRead & { tokens?: ThemedToken[][] });

/** The characters of `line` that `span` covers, in UTF-16 units, or undefined for none. */
function spanOn(span: TextRange | undefined, line: number, length: number) {
  if (span === undefined || line < span.start.line || line > span.end.line) return undefined;
  const from = line === span.start.line ? span.start.character : 0;
  const to = line === span.end.line ? span.end.character : length;
  return to > from ? { from, to } : undefined;
}

type Piece = { content: string; color?: string | undefined };

/** A line's pieces split where the marked characters start and end, each saying if it is inside. */
function marked(pieces: readonly Piece[], mark: { from: number; to: number } | undefined) {
  if (mark === undefined) return pieces.map((piece) => ({ ...piece, inside: false }));
  const out: (Piece & { inside: boolean })[] = [];
  let at = 0;
  for (const piece of pieces) {
    const end = at + piece.content.length;
    const cuts = [
      at,
      Math.min(Math.max(mark.from, at), end),
      Math.min(Math.max(mark.to, at), end),
      end,
    ];
    for (let index = 0; index < 3; index++) {
      const [from, to] = [cuts[index]!, cuts[index + 1]!];
      if (to > from)
        out.push({
          content: piece.content.slice(from - at, to - at),
          color: piece.color,
          inside: index === 1,
        });
    }
    at = end;
  }
  return out;
}

/**
 * The target's captured lines with a few around them, numbered as in the file, the target's
 * highlighted, and colored by the diff renderer's shared Shiki highlighter once it is ready. A
 * `span` marks the exact characters of a symbol. While another target's lines are read, the last
 * ones stay, so stepping through results doesn't make the peek jump.
 */
export function PeekPreview(props: {
  target: CapturedRange;
  read: () => Promise<RangeRead>;
  span?: TextRange | undefined;
}) {
  const { target, read, span } = props;
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setPreview((before) => (before.kind === "text" ? before : { kind: "loading" }));
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
        const pieces = marked(
          preview.tokens?.[index] ?? [{ content: text }],
          spanOn(span, line, text.length),
        );
        return (
          <div
            key={line}
            data-target={inside || undefined}
            {...stylex.props(styles.row, inside && styles.target)}
          >
            <span {...stylex.props(styles.number)}>{line}</span>
            <code {...stylex.props(styles.text)}>
              {pieces.map((piece, at) => (
                <span
                  key={at}
                  data-symbol={piece.inside || undefined}
                  style={piece.color === undefined ? undefined : { color: piece.color }}
                  {...stylex.props(piece.inside && styles.symbol)}
                >
                  {piece.content}
                </span>
              ))}
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
  symbol: {
    borderRadius: "2px",
    backgroundColor: `color-mix(in srgb, ${theme["--accent"]} 28%, transparent)`,
    outline: `1px solid color-mix(in srgb, ${theme["--accent"]} 70%, transparent)`,
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
