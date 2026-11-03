// The sidebar's file trees on @pierre/trees, through its public API only: model options, model
// methods and the --trees-*-override CSS variables. The Files tab's snapshot-wide tree and each
// walkthrough group's tree share one look: `treeOptions`, `useViewedLook` and `styles.tree`.
import type { FileTreeRowDecoration, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import * as stylex from "@stylexjs/stylex";
import { type FocusEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { agentOrder } from "./order.ts";
import { type ReaderFile, statusOf } from "./reader.ts";
import { theme } from "./tokens.stylex.ts";
import {
  type FileMark,
  foldersOf,
  rowAnnouncement,
  treeRows,
  viewedStatuses,
} from "./tree-viewed.ts";
import { sectionViewed } from "./viewed.ts";

/** Every tree's rows: compact, folders compacted, no file icon and no folder dot. */
const treeOptions = {
  flattenEmptyDirectories: true,
  density: "compact",
  itemHeight: 26,
  icons: {
    set: "none",
    // Zero-sized like the built-in sheet, which the host lays out in flow.
    spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
<symbol id="gyst-blank" viewBox="0 0 16 16"/>
</svg>`,
    // The folder's "contains changes" dot goes too: in a group's tree every folder has one.
    remap: { "file-tree-icon-file": "gyst-blank", "file-tree-icon-dot": "gyst-blank" },
  },
} as const;

type Model = ReturnType<typeof useFileTree>["model"];
type Rows = ReturnType<typeof treeRows>;

const letterWords = { A: "Added", D: "Deleted", M: "Modified", R: "Renamed" } as const;

/**
 * A changed row's trailing decoration while Viewed is shown, which moves the letter here (see
 * `viewedStatuses`), with ✓ on a viewed row. `title` is the hover text, also for the letter.
 */
// TODO: Give status and Viewed to the row's accessible description once
// https://github.com/pierrecomputer/pierre/issues/1187 ships (a row is named by its basename only
// at 1.0.0-beta.6), so screen readers hear them in tree navigation, not just as this hover text.
function rowDecoration(viewedShown: boolean, mark: FileMark | undefined) {
  if (!viewedShown || mark === undefined) return null;
  const word = letterWords[mark.letter];
  const tone = mark.viewed ? theme.faint : theme.muted;
  const letter = { text: mark.letter, color: tone };
  return (
    mark.viewed
      ? {
          text: `✓ ${mark.letter}`,
          title: `${word}, Viewed`,
          parts: [{ text: "✓\u2002", color: tone }, letter],
        }
      : { text: mark.letter, title: word, parts: [letter] }
  ) satisfies FileTreeRowDecoration;
}

/**
 * One tree's Viewed look as tree options: its statuses, and its decorations, which read the latest
 * marks. `key` changes only with what the marks hold, though the sidebar passes new collections
 * every render.
 */
function useViewedLook(
  viewedShown: boolean,
  marks: ReadonlyMap<string, FileMark>,
  paths: readonly string[],
) {
  const decorate = useRef(marks);
  decorate.current = marks;
  const renderRowDecoration: FileTreeRowDecorationRenderer = ({ item }) =>
    item.kind === "file" ? rowDecoration(viewedShown, decorate.current.get(item.path)) : null;
  return {
    gitStatus: viewedStatuses(viewedShown, marks, paths),
    renderRowDecoration,
    key: JSON.stringify([viewedShown, [...marks], paths]),
  };
}

/**
 * Keeps a tree's Viewed look current. The model ignores later options, so a change goes through
 * its methods: `setComposition` rerenders even with the same composition, which reruns the row
 * decorations.
 */
const useViewedUpdates = (model: Model, look: ReturnType<typeof useViewedLook>) =>
  useEffect(() => {
    model.setGitStatus(look.gitStatus);
    model.setComposition(model.getComposition());
  }, [model, look.key]);

/**
 * What a polite live region says as tree focus moves: the focused row's path, then a file's status
 * and Viewed, or that it is a folder. Focus entering the tree says its row, each time. Nothing
 * while the tree has no focus, so a selection the reader syncs says nothing. `hostProps` go on the
 * tree's host, which sees focus enter and leave its shadow root.
 */
// TODO: Remove once https://github.com/pierrecomputer/pierre/issues/1187 gives a row an accessible
// description; at 1.0.0-beta.6 a row is named by its basename only.
function useRowAnnouncement(model: Model, marks: ReadonlyMap<string, FileMark>, tree: Rows) {
  const [said, setSaid] = useState("");
  const latest = useRef({ marks, tree });
  latest.current = { marks, tree };
  const within = useRef(false);
  const saidPath = useRef<string | null>(null);
  const say = () => {
    const path = model.getFocusedPath();
    if (path === null || path === saidPath.current) return;
    saidPath.current = path;
    setSaid(rowAnnouncement(latest.current.tree.pathOf(path), latest.current.marks.get(path)));
  };
  useEffect(() => model.subscribe(() => within.current && say()), [model]);
  const hostProps = {
    onFocus: () => {
      if (within.current) return;
      within.current = true;
      say();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      within.current = false;
      // Emptied, so the same row coming back is new text the region says again.
      saidPath.current = null;
      setSaid("");
    },
  };
  const region = (
    <p aria-live="polite" {...stylex.props(styles.said)}>
      {said}
    </p>
  );
  return { region, hostProps };
}

/**
 * Every loaded captured path, changed or not. Selecting a folder or a file opens all changes under
 * it; a changed file carries its A/M/D/R letter and its Viewed mark.
 */
export function SnapshotTree(props: {
  paths: readonly string[];
  files: ReadonlyMap<string, ReaderFile>;
  /** Viewed hunk ids; undefined in a standalone walkthrough, which has no Viewed. */
  viewed: ReadonlySet<string> | undefined;
  /** The selected path, "" for all changes; undefined while a walkthrough group is shown. */
  selection: string | undefined;
  onSelect: (path: string) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  // The reader lists a changed file's path from its manifest page and from its hunks, and the
  // tree throws on a duplicate path.
  const tree = useMemo(() => treeRows(props.paths), [props.paths]);
  const paths = tree.rows;
  const opened = () => [...new Set([...latest.current.files.keys()].flatMap(foldersOf))];
  const { viewed } = props;
  const marks = new Map(
    [...props.files.values()].map((file): [string, FileMark] => [
      tree.rowOf(file.path),
      {
        letter: statusOf(file),
        viewed:
          viewed !== undefined &&
          sectionViewed(
            file.hunks.map(({ id }) => id),
            viewed,
          ),
      },
    ]),
  );
  const look = useViewedLook(viewed !== undefined, marks, paths);
  const { model } = useFileTree({
    ...treeOptions,
    paths,
    initialExpandedPaths: opened(),
    gitStatus: look.gitStatus,
    renderRowDecoration: look.renderRowDecoration,
  });

  // The model ignores later options; more snapshot pages arrive through its own methods. A reset
  // rebuilds every folder, so a folder already there keeps its open state and only a new one
  // takes the default.
  const shown = useRef(paths);
  useEffect(() => {
    if (shown.current === paths) return;
    const before = new Set(shown.current.flatMap(foldersOf));
    shown.current = paths;
    const kept = [...before].filter((folder) => {
      const item = model.getItem(folder);
      return item !== null && "expand" in item && item.isExpanded();
    });
    const added = opened().filter((folder) => !before.has(folder));
    model.resetPaths(paths, { initialExpandedPaths: [...kept, ...added] });
  }, [model, paths]);
  useViewedUpdates(model, look);
  useSelected(model, props.selection === "" ? undefined : props.selection, tree, true);
  const announcement = useRowAnnouncement(model, marks, tree);
  const onClick = (event: MouseEvent) => {
    const row = chosenRow(model, event);
    if (row === undefined) return;
    // A directory's canonical path ends in "/"; the reader's paths don't.
    const path = tree.pathOf(row).replace(/\/$/, "");
    // A click both selects and toggles a folder, so opening an open folder's changes would close
    // it; a newly chosen folder opens again. Choosing it once selected still closes it.
    const item = model.getItem(row);
    if (path !== latest.current.selection && item && "expand" in item && !item.isExpanded())
      item.expand();
    latest.current.onSelect(path);
  };

  return (
    <>
      <FileTree
        model={model}
        // TODO: Name the tree itself once its role="tree" takes a label (raised on
        // https://github.com/pierrecomputer/pierre/issues/1187); this label lands on the host element.
        aria-label="Snapshot files"
        onClick={onClick}
        {...announcement.hostProps}
        {...stylex.props(styles.tree, viewed !== undefined && styles.inked, styles.fill)}
      />
      {announcement.region}
    </>
  );
}

/**
 * One walkthrough group's files (or the hunks in no group) as a small tree in the agent's file
 * order, as tall as its rows so the tab scrolls instead of each tree. The current file is its
 * selected row; choosing another file opens it.
 */
export function GroupTree(props: {
  label: string;
  /**
   * The group's changed files, in the agent's order. Their paths are fixed for the tree's life,
   * since its sort is fixed when it is made: a caller keys the tree by them.
   */
  files: readonly ReaderFile[];
  /** The hunks this tree counts toward a file's Viewed mark. */
  hunkIds: ReadonlySet<string>;
  viewed: ReadonlySet<string> | undefined;
  /** The file to show selected, when this tree holds the current file. */
  selected: string | undefined;
  onOpen: (path: string) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [tree] = useState(() => treeRows(props.files.map(({ path }) => path)));
  const paths = tree.rows;
  const { viewed, hunkIds } = props;
  const marks = new Map(
    props.files.map((file): [string, FileMark] => {
      const own = file.hunks.flatMap(({ id }) => (hunkIds.has(id) ? [id] : []));
      return [
        tree.rowOf(file.path),
        { letter: statusOf(file), viewed: viewed !== undefined && sectionViewed(own, viewed) },
      ];
    }),
  );
  const look = useViewedLook(viewed !== undefined, marks, paths);
  const { model } = useFileTree({
    ...treeOptions,
    paths,
    sort: agentOrder(paths),
    initialExpansion: "open",
    // Every row is in view, so the first render draws them all.
    initialVisibleRowCount: paths.length * 2,
    onSelectionChange: (selected) => {
      if (selected.length === 1 && !selected[0]!.endsWith("/")) return;
      // A folder only opens or closes here; the selection goes back to the current file once the
      // tree's own click handling is done.
      queueMicrotask(() => syncSelected(model, latest.current.selected, tree, false));
    },
    gitStatus: look.gitStatus,
    renderRowDecoration: look.renderRowDecoration,
  });

  useViewedUpdates(model, look);
  useSelected(model, props.selected, tree, false);
  const announcement = useRowAnnouncement(model, marks, tree);
  const onClick = (event: MouseEvent) => {
    const row = chosenRow(model, event);
    if (row !== undefined && !row.endsWith("/")) latest.current.onOpen(tree.pathOf(row));
  };

  const rows = useFileTreeSelector(model, (state) => state.getVisibleCount());
  return (
    <>
      <FileTree
        model={model}
        // TODO: Name the tree itself once @pierre/trees can (issues/1187); see SnapshotTree.
        aria-label={props.label}
        style={{ height: rows * model.getItemHeight() }}
        onClick={onClick}
        {...announcement.hostProps}
        {...stylex.props(styles.tree, viewed !== undefined && styles.inked, styles.group)}
      />
      {announcement.region}
    </>
  );
}

/**
 * The row a plain click chose, a directory's path ending in "/", or undefined for a click off the
 * rows. A row is a button, so Enter clicks it too. Selection changes can't tell it: choosing the
 * selected row again, to land at it or to leave an expanded reference, changes nothing.
 */
function chosenRow(model: Model, event: MouseEvent) {
  if (event.shiftKey || event.ctrlKey || event.metaKey) return undefined;
  // The innermost target: the tree's shadow root retargets `target` to its host.
  const [inner] = event.nativeEvent.composedPath();
  if (!(inner instanceof Element && inner.closest('[role="treeitem"]'))) return undefined;
  return model.getFocusedPath() ?? undefined;
}

/**
 * Makes `path` the tree's one selected row, or selects nothing. With `orFolder` the path may be a
 * folder's: a file replaced by a folder (see `treeRows`) then has both rows, and the one already
 * selected stays. Without it the path is a file's, the one being read.
 */
function syncSelected(model: Model, path: string | undefined, tree: Rows, orFolder: boolean) {
  const rows =
    path === undefined
      ? []
      : [model.getItem(tree.rowOf(path)), orFolder ? model.getItem(`${path}/`) : null].filter(
          (row) => row !== null,
        );
  const target = rows.find((row) => row.isSelected()) ?? rows[0];
  for (const each of model.getSelectedPaths())
    if (each !== target?.getPath()) model.getItem(each)?.deselect();
  if (target && !target.isSelected()) target.select();
}

const useSelected = (model: Model, path: string | undefined, tree: Rows, orFolder: boolean) =>
  useEffect(() => syncSelected(model, path, tree, orFolder), [model, path, tree, orFolder]);

const styles = stylex.create({
  // Public theming: the tree's documented --trees-*-override variables, set on its host.
  tree: {
    "--trees-font-family-override": theme.sans,
    "--trees-font-size-override": "13px",
    "--trees-bg-override": theme.frame,
    "--trees-bg-muted-override": theme.select,
    "--trees-fg-override": theme.muted,
    "--trees-fg-muted-override": theme.faint,
    "--trees-accent-override": theme["--accent"],
    "--trees-selected-bg-override": theme.select,
    "--trees-selected-fg-override": theme.ink,
    "--trees-selected-focused-border-color-override": theme["--accent"],
    "--trees-focus-ring-color-override": theme["--accent"],
    "--trees-border-color-override": theme.line,
    "--trees-indent-guide-bg-override": theme.line,
    "--trees-scrollbar-thumb-override": theme.line,
    "--trees-border-radius-override": "6px",
    "--trees-padding-inline-override": "0px",
    "--trees-icon-width-override": "12px",
    // Muted, since a status colours the file name with its letter; the letter carries the status.
    "--trees-git-added-color-override": theme.muted,
    "--trees-git-modified-color-override": theme.muted,
    "--trees-git-deleted-color-override": theme.muted,
    "--trees-git-renamed-color-override": theme.muted,
    // With Viewed shown, the "nothing left to read" tone (see `viewedStatuses`).
    "--trees-git-ignored-color-override": theme.faint,
  },
  // With Viewed shown, a row with something left to read, which has no status, is at full ink.
  inked: { "--trees-fg-override": theme.ink },
  // The Files tab's tree fills the tab, scrolling (and virtualizing) inside it.
  fill: { flex: "1 1 0", minHeight: 0 },
  group: { flexShrink: 0 },
  // Heard, not seen.
  said: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});
