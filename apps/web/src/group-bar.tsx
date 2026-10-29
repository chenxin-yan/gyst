// The bar between the header and the reader: what the view is, how big it is and how far it is read,
// and in a group its place among the groups, its overview as a capped disclosure and Group viewed.
// It never moves on its own: its buttons go through the reader's own view changes.
import type { StatusPayload } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Keys } from "./commands.tsx";
import { type CommandId, commands } from "./keymap.ts";
import type { ReaderFile } from "./reader.ts";
import { standalone } from "./standalone.ts";
import { theme } from "./tokens.stylex.ts";
import { groupProgress, type ReviewView, type StatusGroup } from "./walkthrough.ts";
import type { checkboxOf } from "./viewed.ts";

const command = (id: CommandId) => commands.find((each) => each.id === id)!;
const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The group overview's disclosure: open on a group's first visit, then as the reader left it for
 * the page's life, and the capped region it scrolls in.
 */
export function useGroupOverview(group: StatusGroup | undefined) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const region = useRef<HTMLDivElement | null>(null);
  // Set by the key that opens it, so the keyboard scrolls it from then on.
  const focus = useRef(false);
  // The offset Back gives the region it shows again.
  const top = useRef<number>(undefined);
  const open = group !== undefined && !closed.has(group.id);
  /** Scrolls the region on to what it hides below, a region less a line at a time. */
  const showMore = () => {
    const node = region.current;
    const hidden = node ? node.scrollHeight - node.clientHeight - node.scrollTop : 0;
    if (node === null || hidden <= 1) return false;
    node.scrollBy({ top: Math.min(hidden, node.clientHeight - 24), behavior: "smooth" });
    return true;
  };
  return {
    open,
    region,
    focus,
    top,
    showMore,
    /** Opens or closes it; the key (`byKey`) first shows more of an open one while it hides any. */
    toggle(byKey = false) {
      if (group === undefined) return;
      if (byKey && open && showMore()) return;
      focus.current = byKey && !open;
      setClosed((before) => {
        const after = new Set(before);
        if (!after.delete(group.id)) after.add(group.id);
        return after;
      });
    },
  };
}

export type GroupOverview = ReturnType<typeof useGroupOverview>;

