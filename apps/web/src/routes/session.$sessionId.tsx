import type { ContentSide, DaemonError, FilesPayload, Hunk, SessionSummary } from "@gyst/core/wire";
import type {
  CodeViewItem,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectionSide,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link,
  notFound,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isExpectedFailure, operation } from "../api.ts";
import {
  AllSessionsLink,
  Crumb,
  DeleteSession,
  FailureNotice,
  Frame,
  PillButton,
  Title,
  useMounted,
} from "../components.tsx";
import {
  capturedFilesLoader,
  changedFiles,
  fileDiffOf,
  isUnder,
  type LayoutMode,
  layoutOf,
  lineStats,
  type ReaderFile,
  statusOf,
  type TreeNode,
  treeKey,
  treeOf,
} from "../reader.ts";
import { media, theme } from "../tokens.stylex.ts";

export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params: { sessionId } }) => {
    try {
      const [opened, diff] = await Promise.all([
        operation({ command: "open", session: sessionId }),
        operation({ command: "diff", session: sessionId }),
      ]);
      // Captured reads name the snapshot the hunks came from.
      const { snapshotId } = diff;
      const files = await operation({ command: "files", session: sessionId, snapshotId });
      return { session: opened.session, hunks: diff.hunks, snapshotId, files };
    } catch (error) {
      if (isDaemonError(error, "no_session")) throw notFound();
      throw error;
    }
  },
  component: SessionPage,
  notFoundComponent: SessionNotFound,
});

const isDaemonError = (error: unknown, tag: DaemonError["_tag"]) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;

function SessionPage() {
  const { session, hunks, snapshotId, files } = Route.useLoaderData();
  // Keyed: another session or snapshot starts its own selection, pages and reading position.
  return (
    <SessionReader
      key={`${session.id}:${snapshotId}`}
      session={session}
      hunks={hunks}
      snapshotId={snapshotId}
      firstPage={files}
    />
  );
}

/** A file's captured sides being read for its first expansion, or why that read failed. */
type FileLoad = "loading" | { failure: unknown };

/** Where the reader is: a file and, inside its diff, the side and line at the top of the panel. */
type ReadingPosition = { file: string; side: SelectionSide | undefined; line: number | undefined };

