// The session sidebar's two tabs below the commits: the walkthrough, each group with its files as a
// small tree, and the snapshot-wide Files tree.
import type { StatusPayload } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { useId, useRef, useState } from "react";
import type { ReaderFile } from "./reader.ts";
import { theme } from "./tokens.stylex.ts";
import { GroupTree, SnapshotTree } from "./trees.tsx";
import type { ReviewView, StatusGroup } from "./walkthrough.ts";
import { WalkthroughNav } from "./walkthrough.tsx";

type Tab = "walkthrough" | "files";
const tabs: readonly Tab[] = ["walkthrough", "files"];
const tabNames: Record<Tab, string> = { walkthrough: "Walkthrough", files: "Files" };

/** A group tree's key: its files are fixed for its life (see GroupTree), so new ones remount it. */
const pathsKey = (treeFiles: readonly ReaderFile[]) => treeFiles.map(({ path }) => path).join("\n");

/** The tab last chosen, kept for the page's life: across a refresh's new snapshot and sessions. */
let chosenTab: Tab | undefined;

/** The tab a key moves to from the tab at `at`, or undefined for any other key. */
const tabAfter = (key: string, at: number): Tab | undefined =>
  ({
    ArrowLeft: tabs[(at + tabs.length - 1) % tabs.length],
    ArrowRight: tabs[(at + 1) % tabs.length],
    Home: tabs[0],
    End: tabs.at(-1),
  })[key];

/**
 * The walkthrough and Files tabs. The tab stays as chosen; choosing a view or moving by key never
 * switches it, and a plain session opens on Files. Only the open tab's content is mounted.
 */
