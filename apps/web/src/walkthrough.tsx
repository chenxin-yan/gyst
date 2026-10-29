// The walkthrough's reading surfaces: the sidebar's ordered groups, the overview card above a view,
// and the note and foreign-change annotations inside the diff. Derivations live in walkthrough.ts.
import type { CapturedRange, StatusPayload } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import {
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RangeRead } from "./captured.ts";
import { PeekPreview } from "./peek.tsx";
import { rangeLabel, referenceLabel } from "./rich.ts";
import { RichText } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";
import {
  coverageOf,
  groupProgress,
  outdatedReason,
  type ReviewView,
  type StatusGroup,
  type StatusNote,
} from "./walkthrough.ts";

/**
 * The sidebar's walkthrough tab: its overview row and its groups in the agent's order, each with a
 * checkmark and count derived from Viewed hunks, in words as well as marks, and Outdated where a
 * refresh left it so, then its files. An incomplete walkthrough says what it still lacks; a plain
 * diff session needs none. Without `viewed` (a standalone walkthrough has no reading progress) a
 * group shows its hunk count alone.
 */
export function WalkthroughNav(props: {
  status: StatusPayload;
  viewed: ReadonlySet<string> | undefined;
  view: ReviewView;
  onView: (view: ReviewView) => void;
  /** A group's files, below its row. */
  groupFiles: (group: StatusGroup) => ReactNode;
  /** A last entry, for the hunks in no group. */
  ungrouped: ReactNode;
}) {
  const { status, view } = props;
  const coverage = coverageOf(status);
  const plain = status.preparation.state === "plain";
  const overviewShown = view.kind === "files" && view.path === "";
  const outdatedGroups = new Set(status.preparation.groupsOutdated);
  const outdatedMark = <span {...stylex.props(nav.outdated)}>Outdated</span>;
  return (
    <>
      {plain ? (
        <p {...stylex.props(nav.note)}>No walkthrough for this session yet.</p>
      ) : (
        <ul aria-label="Walkthrough" {...stylex.props(nav.list)}>
          {status.overview && (
            <li>
              <button
                type="button"
                aria-current={overviewShown || undefined}
                onClick={() => props.onView({ kind: "files", path: "" })}
                {...stylex.props(nav.row, overviewShown && nav.selected)}
              >
                <span {...stylex.props(nav.title)}>Overview</span>
                {status.preparation.overviewOutdated && outdatedMark}
              </button>
            </li>
          )}
          {status.groups.map((group) => {
            const progress = groupProgress(group, props.viewed ?? new Set());
            const selected = view.kind === "group" && view.id === group.id;
            const hunks = `${progress.total} ${progress.total === 1 ? "hunk" : "hunks"}`;
            const words =
              props.viewed === undefined
                ? hunks
                : progress.done
                  ? `all ${progress.viewed} of ${hunks} viewed`
                  : `${progress.viewed} of ${hunks} viewed`;
            const outdated = outdatedGroups.has(group.id);
            return (
              <li key={group.id}>
                <button
                  type="button"
                  aria-current={selected || undefined}
                  aria-label={`${group.title}, ${words}${outdated ? ", Outdated" : ""}`}
                  title={group.title}
                  onClick={() => props.onView({ kind: "group", id: group.id })}
                  {...stylex.props(
                    nav.row,
                    selected && nav.selected,
                    props.viewed !== undefined && (progress.done ? nav.faded : nav.inked),
                  )}
                >
                  {props.viewed === undefined && <span {...stylex.props(nav.check)} aria-hidden />}
                  <span {...stylex.props(nav.title)}>{group.title}</span>
                  {outdated && outdatedMark}
                  {props.viewed !== undefined && progress.done && (
                    <span {...stylex.props(nav.tick)} aria-hidden>
                      ✓
                    </span>
                  )}
                  <span {...stylex.props(nav.count)} aria-hidden>
                    {props.viewed === undefined
                      ? progress.total
                      : `${progress.viewed}/${progress.total}`}
                  </span>
                </button>
                {props.groupFiles(group)}
              </li>
            );
          })}
          {props.ungrouped}
        </ul>
      )}
      {coverage && (
        <div aria-label="Walkthrough coverage" {...stylex.props(nav.coverage)}>
          {coverage.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </>
  );
}

const nav = stylex.create({
  note: { padding: "0 10px", fontSize: "12px", color: theme.faint },
  list: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "1px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    minHeight: "26px",
    paddingInline: "10px",
    borderRadius: "6px",
    textAlign: "left",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  selected: { color: theme.ink, backgroundColor: theme.select },
  // A standalone walkthrough's empty leading column, which keeps its titles where they were.
  check: { flexShrink: 0, width: "12px" },
  // With Viewed shown, a group fades when done, with ✓ beside its count: ink is what is left.
  inked: { color: theme.ink },
  faded: { color: { default: theme.faint, ":hover": theme.muted } },
  tick: { flexShrink: 0, fontSize: "13px", color: theme.faint },
  title: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: { flexShrink: 0, fontFamily: theme["--mono"], fontSize: "11px", color: theme.faint },
  outdated: { flexShrink: 0, fontSize: "11px", color: theme.hunkHeader },
  coverage: {
    display: "grid",
    gap: "2px",
    margin: "8px 10px 0",
    fontSize: "12px",
    color: theme.muted,
  },
});

/** Focuses the reference to `refocus` inside `slot` whenever it is set: a closed peek's origin. */
export function useRefocus(
  slot: RefObject<HTMLElement | null>,
  refocus: CapturedRange | undefined,
) {
  useEffect(() => {
    if (refocus === undefined) return;
    const title = CSS.escape(referenceLabel(refocus));
    slot.current?.querySelector<HTMLElement>(`button[title="${title}"]`)?.focus({
      preventScroll: true,
    });
  }, [slot, refocus]);
}

/**
 * A view's overview: the walkthrough's above the whole snapshot, or a group's in the group bar.
 * Never a heading, which would join the file headers' outline.
 */
export function OverviewCard(props: {
  label: string;
  overview: StatusGroup["overview"];
  /** Why the overview, or the group it introduces, is Outdated; `outdatedReason`'s words. */
  outdated?: string | undefined;
  onReference: (target: CapturedRange) => void;
  /** The group's notes on earlier code (`EarlierNoteCard`), which have no place in the diff. */
  earlierNotes?: ReactNode;
  /** A reference peek followed from this overview, read in flow below it. */
  peek?: ReactNode;
  /** A reference whose peek just closed, focused again: Back rebuilds the overview it was in. */
  refocus?: CapturedRange | undefined;
  /** Without its own frame or top margin, inside the group bar's. */
  frameless?: boolean;
}) {
  const box = useRef<HTMLElement>(null);
  useRefocus(box, props.refocus);
  return (
    <section
      ref={box}
      aria-label={props.label}
      {...stylex.props(card.box, props.frameless && card.frameless)}
    >
      {props.outdated && (
        <p role="note" {...stylex.props(outdatedStyles.line)}>
          {props.outdated}
        </p>
      )}
      {props.overview ? (
        <RichText
          markdown={props.overview.markdown}
          references={props.overview.references}
          onReference={props.onReference}
        />
      ) : (
        <p {...stylex.props(card.missing)}>No overview yet.</p>
      )}
      {props.earlierNotes}
      {props.peek}
    </section>
  );
}

const card = stylex.create({
  box: {
    marginTop: "24px",
    padding: "12px 14px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `0 0 0 1px ${theme.line}`,
    fontFamily: theme.sans,
  },
  frameless: { marginTop: 0, padding: "2px 0 0", backgroundColor: null, boxShadow: "none" },
  missing: { fontSize: "12px", color: theme.faint },
});

/**
 * A note beside its code: a bare chevron chip naming its range, which collapses the note, and its
 * Markdown. Hovering or focusing it highlights the range it explains.
 */
export function NoteCard(props: {
  note: StatusNote;
  collapsed: boolean;
  onToggle: () => void;
  onHighlight: (range: CapturedRange | undefined) => void;
  onReference: (target: CapturedRange) => void;
  /** A reference whose peek just closed: focused again, also when the renderer remounts the note. */
  refocus?: CapturedRange | undefined;
  /** Replies to the note, starting its thread if it has none. */
  onReply?: (() => void) | undefined;
}) {
  const { note, onHighlight, refocus } = props;
  const slot = useRef<HTMLDivElement>(null);
  useRefocus(slot, refocus);
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) onHighlight(undefined);
  };
  return (
    <div
      ref={slot}
      data-annotation
      data-note={note.id}
      onMouseEnter={() => onHighlight(note.anchor)}
      onMouseLeave={() => onHighlight(undefined)}
      onFocus={() => onHighlight(note.anchor)}
      onBlur={leave}
      {...stylex.props(noteStyles.slot)}
    >
      <div {...stylex.props(noteStyles.box)}>
        <button
          type="button"
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
          {...stylex.props(noteStyles.chip)}
        >
          <span {...stylex.props(noteStyles.chevron, !props.collapsed && noteStyles.chevronOpen)} />
          {rangeLabel(note.anchor)}
          {note.outdated && <span {...stylex.props(outdatedStyles.tag)}>Outdated</span>}
        </button>
        {!props.collapsed && (
          <div {...stylex.props(noteStyles.body)}>
            {note.outdated && (
              <p role="note" {...stylex.props(outdatedStyles.line)}>
                {outdatedReason(note.outdated)}
              </p>
            )}
            <RichText
              markdown={note.markdown}
              references={note.references}
              onReference={props.onReference}
            />
            {props.onReply && (
              <button type="button" onClick={props.onReply} {...stylex.props(noteStyles.reply)}>
                Reply
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A note whose range a refresh could not map onto the current code, kept in its group above the
 * diff: its own captured lines from the earlier snapshot are disclosed on request, read from that
 * snapshot and never drawn as a current change.
 */
export function EarlierNoteCard(props: {
  note: StatusNote;
  read: () => Promise<RangeRead>;
  onReference: (target: CapturedRange) => void;
  /** Replies to the note, starting its thread if it has none; its conversation is in Comments. */
  onReply: () => void;
}) {
  const { note } = props;
  const [shown, setShown] = useState(false);
  return (
    <div data-earlier-note={note.id} {...stylex.props(noteStyles.box)}>
      <p {...stylex.props(noteStyles.chip)}>
        {referenceLabel(note.anchor)} · earlier snapshot{" "}
        <code>{note.anchor.snapshotId.slice(0, 7)}</code>
        <span {...stylex.props(outdatedStyles.tag)}>Outdated</span>
      </p>
      <div {...stylex.props(noteStyles.body)}>
        <p role="note" {...stylex.props(outdatedStyles.line)}>
          {outdatedReason(note.outdated)} Its lines are not in the current code.
        </p>
        <RichText
          markdown={note.markdown}
          references={note.references}
          onReference={props.onReference}
        />
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
          {...stylex.props(outdatedStyles.disclose)}
        >
          {shown ? "Hide the earlier code" : "Show the earlier code"}
        </button>
        {shown && <PeekPreview target={note.anchor} read={props.read} />}
        <button type="button" onClick={props.onReply} {...stylex.props(noteStyles.reply)}>
          Reply
        </button>
      </div>
    </div>
  );
}

const outdatedStyles = stylex.create({
  tag: { marginLeft: "6px", fontFamily: theme.sans, color: theme.hunkHeader },
  line: { marginBottom: "4px", fontSize: "12px", color: theme.hunkHeader },
  disclose: {
    marginBlock: "6px",
    fontSize: "12px",
    color: { default: theme.muted, ":hover": theme.ink },
  },
});

/** The owner of a change shown in a group view that another group, or none yet, explains. */
export function ForeignHunkLabel(props: { owner: string | undefined }) {
  return (
    <div data-annotation role="note" {...stylex.props(noteStyles.foreign)}>
      {props.owner === undefined
        ? "Not yet in a group"
        : `Change from another group · ${props.owner}`}
    </div>
  );
}

// Annotations pad rather than keep a margin, so the element's top is where its row begins.
const noteStyles = stylex.create({
  slot: { padding: "4px 10px 6px" },
  box: {
    padding: "6px 10px 8px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
    fontFamily: theme.sans,
    whiteSpace: "normal",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: { default: theme.muted, ":hover": theme.ink },
    fontFamily: theme["--mono"],
    fontSize: "11.5px",
  },
  chevron: {
    width: "5px",
    height: "5px",
    borderRightWidth: "1.5px",
    borderRightStyle: "solid",
    borderRightColor: theme.faint,
    borderBottomWidth: "1.5px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.faint,
    transform: "rotate(-45deg)",
  },
  chevronOpen: { transform: "rotate(45deg)" },
  body: { marginTop: "4px" },
  reply: {
    marginTop: "4px",
    fontSize: "12px",
    color: { default: theme.muted, ":hover": theme.ink },
  },
  foreign: {
    padding: "2px 10px 4px",
    fontFamily: theme.sans,
    fontSize: "12px",
    color: theme.changed,
    whiteSpace: "normal",
  },
});