function SessionReader(props: {
  session: SessionSummary;
  hunks: readonly Hunk[];
  snapshotId: string;
  firstPage: FilesPayload;
}) {
  const { session, hunks, snapshotId } = props;
  const navigate = useNavigate();
  const [pages, setPages] = useState([props.firstPage]);
  const [selection, setSelection] = useState("");
  const [mode, setMode] = useState<LayoutMode>("auto");
  const [width, setWidth] = useState(0);
  const [loads, setLoads] = useState<ReadonlyMap<string, FileLoad>>(new Map());
  const mounted = useMounted();

  const manifest = useMemo(() => pages.flatMap((page) => page.files), [pages]);
  const files = useMemo(() => changedFiles(hunks, manifest), [hunks, manifest]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  // One metadata object per file for the snapshot's life: the renderer hydrates it in place.
  const diffs = useMemo(
    () =>
      new Map(
        [...Map.groupBy(hunks, (hunk) => hunk.file)].map(([path, fileHunks]) => [
          path,
          fileDiffOf(path, fileHunks),
        ]),
      ),
    [hunks],
  );
  // Memoized: a new list makes the renderer reconcile its items and restore the reading position.
  const shown = useMemo(
    () => files.filter((file) => isUnder(file.path, selection)),
    [files, selection],
  );
  const layout = layoutOf(mode, width);

  const loadFiles = useMemo(
    () =>
      capturedFilesLoader((file, side, offset) =>
        operation({ command: "code", session: session.id, snapshotId, file, side, offset }),
      ),
    [session.id, snapshotId],
  );
  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata) => {
      const path = fileDiff.name;
      const setLoad = (load: FileLoad | undefined) =>
        mounted.current &&
        setLoads((before) => {
          const next = new Map(before);
          if (load === undefined) next.delete(path);
          else next.set(path, load);
          return next;
        });
      // A retry replaces the last failure at once.
      setLoad("loading");
      try {
        const loaded = await loadFiles(path);
        setLoad(undefined);
        return loaded;
      } catch (error) {
        // The renderer logs the rejection itself; the file header explains it.
        setLoad({ failure: error });
        throw error;
      }
    },
    [loadFiles, mounted],
  );

  const tree = useMemo(
    () => treeOf([...manifest.map((file) => file.path), ...files.map((file) => file.path)]),
    [manifest, files],
  );
  const hunkCount = shown.reduce((count, file) => count + file.hunks.length, 0);

  return (
    <Frame
      fill
      top={
        <>
          <Crumb session={session} />
          <span {...stylex.props(styles.grow)} />
          <AllSessionsLink />
          {/* Keyed: switching sessions on this route starts a new deletion intent, never B's retry. */}
          <DeleteSession
            key={session.id}
            session={session}
            onDeleted={() => navigate({ to: "/" })}
            popover
          />
        </>
      }
      side={
        <>
          <p {...stylex.props(styles.sideHead)}>Walkthrough</p>
          <p {...stylex.props(styles.sideNote)}>No walkthrough for this session yet.</p>
          <p {...stylex.props(styles.sideHead, styles.filesHead)}>
            Files <span {...stylex.props(styles.muted)}>{files.length} changed</span>
          </p>
          <FileTree nodes={tree} files={byPath} selection={selection} onSelect={setSelection} />
          <MoreFiles
            sessionId={session.id}
            snapshotId={snapshotId}
            pages={pages}
            onPage={(page) => setPages((loaded) => [...loaded, page])}
          />
        </>
      }
      status={
        <>
          <LayoutSwitch mode={mode} auto={layoutOf("auto", width)} onMode={setMode} />
          <span>
            {hunkCount} {hunkCount === 1 ? "hunk" : "hunks"} in {shown.length}{" "}
            {shown.length === 1 ? "file" : "files"}
          </span>
          <span {...stylex.props(styles.grow)} />
          <span>
            session <code>{session.id}</code>
          </span>
        </>
      }
    >
      {shown.length === 0 ? (
        <p {...stylex.props(styles.empty)}>
          {files.length === 0 ? (
            "This session's snapshot has no changes."
          ) : (
            <>
              No captured changes under <code>{selection}</code>.
            </>
          )}
        </p>
      ) : (
        <ContinuousDiff
          files={shown}
          byPath={byPath}
          diffs={diffs}
          layout={layout}
          loadDiffFiles={loadDiffFiles}
          loads={loads}
          onWidth={setWidth}
        />
      )}
    </Frame>
  );
}

const styles = stylex.create({
  muted: { color: theme.muted },
  grow: { flex: "1" },
  sideHead: {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 10px 8px",
    fontSize: "12px",
    fontWeight: 500,
    color: theme.muted,
  },
  filesHead: { marginTop: "14px" },
  sideNote: { padding: "0 10px", fontSize: "12px", color: theme.faint },
  empty: { padding: { default: "24px 32px", [media.narrow]: "16px 12px" }, color: theme.muted },
});

// ─── continuous diff ─────────────────────────────────────────────────────

/**
 * The selected files' captured changes as one virtualized, continuous reading surface. Each file
 * reads as one diff over its captured full contents: hidden ranges show their counts and expand
 * independently, loading the captured sides on first expansion. The reading position is logical
 * (file, side, line), so layout switches and selection changes restore it instead of a pixel offset.
 */
