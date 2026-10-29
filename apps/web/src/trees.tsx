// The sidebar's file trees on @pierre/trees, through its public API only: model options, model
// methods and the --trees-*-override CSS variables. The Files tab's snapshot-wide tree and each
// walkthrough group's tree share one look: `treeOptions`, `useViewedLook` and `styles.tree`.
import type { FileTreeRowDecoration, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useMemo, useRef } from "react";
import { agentOrder } from "./order.ts";
import { type ReaderFile, statusOf } from "./reader.ts";
import { theme } from "./tokens.stylex.ts";
import { type FileMark, foldersOf, viewedStatuses } from "./tree-viewed.ts";
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
  const paths = useMemo(() => [...new Set(props.paths)], [props.paths]);
  const opened = () => [...new Set([...latest.current.files.keys()].flatMap(foldersOf))];
  const { viewed } = props;
  const marks = new Map(
    [...props.files.values()].map((file): [string, FileMark] => [
      file.path,
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
    onSelectionChange: (selected) => {
      // A directory's canonical path ends in "/"; the reader's paths don't.
      const path = selected.length === 1 ? selected[0]!.replace(/\/$/, "") : undefined;
      if (path === undefined || path === latest.current.selection) return;
      latest.current.onSelect(path);
      // A click both selects and toggles a folder, so opening an open folder's changes would
      // close it; a newly selected folder opens again. Clicking it once selected still closes it.
      queueMicrotask(() => {
        const item = model.getItem(selected[0]!);
        if (item && "expand" in item && !item.isExpanded()) item.expand();
      });
    },
    gitStatus: look.gitStatus,
    renderRowDecoration: look.renderRowDecoration,
  });

  // The model ignores later options; more snapshot pages arrive through its own methods.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    model.resetPaths(paths, { initialExpandedPaths: opened() });
  }, [model, paths]);
  useViewedUpdates(model, look);
  useSelected(model, props.selection === "" ? undefined : props.selection);

  return (
    <FileTree
      model={model}
      // TODO: Name the tree itself once its role="tree" takes a label (raised on
      // https://github.com/pierrecomputer/pierre/issues/1187); this label lands on the host element.
      aria-label="Snapshot files"
      {...stylex.props(styles.tree, viewed !== undefined && styles.inked, styles.fill)}
    />
  );
}

/**
 * One walkthrough group's files (or the hunks in no group) as a small tree in the agent's file
 * order, as tall as its rows so the tab scrolls instead of each tree. The current file is its
 * selected row; choosing another file opens it.
 */
export function GroupTree(props: {
  label: string;
  /** The group's changed files, in the agent's order. */
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
  const paths = useMemo(() => [...new Set(props.files.map(({ path }) => path))], [props.files]);
  const { viewed, hunkIds } = props;
  const marks = new Map(
    props.files.map((file): [string, FileMark] => {
      const own = file.hunks.flatMap(({ id }) => (hunkIds.has(id) ? [id] : []));
      return [
        file.path,
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
      const [path] = selected;
      const { selected: current, onOpen } = latest.current;
      if (selected.length === 1 && !path!.endsWith("/")) {
        if (path !== current) onOpen(path!);
        return;
      }
      // A folder only opens or closes here; the selection goes back to the current file once the
      // tree's own click handling is done.
      queueMicrotask(() => syncSelected(model, latest.current.selected));
    },
    gitStatus: look.gitStatus,
    renderRowDecoration: look.renderRowDecoration,
  });

  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    model.resetPaths(paths);
  }, [model, paths]);
  useViewedUpdates(model, look);
  useSelected(model, props.selected);

  const rows = useFileTreeSelector(model, (tree) => tree.getVisibleCount());
  return (
    <FileTree
      model={model}
      // TODO: Name the tree itself once @pierre/trees can (issues/1187); see SnapshotTree.
      aria-label={props.label}
      style={{ height: rows * model.getItemHeight() }}
      {...stylex.props(styles.tree, viewed !== undefined && styles.inked, styles.group)}
    />
  );
}

/** Makes `path` (a file or folder) the tree's one selected row, or selects nothing. */
function syncSelected(model: Model, path: string | undefined) {
  const target =
    path === undefined ? undefined : (model.getItem(path) ?? model.getItem(`${path}/`));
  for (const each of model.getSelectedPaths())
    if (each !== target?.getPath()) model.getItem(each)?.deselect();
  if (target && !target.isSelected()) target.select();
}

const useSelected = (model: Model, path: string | undefined) =>
  useEffect(() => syncSelected(model, path), [model, path]);

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
});