export function Sidebar(props: {
  status: StatusPayload;
  /** Viewed hunk ids; undefined in a standalone walkthrough, which has no Viewed. */
  viewed: ReadonlySet<string> | undefined;
  review: ReviewView;
  /** Every loaded captured path, changed or not. */
  paths: readonly string[];
  /** The changed files by path. */
  files: ReadonlyMap<string, ReaderFile>;
  /** The file being read; undefined while a captured file is expanded. */
  current: string | undefined;
  onView: (view: ReviewView) => void;
  /** Enters a group at one of its files. */
  onGroupFile: (group: StatusGroup, path: string) => void;
}) {
  const { status, review, files, current } = props;
  const [tab, setTab] = useState<Tab>(
    () => chosenTab ?? (status.preparation.state === "plain" ? "files" : "walkthrough"),
  );
  const choose = (next: Tab) => {
    chosenTab = next;
    setTab(next);
  };
  const tabId = useId();
  const tabButtons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const filesOf = (paths: readonly string[]) => paths.flatMap((path) => files.get(path) ?? []);

  const groupTree = (group: StatusGroup) => {
    const groupFiles = filesOf(group.files);
    return (
      <div {...stylex.props(styles.tree)}>
        <GroupTree
          key={pathsKey(groupFiles)}
          label={`Files in ${group.title}`}
          files={groupFiles}
          hunkIds={new Set(group.hunkIds)}
          viewed={props.viewed}
          selected={review.kind === "group" && review.id === group.id ? current : undefined}
          onOpen={(path) => props.onGroupFile(group, path)}
        />
      </div>
    );
  };

  const grouped = new Set(status.groups.flatMap(({ hunkIds }) => hunkIds));
  const outside = [...files.values()].flatMap(({ hunks }) =>
    hunks.filter(({ id }) => !grouped.has(id)),
  );
  const outsideFiles = [...files.values()].filter(({ hunks }) =>
    hunks.some(({ id }) => !grouped.has(id)),
  );
  const outsideViewed = outside.filter(({ id }) => props.viewed?.has(id)).length;
  const outsideDone = outsideViewed === outside.length;
  const viewedShown = props.viewed !== undefined;
  // Said in one piece, as a group row's name is; the row's title, n/m and ✓ are only seen.
  const hunks = `${outside.length} ${outside.length === 1 ? "hunk" : "hunks"}`;
  const words = !viewedShown
    ? hunks
    : `${outsideDone ? "all " : ""}${outsideViewed} of ${hunks} viewed`;
  const ungrouped = status.groups.length > 0 && outsideFiles.length > 0 && (
    <li>
      <p
        {...stylex.props(
          styles.row,
          viewedShown && styles.marked,
          viewedShown && (outsideDone ? styles.faded : styles.inked),
        )}
      >
        <span {...stylex.props(styles.heard)}>Not in a group, {words}</span>
        <span aria-hidden {...stylex.props(styles.title)}>
          Not in a group
        </span>
        {viewedShown && outsideDone && (
          <span aria-hidden {...stylex.props(styles.tick)}>
            ✓
          </span>
        )}
        <span aria-hidden {...stylex.props(styles.count)}>
          {viewedShown ? `${outsideViewed}/${outside.length}` : outside.length}
        </span>
      </p>
      <div {...stylex.props(styles.tree)}>
        <GroupTree
          key={pathsKey(outsideFiles)}
          label="Files not in a group"
          files={outsideFiles}
          hunkIds={new Set(outside.map(({ id }) => id))}
          viewed={props.viewed}
          selected={review.kind === "files" && files.has(review.path) ? review.path : undefined}
          onOpen={(path) => props.onView({ kind: "files", path })}
        />
      </div>
    </li>
  );

  const allShown = review.kind === "files" && review.path === "";
  return (
    <>
      <div
        role="tablist"
        aria-label="Sidebar"
        onKeyDown={(event) => {
          const next = tabAfter(
            event.key,
            tabs.findIndex((each) => tabButtons.current[each] === event.target),
          );
          if (next === undefined) return;
          event.preventDefault();
          choose(next);
          tabButtons.current[next]?.focus();
        }}
        {...stylex.props(styles.tabs)}
      >
        {tabs.map((each) => (
          <button
            key={each}
            ref={(node) => void (tabButtons.current[each] = node)}
            type="button"
            role="tab"
            id={`${tabId}-${each}`}
            aria-selected={tab === each}
            aria-controls={`${tabId}-panel`}
            tabIndex={tab === each ? 0 : -1}
            onClick={() => choose(each)}
            {...stylex.props(styles.tab, tab === each && styles.tabSelected)}
          >
            {tabNames[each]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={`${tabId}-${tab}`}
        {...stylex.props(styles.panel, tab === "walkthrough" && styles.scroll)}
      >
        {tab === "walkthrough" ? (
          <WalkthroughNav
            status={status}
            viewed={props.viewed}
            view={review}
            onView={props.onView}
            groupFiles={groupTree}
            ungrouped={ungrouped}
          />
        ) : (
          <>
            <button
              type="button"
              aria-current={allShown || undefined}
              onClick={() => props.onView({ kind: "files", path: "" })}
              {...stylex.props(styles.row, styles.all, allShown && styles.selected)}
            >
              <span {...stylex.props(styles.title)}>All changes</span>
              <span {...stylex.props(styles.count)}>{files.size} changed</span>
            </button>
            <SnapshotTree
              paths={props.paths}
              files={files}
              viewed={props.viewed}
              selection={review.kind === "files" ? review.path : undefined}
              onSelect={(path) => props.onView({ kind: "files", path })}
            />
          </>
        )}
      </div>
    </>
  );
}

const styles = stylex.create({
  tabs: {
    display: "flex",
    gap: "14px",
    flexShrink: 0,
    margin: "8px 0",
    paddingInline: "10px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
  },
  tab: {
    padding: "4px 0 7px",
    marginBottom: "-1px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    borderRadius: "2px",
    fontSize: "12px",
    fontWeight: 500,
    color: { default: theme.faint, ":hover": theme.muted },
    outline: { default: "none", ":focus-visible": `1px solid ${theme["--accent"]}` },
    outlineOffset: "2px",
  },
  // Weight and an underline, not colour alone, mark the open tab.
  tabSelected: {
    fontWeight: 600,
    color: { default: theme.ink, ":hover": theme.ink },
    borderBottomColor: theme.muted,
  },
  panel: { flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" },
  scroll: { overflowY: "auto", overscrollBehavior: "none" },
  // A group's tree sits under its title, its rows a step in.
  tree: { paddingLeft: "16px", paddingBlock: "1px 6px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    minHeight: "26px",
    paddingInline: "28px 10px",
    borderRadius: "6px",
    textAlign: "left",
    color: theme.muted,
  },
  all: {
    flexShrink: 0,
    paddingLeft: "10px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  selected: { color: theme.ink, backgroundColor: theme.select },
  title: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  count: { flexShrink: 0, fontFamily: theme["--mono"], fontSize: "11px", color: theme.faint },
  // With Viewed shown, "Not in a group" fades when done as a group row does, without the leading
  // column a standalone walkthrough keeps.
  marked: { paddingLeft: "10px" },
  inked: { color: theme.ink },
  faded: { color: theme.faint },
  tick: { flexShrink: 0, fontSize: "13px", color: theme.faint },
  heard: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});