function ContinuousDiff(props: {
  files: readonly ReaderFile[];
  byPath: ReadonlyMap<string, ReaderFile>;
  diffs: ReadonlyMap<string, FileDiffMetadata>;
  layout: "split" | "stacked";
  loadDiffFiles: FileDiffContentsLoader;
  loads: ReadonlyMap<string, FileLoad>;
  onWidth: (width: number) => void;
}) {
  const { byPath, diffs, layout, loads, onWidth } = props;
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);
  const position = useRef<ReadingPosition>(undefined);
  // While a restoration is in flight, and while the reader stays where it put them, the renderer's
  // own scrolls and re-renders must not replace the position being restored.
  const restoring = useRef(false);
  const restoredTop = useRef<number>(undefined);
  // Bumped by every restore or abandon, so an older restoration's frame cannot reinstate its marker.
  const generation = useRef(0);

  /** Reads the file, side and line at the top of the panel from the renderer's current window. */
  const capture = useCallback(() => {
    const viewer = view.current?.getInstance();
    if (viewer === undefined || restoring.current) return;
    const scrollTop = viewer.getScrollTop();
    if (scrollTop === restoredTop.current) return;
    restoredTop.current = undefined;
    // The first line below the sticky file header is the one a reader sees at the top.
    const seen = scrollTop + headerHeight;
    for (const { id, type, instance } of viewer.getRenderedItems()) {
      const top = viewer.getTopForItem(id);
      if (top === undefined || seen < top || seen >= top + instance.height) continue;
      const anchor = type === "diff" ? instance.getNumericScrollAnchor(seen - top) : undefined;
      position.current = { file: id, side: anchor?.side, line: anchor?.lineNumber };
      return;
    }
  }, []);

  const items = useMemo(
    () =>
      props.files.map((file): CodeViewItem<undefined> => {
        const fileDiff = diffs.get(file.path);
        return fileDiff
          ? { id: file.path, type: "diff", fileDiff }
          : // No captured text to show: the header alone says why.
            {
              id: file.path,
              type: "file",
              file: { name: file.path, contents: "" },
              collapsed: true,
            };
      }),
    [props.files, diffs],
  );

  const options = useMemo(
    (): CodeViewReactOptions<undefined, undefined> => ({
      theme: "catppuccin-mocha",
      themeType: "dark",
      diffStyle: layout === "split" ? "split" : "unified",
      overflow: "wrap",
      diffIndicators: "bars",
      lineDiffType: "word",
      hunkSeparators: "line-info",
      expansionLineCount: 20,
      loadDiffFiles: props.loadDiffFiles,
      stickyHeaders: true,
      itemMetrics: { diffHeaderHeight: headerHeight, lineHeight: 20 },
      layout: { paddingTop: 24, paddingBottom: 120, gap: 10 },
      unsafeCSS: fileBoxCSS,
      // The renderer notifies scrolls before it moves its window, and renders items synchronously
      // inside its frame; reading once the frame is done sees the window a jump landed in.
      onPostRender: () => queueMicrotask(capture),
    }),
    [layout, props.loadDiffFiles, capture],
  );

  // The panel's content width decides auto layout; the viewport's never does.
  const observer = useRef<ResizeObserver>(undefined);
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = undefined;
      if (node === null) return;
      onWidth(node.clientWidth - horizontalPadding(node));
      observer.current = new ResizeObserver(([entry]) => onWidth(entry!.contentRect.width));
      observer.current.observe(node);
    },
    [onWidth],
  );

  // Restore the logical position after a layout switch or a new selection that still holds it.
  // A layout effect: it reads the position before any capture from the renderer's own re-render.
  useLayoutEffect(() => {
    const at = position.current;
    const current = ++generation.current;
    if (at === undefined || !items.some((item) => item.id === at.file)) {
      // Nothing to restore: the new selection's own top becomes the position.
      position.current = undefined;
      restoring.current = false;
      restoredTop.current = undefined;
      view.current?.scrollTo({ type: "position", position: 0 });
      return;
    }
    restoring.current = true;
    view.current?.scrollTo(
      at.line === undefined
        ? { type: "item", id: at.file, align: "start" }
        : {
            type: "line",
            id: at.file,
            lineNumber: at.line,
            ...(at.side && { side: at.side }),
            align: "start",
          },
    );
    // Queued after the renderer's frame for that scroll, so its post-render captures are skipped.
    requestAnimationFrame(() => {
      if (current !== generation.current) return;
      restoring.current = false;
      restoredTop.current = view.current?.getInstance()?.getScrollTop();
    });
  }, [layout, items]);

  return (
    <CodeView
      ref={view}
      {...stylex.props(diffStyles.view)}
      containerRef={containerRef}
      items={items}
      options={options}
      onScroll={capture}
      renderCustomHeader={(item) => (
        <FileHeader file={byPath.get(item.id)!} load={loads.get(item.id)} />
      )}
    />
  );
}

/** The file header bar's height, which FileHeader's style repeats. */
const headerHeight = 34;

const horizontalPadding = (node: HTMLElement) => {
  const style = getComputedStyle(node);
  return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
};