export function GroupBar(props: {
  status: StatusPayload;
  review: ReviewView;
  /** The shown group; undefined in a files view. */
  group: StatusGroup | undefined;
  /** Every changed file, for the hunks in no group. */
  files: readonly ReaderFile[];
  /** The view's size and Viewed progress, as its Viewed boxes count it. */
  size: { files: number; hunks: number; viewed: number };
  viewed: ReadonlySet<string>;
  /** The group's overview card. */
  overview: ReactNode;
  disclosure: GroupOverview;
  /** Group viewed's write for this group, as a file header's box shows its own. */
  box: ReturnType<typeof checkboxOf> | undefined;
  /** What the last Group viewed in this group changed, and whether it marked rather than unmarked. */
  marked: { said: string; viewed: boolean } | undefined;
  onView: (view: ReviewView) => void;
  onGroupViewed: () => void;
}) {
  const regionId = useId();
  const { status, group, size, disclosure } = props;
  const { groups } = status;
  const sizes = `${counted(size.files, "file")} · ${counted(size.hunks, "hunk")}`;
  const progress = !standalone && (
    <span {...stylex.props(bar.progress)}>
      <span aria-hidden {...stylex.props(bar.track)}>
        <span
          {...stylex.props(bar.fill)}
          style={{ width: `${size.hunks === 0 ? 0 : (size.viewed / size.hunks) * 100}%` }}
        />
      </span>
      {size.viewed}/{size.hunks} viewed
    </span>
  );
  if (group === undefined) {
    const path = props.review.kind === "files" ? props.review.path : "";
    const grouped = new Set(groups.flatMap(({ hunkIds }) => hunkIds));
    const outside = props.files.flatMap(({ hunks }) => hunks.filter(({ id }) => !grouped.has(id)));
    return (
      <div {...stylex.props(bar.box)}>
        <div {...stylex.props(bar.row)}>
          <span {...stylex.props(bar.chip)}>
            {path !== "" ? "Files" : groups.length > 0 ? "Walkthrough" : "All changes"}
          </span>
          {path !== "" && <span {...stylex.props(bar.title)}>{path}</span>}
          <span {...stylex.props(bar.meta)}>
            {path === "" && groups.length > 0 && `${counted(groups.length, "group")} · `}
            {sizes}
            {path === "" &&
              groups.length > 0 &&
              outside.length > 0 &&
              ` (${outside.length} not in a group)`}
          </span>
          {progress}
          <span {...stylex.props(bar.grow)} />
          {path === "" && groups[0] && (
            <button
              type="button"
              onClick={() => props.onView({ kind: "group", id: groups[0]!.id })}
              {...stylex.props(bar.button, bar.primary)}
            >
              Start with group 1 › <Keys command={command("nextGroup")} />
            </button>
          )}
        </div>
      </div>
    );
  }
  const index = groups.indexOf(group);
  const previous = groups[index - 1];
  const next = groups[index + 1];
  const { done } = groupProgress(group, props.viewed);
  const { box } = props;
  // The write's failure, said as a file header says its own, else what it changed.
  const unsaved =
    box?.failure !== undefined
      ? `Couldn't save Group viewed${box.failure instanceof Error ? `: ${box.failure.message.replace(/\.$/, "")}` : ""}. Group viewed tries again.`
      : box?.notice?.kind === "conflict"
        ? "Not saved: progress changed elsewhere and was read again."
        : box?.notice?.kind === "reload"
          ? "Progress can't be read again; reload the session."
          : undefined;
  // Said only once the daemon has it, so neither the change nor Next is offered before it saved.
  const pending =
    box?.pending === "sending"
      ? "Saving…"
      : box?.pending === "rereading"
        ? "Reading progress again…"
        : undefined;
  const said = pending ?? unsaved ?? props.marked?.said;
  const offer = pending === undefined && unsaved === undefined && props.marked?.viewed === true;
  return (
    <div {...stylex.props(bar.box)}>
      <div {...stylex.props(bar.row)}>
        <span {...stylex.props(bar.chip)}>
          Group {index + 1} of {groups.length}
        </span>
        <span {...stylex.props(bar.title)} title={group.title}>
          {group.title}
        </span>
        {status.preparation.groupsOutdated.includes(group.id) && (
          <span {...stylex.props(bar.outdated)}>Outdated</span>
        )}
        <span {...stylex.props(bar.meta)}>{sizes}</span>
        {progress}
        <span {...stylex.props(bar.grow)} />
        <button
          type="button"
          aria-expanded={disclosure.open}
          aria-controls={regionId}
          onClick={() => disclosure.toggle()}
          {...stylex.props(bar.button)}
        >
          <span aria-hidden {...stylex.props(bar.chevron, disclosure.open && bar.chevronOpen)}>
            ›
          </span>
          Overview <Keys command={command("groupOverview")} />
        </button>
        <span {...stylex.props(bar.arrows)}>
          <button
            type="button"
            aria-label="Previous group"
            title="Previous group (Shift+K)"
            disabled={previous === undefined}
            onClick={() => previous && props.onView({ kind: "group", id: previous.id })}
            {...stylex.props(bar.arrow)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next group"
            title="Next group (Shift+J)"
            disabled={next === undefined}
            onClick={() => next && props.onView({ kind: "group", id: next.id })}
            {...stylex.props(bar.arrow)}
          >
            ›
          </button>
        </span>
        {!standalone && (
          <button
            type="button"
            title={
              done
                ? "Mark every hunk of this group not Viewed"
                : "Mark every hunk of this group Viewed (read, not approved)"
            }
            disabled={group.hunkIds.length === 0}
            onClick={props.onGroupViewed}
            {...stylex.props(bar.button, !done && bar.primary)}
          >
            {done ? "Unmark group" : "Group viewed"} <Keys command={command("groupViewed")} />
          </button>
        )}
      </div>
      <p role="status" {...stylex.props(said !== undefined && bar.said)}>
        {said !== undefined && (
          <>
            <span>{said}</span>
            {offer && next && (
              <button
                type="button"
                onClick={() => props.onView({ kind: "group", id: next.id })}
                {...stylex.props(bar.button, bar.primary, bar.offer)}
              >
                <span {...stylex.props(bar.clip)}>Next group: {next.title}</span> ›
                <Keys command={command("nextGroup")} />
              </button>
            )}
            {offer && !next && <span>That was the last group.</span>}
          </>
        )}
      </p>
      {disclosure.open && (
        <CappedOverview id={regionId} disclosure={disclosure}>
          {props.overview}
        </CappedOverview>
      )}
    </div>
  );
}

/**
 * The overview, capped and scrolling inside the bar. While it hides more below, a fade and "more ↓"
 * say so; that button or the key scrolls the rest into view.
 */
function CappedOverview(props: { id: string; disclosure: GroupOverview; children: ReactNode }) {
  const { disclosure } = props;
  const [below, setBelow] = useState(false);
  const region = useRef<HTMLDivElement | null>(null);
  const measure = () => {
    const node = region.current;
    setBelow(node !== null && node.scrollHeight - node.clientHeight - node.scrollTop > 1);
  };
  useEffect(() => {
    const node = region.current;
    if (node === null) return;
    // The content grows after the first paint, as Markdown, diagrams and peeks render.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return (
    <div {...stylex.props(bar.capped)}>
      {/* Focusable, so the keyboard scrolls an overview taller than its cap. */}
      <div
        id={props.id}
        tabIndex={0}
        data-group-overview
        onScroll={measure}
        ref={(node) => {
          region.current = node;
          disclosure.region.current = node;
          if (node !== null && disclosure.top.current !== undefined) {
            node.scrollTop = disclosure.top.current;
            disclosure.top.current = undefined;
          }
          if (node === null || !disclosure.focus.current) return;
          disclosure.focus.current = false;
          node.focus({ preventScroll: true });
        }}
        {...stylex.props(bar.overview)}
      >
        {props.children}
      </div>
      {below && (
        <>
          <span aria-hidden {...stylex.props(bar.fade)} />
          <button
            type="button"
            aria-controls={props.id}
            aria-label="Show more of the overview"
            onClick={() => disclosure.showMore()}
            {...stylex.props(bar.button, bar.more)}
          >
            more ↓ <Keys command={command("groupOverview")} />
          </button>
        </>
      )}
    </div>
  );
}

const bar = stylex.create({
  box: {
    flexShrink: 0,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
    backgroundColor: theme.surface,
    padding: "8px 16px 8px 32px",
  },
  // Wraps rather than clips, so a narrow panel keeps every control on more rows.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 12px",
    minWidth: 0,
    minHeight: "28px",
  },
  chip: {
    flexShrink: 0,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: theme.select,
    fontFamily: theme["--mono"],
    fontSize: "11px",
    color: theme["--accent"],
  },
  title: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    fontWeight: 600,
  },
  outdated: { flexShrink: 0, fontSize: "12px", color: theme.hunkHeader },
  meta: { flexShrink: 0, fontSize: "12px", color: theme.muted },
  grow: { flex: "1" },
  progress: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
    fontFamily: theme["--mono"],
    fontSize: "11px",
    color: theme.muted,
  },
  track: {
    position: "relative",
    width: "56px",
    height: "4px",
    borderRadius: "999px",
    backgroundColor: theme.line,
    overflow: "hidden",
  },
  fill: { position: "absolute", insetBlock: 0, left: 0, backgroundColor: theme.add },
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
    padding: "3px 8px",
    borderRadius: "6px",
    fontSize: "12px",
    whiteSpace: "nowrap",
    color: { default: theme.muted, ":hover": theme.ink, ":disabled": theme.faint },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  primary: { color: theme.ink, backgroundColor: { default: theme.select, ":hover": theme.line } },
  // A long next title is cut, not the panel.
  offer: { maxWidth: "100%", minWidth: 0 },
  clip: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  chevron: { display: "inline-block", width: "10px", transition: "transform 120ms" },
  chevronOpen: { transform: "rotate(90deg)" },
  arrows: { display: "inline-flex", gap: "2px", flexShrink: 0 },
  arrow: {
    width: "24px",
    height: "24px",
    borderRadius: "6px",
    color: { default: theme.muted, ":hover": theme.ink, ":disabled": theme.line },
    backgroundColor: { default: null, ":hover": theme.select, ":disabled": null },
    fontSize: "16px",
    lineHeight: 1,
  },
  said: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 12px",
    marginTop: "6px",
    fontSize: "12px",
    color: theme.ink,
  },
  capped: { position: "relative", marginTop: "6px" },
  // Capped so a little over half of a 1280x800 window stays code; it scrolls inside.
  overview: {
    maxHeight: "26vh",
    overflow: "auto",
    outline: { default: "none", ":focus-visible": `1px solid ${theme["--accent"]}` },
    borderRadius: "6px",
  },
  fade: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    height: "40px",
    pointerEvents: "none",
    backgroundImage: `linear-gradient(to bottom, transparent, ${theme.surface})`,
  },
  more: {
    position: "absolute",
    right: "12px",
    bottom: "4px",
    color: theme.ink,
    backgroundColor: { default: theme.line, ":hover": theme.select },
  },
});
