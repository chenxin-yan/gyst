// The walkthrough's reading surfaces: the sidebar's ordered groups, the overview card above a view,
// and the note and foreign-change annotations inside the diff. Derivations live in walkthrough.ts.
import type { CapturedRange, StatusPayload } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import type { FocusEvent } from "react";
import { rangeLabel } from "./rich.ts";
import { RichText } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";
import {
  coverageOf,
  groupProgress,
  type ReviewView,
  type StatusGroup,
  type StatusNote,
} from "./walkthrough.ts";

/**
 * The sidebar's walkthrough: its overview row and its groups in the agent's order, each with a
 * checkmark and count derived from Viewed hunks, in words as well as marks. An incomplete
 * walkthrough says what it still lacks; a plain diff session needs none.
 */
export function WalkthroughNav(props: {
  status: StatusPayload;
  viewed: ReadonlySet<string>;
  view: ReviewView;
  onView: (view: ReviewView) => void;
}) {
  const { status, view } = props;
  const coverage = coverageOf(status);
  const plain = status.preparation.state === "plain";
  const overviewShown = view.kind === "files" && view.path === "";
  return (
    <>
      <p {...stylex.props(nav.head)}>Walkthrough</p>
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
              </button>
            </li>
          )}
          {status.groups.map((group) => {
            const progress = groupProgress(group, props.viewed);
            const selected = view.kind === "group" && view.id === group.id;
            const words = `${progress.viewed} of ${progress.total} ${progress.total === 1 ? "hunk" : "hunks"} viewed`;
            return (
              <li key={group.id}>
                <button
                  type="button"
                  aria-current={selected || undefined}
                  aria-label={`${group.title}, ${progress.done ? `all ${words}` : words}`}
                  title={group.title}
                  onClick={() => props.onView({ kind: "group", id: group.id })}
                  {...stylex.props(nav.row, selected && nav.selected)}
                >
                  <span {...stylex.props(nav.check, progress.done && nav.checkDone)} aria-hidden>
                    {progress.done ? "✓" : ""}
                  </span>
                  <span {...stylex.props(nav.title)}>{group.title}</span>
                  <span {...stylex.props(nav.count)} aria-hidden>
                    {progress.viewed}/{progress.total}
                  </span>
                </button>
              </li>
            );
          })}
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
  head: {
    padding: "4px 10px 8px",
    fontSize: "12px",
    fontWeight: 500,
    color: theme.muted,
  },
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
  check: { flexShrink: 0, width: "12px", color: theme.faint, fontSize: "11px" },
  checkDone: { color: theme.add },
  title: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: { flexShrink: 0, fontFamily: theme["--mono"], fontSize: "11px", color: theme.faint },
  coverage: {
    display: "grid",
    gap: "2px",
    margin: "8px 10px 0",
    fontSize: "12px",
    color: theme.muted,
  },
});

/**
 * The overview above a view's diff: the walkthrough's above the whole snapshot, or a group's above
 * its files. Never a heading, which would join the file headers' outline.
 */
export function OverviewCard(props: {
  label: string;
  title?: string | undefined;
  overview: StatusGroup["overview"];
  onReference: (target: CapturedRange) => void;
}) {
  return (
    <section aria-label={props.label} {...stylex.props(card.box)}>
      {props.title !== undefined && <p {...stylex.props(card.title)}>{props.title}</p>}
      {props.overview ? (
        <RichText
          markdown={props.overview.markdown}
          references={props.overview.references}
          onReference={props.onReference}
        />
      ) : (
        <p {...stylex.props(card.missing)}>No overview yet.</p>
      )}
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
  title: { marginBottom: "6px", fontSize: "14px", fontWeight: 600, color: theme.ink },
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
}) {
  const { note, onHighlight } = props;
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) onHighlight(undefined);
  };
  return (
    <div
      data-note={note.id}
      onMouseEnter={() => onHighlight(note.anchor)}
      onMouseLeave={() => onHighlight(undefined)}
      onFocus={() => onHighlight(note.anchor)}
      onBlur={leave}
      {...stylex.props(noteStyles.box)}
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        {...stylex.props(noteStyles.chip)}
      >
        <span {...stylex.props(noteStyles.chevron, !props.collapsed && noteStyles.chevronOpen)} />
        {rangeLabel(note.anchor)}
      </button>
      {!props.collapsed && (
        <div {...stylex.props(noteStyles.body)}>
          <RichText
            markdown={note.markdown}
            references={note.references}
            onReference={props.onReference}
          />
        </div>
      )}
    </div>
  );
}

/** The owner of a change shown in a group view that another group, or none yet, explains. */
export function ForeignHunkLabel(props: { owner: string | undefined }) {
  return (
    <div role="note" {...stylex.props(noteStyles.foreign)}>
      {props.owner === undefined
        ? "Not yet in a group"
        : `Change from another group · ${props.owner}`}
    </div>
  );
}

const noteStyles = stylex.create({
  box: {
    margin: "4px 10px 6px",
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
  foreign: {
    margin: "2px 10px 4px",
    fontFamily: theme.sans,
    fontSize: "12px",
    color: theme.changed,
    whiteSpace: "normal",
  },
});