// The renderer styles its own shadow roots; `unsafeCSS` is its documented hook for the item box.
// It sits in the renderer's last cascade layer inside each item, never in the page's cascade.
const fileBoxCSS = `:host{border-radius:6px;box-shadow:0 0 0 1px ${theme.line};overflow:clip}`;

// The renderer's documented custom properties, fed from our tokens; they inherit into its shadow
// roots. Colours follow the Catppuccin guide's Diff & Merge roles, as in the accepted prototype.
const diffStyles = stylex.create({
  view: {
    height: "100%",
    overflow: "auto",
    paddingInline: { default: "32px", [media.narrow]: "12px" },
    "--diffs-font-family": theme["--mono"],
    "--diffs-header-font-family": theme.sans,
    "--diffs-font-size": "12.5px",
    "--diffs-line-height": "20px",
    "--diffs-addition-color-override": theme.add,
    "--diffs-deletion-color-override": theme.del,
    "--diffs-bg-context-override": theme.panelBg,
    "--diffs-bg-buffer-override": theme.surface,
    "--diffs-bg-separator-override": theme.surface,
    "--diffs-bg-addition-override": theme.add,
    "--diffs-bg-addition-number-override": theme.add,
    "--diffs-bg-addition-emphasis-override": `color-mix(in srgb, ${theme.add} 18%, transparent)`,
    "--diffs-bg-deletion-override": theme.del,
    "--diffs-bg-deletion-number-override": theme.del,
    "--diffs-bg-deletion-emphasis-override": `color-mix(in srgb, ${theme.del} 18%, transparent)`,
    "--diffs-fg-number-override": theme.faint,
    "--diffs-bg-selection-override": theme.select,
  },
});

// Short, so the reason fits the header bar even at narrow widths.
const notCaptured = {
  binary: "binary",
  "unsupported-encoding": "not UTF-8 text",
  symlink: "symbolic link",
  submodule: "submodule",
} satisfies Record<Extract<ContentSide, { kind: "unavailable" }>["reason"], string>;

/** What a file's header says besides its name: sides without text, renames and mode changes. */
function fileNotes({ manifest }: ReaderFile): string[] {
  if (manifest === undefined) return [];
  const notes = (["old", "new"] as const).flatMap((side) => {
    const content = manifest[side];
    return content.kind === "unavailable"
      ? [`${side === "old" ? "Old" : "New"} side not captured: ${notCaptured[content.reason]}.`]
      : [];
  });
  if (manifest.renamedFrom !== undefined)
    notes.push(`Renamed from ${manifest.renamedFrom}; not reviewed.`);
  if (manifest.modeChange !== undefined)
    notes.push(`Mode ${manifest.modeChange.old} → ${manifest.modeChange.new}; not reviewed.`);
  return notes;
}

/** The compact inset bar above each file's diff: name, folder, notes and line counts. */
function FileHeader(props: { file: ReaderFile; load: FileLoad | undefined }) {
  const { file, load } = props;
  const failure = typeof load === "object" ? load.failure : undefined;
  const router = useRouter();
  const slash = file.path.lastIndexOf("/");
  const notes = fileNotes(file);
  const stats = file.hunks.length > 0 ? lineStats(file.hunks) : undefined;
  const stale = isDaemonError(failure, "stale_revision");
  return (
    <div {...stylex.props(headerStyles.bar)}>
      <h2 {...stylex.props(headerStyles.title)} aria-label={file.path}>
        <span {...stylex.props(headerStyles.name)}>{file.path.slice(slash + 1)}</span>
        {slash >= 0 && (
          <span {...stylex.props(headerStyles.dir)}>{file.path.slice(0, slash + 1)}</span>
        )}
      </h2>
      {notes.length > 0 && (
        <span {...stylex.props(headerStyles.note)} title={notes.join(" ")}>
          {notes.join(" ")}
        </span>
      )}
      {load === "loading" && (
        <span role="status" {...stylex.props(headerStyles.note)}>
          Loading the captured file…
        </span>
      )}
      {typeof load === "object" && (
        <span role="alert" {...stylex.props(headerStyles.failure)}>
          {stale ? (
            <PillButton onClick={() => void router.invalidate()}>Reload session</PillButton>
          ) : (
            <>
              Couldn't load the captured file
              {failure instanceof Error ? `: ${failure.message}` : ""}. Expand again to retry.
            </>
          )}
        </span>
      )}
      <span {...stylex.props(styles.grow)} />
      {stats && (
        <span {...stylex.props(headerStyles.stat)}>
          <span {...stylex.props(headerStyles.add)}>+{stats.added}</span>{" "}
          <span {...stylex.props(headerStyles.del)}>−{stats.removed}</span>
        </span>
      )}
    </div>
  );
}

const headerStyles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "34px",
    padding: "0 10px",
    overflow: "hidden",
    backgroundColor: theme.surface,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
    color: theme.ink,
    fontFamily: theme.sans,
    fontSize: "13px",
    lineHeight: 1.5,
    whiteSpace: "nowrap",
  },
  title: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
    fontSize: "13px",
    fontWeight: 400,
  },
  name: { flexShrink: 0, fontWeight: 500 },
  dir: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: theme.faint,
    fontSize: "12px",
  },
  note: {
    flexShrink: 100,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: theme.muted,
    fontSize: "12px",
  },
  failure: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: theme.del },
  stat: { fontFamily: theme["--mono"], fontSize: "11.5px", lineHeight: "normal" },
  add: { color: theme.add },
  del: { color: theme.del },
});

// ─── layout switch ───────────────────────────────────────────────────────

const layoutNames = { split: "Split", stacked: "Stacked", auto: "Auto" } as const;

/** Split, stacked or auto, with the layout auto picks at the current width in its label. */
function LayoutSwitch(props: {
  mode: LayoutMode;
  auto: "split" | "stacked";
  onMode: (mode: LayoutMode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Diff layout" {...stylex.props(switchStyles.group)}>
      {(["split", "stacked", "auto"] as const).map((mode) => (
        <label
          key={mode}
          {...stylex.props(switchStyles.option, props.mode === mode && switchStyles.checked)}
        >
          <input
            type="radio"
            name="diff-layout"
            checked={props.mode === mode}
            onChange={() => props.onMode(mode)}
            {...stylex.props(switchStyles.input)}
          />
          {mode === "auto" ? `Auto (${props.auto})` : layoutNames[mode]}
        </label>
      ))}
    </div>
  );
}

const switchStyles = stylex.create({
  group: { display: "flex", gap: "10px" },
  option: { display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" },
  checked: { color: theme.ink },
  input: { margin: 0, accentColor: theme["--accent"] },
});

// ─── file tree ───────────────────────────────────────────────────────────

const statusNames = { A: "added", D: "deleted", M: "modified", R: "renamed" } as const;

/**
 * The snapshot-wide file tree: every loaded captured path, changed or not. Selecting the root, a
 * folder or a file shows all captured changes under it. Folders holding changes start open.
 */
function FileTree(props: {
  nodes: readonly TreeNode[];
  files: ReadonlyMap<string, ReaderFile>;
  selection: string;
  onSelect: (path: string) => void;
}) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const changedFolders = useMemo(() => {
    const folders = new Set<string>();
    for (const path of props.files.keys())
      for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
        folders.add(path.slice(0, slash));
    return folders;
  }, [props.files]);
  const isOpen = (path: string) => changedFolders.has(path) !== toggled.has(path);
  const toggle = (path: string) =>
    setToggled((before) => {
      const next = new Set(before);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const rows = (nodes: readonly TreeNode[], depth: number) =>
    nodes.map((node) => {
      const selected = props.selection === node.path;
      if (node.kind === "folder") {
        const open = isOpen(node.path);
        return (
          <li key={treeKey(node)}>
            <div {...stylex.props(treeStyles.row, selected && treeStyles.selected)}>
              <button
                type="button"
                {...stylex.props(treeStyles.chevron, treeStyles.indent(depth))}
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${node.path}`}
                onClick={() => toggle(node.path)}
              >
                <span {...stylex.props(treeStyles.mark, open && treeStyles.markOpen)} />
              </button>
              <button
                type="button"
                {...stylex.props(treeStyles.label)}
                aria-label={`${node.path}/`}
                aria-current={selected || undefined}
                onClick={() => props.onSelect(node.path)}
              >
                {node.name}
              </button>
            </div>
            {open && <ul>{rows(node.children, depth + 1)}</ul>}
          </li>
        );
      }
      const file = props.files.get(node.path);
      const status = file && statusOf(file);
      return (
        <li key={treeKey(node)}>
          <button
            type="button"
            {...stylex.props(
              treeStyles.row,
              treeStyles.file,
              treeStyles.indent(depth + 1),
              selected && treeStyles.selected,
              file === undefined && treeStyles.unchanged,
            )}
            aria-label={status ? `${node.path} (${statusNames[status]})` : node.path}
            aria-current={selected || undefined}
            onClick={() => props.onSelect(node.path)}
          >
            <span {...stylex.props(treeStyles.fileName)}>{node.name}</span>
            {status && (
              <span
                {...stylex.props(treeStyles.status, treeStyles[status])}
                title={statusNames[status]}
              >
                {status}
              </span>
            )}
          </button>
        </li>
      );
    });

  return (
    <div {...stylex.props(treeStyles.tree)}>
      <button
        type="button"
        {...stylex.props(
          treeStyles.row,
          treeStyles.file,
          treeStyles.indent(0),
          props.selection === "" && treeStyles.selected,
        )}
        aria-current={props.selection === "" || undefined}
        onClick={() => props.onSelect("")}
      >
        All changes
      </button>
      <ul aria-label="Snapshot files">{rows(props.nodes, 0)}</ul>
    </div>
  );
}

const treeStyles = stylex.create({
  tree: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: "1px",
    alignContent: "start",
  },
  row: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    minHeight: "26px",
    borderRadius: "6px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  selected: { color: theme.ink, backgroundColor: theme.select },
  file: { gap: "8px", paddingRight: "10px", textAlign: "left" },
  unchanged: { color: { default: theme.faint, ":hover": theme.ink } },
  indent: (depth: number) => ({ paddingLeft: `${10 + depth * 14}px` }),
  chevron: { display: "grid", placeItems: "center", alignSelf: "stretch", paddingRight: "4px" },
  mark: {
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
  markOpen: { transform: "rotate(45deg)" },
  label: {
    flex: "1",
    minWidth: 0,
    paddingRight: "10px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    alignSelf: "stretch",
    textAlign: "left",
  },
  fileName: {
    flex: "1",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  status: { fontFamily: theme["--mono"], fontSize: "11px", fontWeight: 500 },
  A: { color: theme.add },
  D: { color: theme.del },
  M: { color: theme.changed },
  R: { color: theme.changed },
});

/**
 * Loads the snapshot's next files page into the tree. A refresh that replaced the snapshot makes
 * the page cursor stale for good, so that failure offers a session reload instead of a retry.
 */
function MoreFiles(props: {
  sessionId: string;
  snapshotId: string;
  pages: readonly FilesPayload[];
  onPage: (page: FilesPayload) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const mounted = useMounted();
  const after = props.pages.at(-1)!.next;
  const total = props.pages[0]!.total;
  const shown = props.pages.reduce((count, page) => count + page.files.length, 0);
  const more = async (path: string) => {
    setPending(true);
    setFailure(undefined);
    try {
      const page = await operation({
        command: "files",
        session: props.sessionId,
        snapshotId: props.snapshotId,
        after: path,
      });
      if (mounted.current) props.onPage(page);
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (after === null && failure === undefined) return null;
  return (
    <div {...stylex.props(moreStyles.box)}>
      {failure !== undefined && <FailureNotice error={failure} />}
      {isDaemonError(failure, "stale_revision") ? (
        <PillButton onClick={() => void router.invalidate()}>Reload session</PillButton>
      ) : (
        after !== null && (
          <PillButton disabled={pending} onClick={() => void more(after)}>
            {pending
              ? "Loading files…"
              : failure !== undefined
                ? "Retry loading files"
                : `Load more files (${shown} of ${total} shown)`}
          </PillButton>
        )
      )}
    </div>
  );
}

const moreStyles = stylex.create({ box: { padding: "8px 4px", fontSize: "12px" } });

function SessionNotFound() {
  const { sessionId } = useParams({ strict: false });
  return (
    <Frame top={<Title>Session not found</Title>}>
      <p>
        No saved session has id <code>{sessionId}</code>. It may have been deleted.
      </p>
      <Link to="/">All saved sessions</Link>
    </Frame>
  );
}
