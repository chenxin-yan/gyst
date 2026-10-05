import type {
  ContentSide,
  DaemonError,
  FilesPayload,
  Hunk,
  SessionSummary,
  StatusPayload,
} from "@gyst/core/wire";
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  FileDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  hydratePartialDiff,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import * as stylex from "@stylexjs/stylex";
import {
  type Hotkey,
  type HotkeyCallback,
  useHotkeySequences,
  useHotkeys,
} from "@tanstack/react-hotkeys";
import {
  createFileRoute,
  Link,
  notFound,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { events, isExpectedFailure, newRequestId, operation } from "../api.ts";
import { CommandMenu, KeyHelp } from "../commands.tsx";
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
  change,
  type Cursor,
  edge,
  fileStep,
  hiddenRanges,
  type Model,
  moved,
  type Opened,
  place,
  type Row,
  rowsOf,
  type Side,
  stopsOf,
  switched,
} from "../cursor.ts";
import { contentLoader, hydrationConcurrency, hydrationWindow, nearbyItems } from "../hydration.ts";
import { type Command, type CommandId, commandsFor, type InputMode, typed } from "../keymap.ts";
import {
  behind,
  initialLive,
  type LiveEvent,
  liveReducer,
  type LiveState,
  retryDelay,
} from "../live.ts";
import {
  capturedFiles,
  changedFiles,
  PagingStopped,
  fileDiffOf,
  isUnder,
  lateWholeFiles,
  type LayoutMode,
  layoutOf,
  lineStats,
  type ReaderFile,
  statusOf,
  type TreeNode,
  treeKey,
  treeOf,
  wholeFileType,
} from "../reader.ts";
import { media, theme } from "../tokens.stylex.ts";
import {
  checkboxOf,
  initialViewed,
  intentFor,
  readOneSnapshot,
  replayOf,
  sectionViewed,
  type StatusRead,
  type ViewedEvent,
  type ViewedIntent,
  viewedReducer,
  type ViewedState,
} from "../viewed.ts";

export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params: { sessionId } }) => {
    try {
      return await readOneSnapshot(async () => {
        const [opened, diff, status] = await Promise.all([
          operation({ command: "open", session: sessionId }),
          operation({ command: "diff", session: sessionId }),
          operation({ command: "status", session: sessionId }),
        ]);
        // Captured reads name the snapshot the hunks came from.
        const { snapshotId } = diff;
        const files = await operation({ command: "files", session: sessionId, snapshotId });
        return { session: opened.session, hunks: diff.hunks, snapshotId, files, status };
      });
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
  const { session, hunks, snapshotId, files, status } = Route.useLoaderData();
  // Keyed: another session or snapshot starts its own selection, pages and reading position.
  return (
    <SessionReader
      key={`${session.id}:${snapshotId}`}
      session={session}
      hunks={hunks}
      snapshotId={snapshotId}
      firstPage={files}
      status={status}
    />
  );
}

/** A file's captured sides being read for its first expansion, or why that read failed. */
type FileLoad = "loading" | { failure: unknown };

/** Where the reader is: a file and, inside its diff, the side and line at the top of the panel. */
type ReadingPosition = { file: string; side: Side | undefined; line: number | undefined };

/**
 * What the cursor overlay marks: a line on one split column or across the diff, a hidden range
 * (by its first hidden line, across the diff), or with no line a file header.
 */
type Mark = { file: string; side: Side; line?: number; full?: boolean };

const statusRead = (status: StatusPayload): StatusRead => ({
  snapshotId: status.session.snapshotId,
  revision: status.revision,
  viewedHunkIds: status.viewedHunkIds,
});

/** The reader's live link: its state, and how a failed read of what it announced reports itself. */
type LiveSession = { state: LiveState; lost: (generation: number, error: unknown) => void };

/**
 * The reader's subscription to its session's committed state, for as long as it is mounted. A
 * lost stream connects again with backoff and resynchronizes from its `ready`, until the session
 * is deleted or gyst refuses this browser.
 */
function useLiveSession(sessionId: string): LiveSession {
  const [state, setState] = useState(initialLive);
  const latest = useRef(state);
  const restart = useRef<LiveSession["lost"]>(() => {});
  useEffect(() => {
    let stopped = false;
    let connection = new AbortController();
    let wake = () => {};
    const apply = (event: LiveEvent) => {
      if (stopped) return latest.current;
      latest.current = liveReducer(latest.current, event);
      setState(latest.current);
      return latest.current;
    };
    // A loss the reader noticed first ends the stream it came over, which then connects again.
    restart.current = (generation, error) => {
      const before = latest.current;
      if (apply({ type: "lost", generation, error }) !== before) connection.abort();
    };
    void (async () => {
      for (;;) {
        const { generation } = apply({ type: "connect" });
        connection = new AbortController();
        let error: unknown;
        try {
          for await (const event of events(sessionId, connection.signal))
            apply({ type: "frame", generation, event });
        } catch (caught) {
          error = caught;
        }
        if (stopped) return;
        if (!connection.signal.aborted && error !== undefined && !isExpectedFailure(error))
          console.error(error);
        const { phase, attempts } = apply({ type: "lost", generation, error });
        if (phase === "deleted" || phase === "refused") return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelay(attempts));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (stopped) return;
      }
    })();
    return () => {
      stopped = true;
      connection.abort();
      wake();
    };
  }, [sessionId]);
  return { state, lost: (generation, error) => restart.current(generation, error) };
}

/**
 * Viewed progress, shared by every view of the snapshot: the reader's one copy of the Viewed hunk
 * ids and its writes. A write is refused while another is sent or status is read again, and while
 * gyst can't be reached: nothing is queued. The live link keeps it current: progress committed
 * elsewhere is read once more (one read at a time), and a write whose reply was lost is resent
 * with its request id once gyst answers again.
 */
function useViewedProgress(
  sessionId: string,
  snapshotId: string,
  status: StatusPayload,
  live: LiveSession,
) {
  const [state, setState] = useState(() => initialViewed(statusRead(status)));
  const latest = useRef<ViewedState>(state);
  const linked = useRef(live);
  linked.current = live;
  const mounted = useMounted();
  const apply = (event: ViewedEvent) => {
    const next = viewedReducer(latest.current, event);
    latest.current = next;
    if (mounted.current) setState(next);
    return next;
  };
  // A session reload reads status again; the same snapshot keeps this reader, so apply it here.
  // A write on the wire answers for itself.
  const loaded = useRef(status);
  useEffect(() => {
    if (loaded.current === status) return;
    loaded.current = status;
    if (latest.current.busy === undefined) apply({ type: "status", status: statusRead(status) });
  });
  const settle = async (next: ViewedState) => {
    if (next.busy?.kind !== "rereading") return;
    try {
      const read = await operation({ command: "status", session: sessionId });
      if (mounted.current) apply({ type: "status", status: statusRead(read) });
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) apply({ type: "unread", error });
    }
  };
  const send = (intent: ViewedIntent) => {
    apply({ type: "send", intent });
    void (async () => {
      try {
        const result = await operation({
          command: "viewed",
          session: sessionId,
          snapshotId,
          revision: intent.revision,
          requestId: intent.requestId,
          hunkIds: [...intent.hunkIds],
          viewed: intent.viewed,
        });
        if (mounted.current) await settle(apply({ type: "applied", result }));
      } catch (error) {
        if (!isExpectedFailure(error)) console.error(error);
        if (mounted.current) await settle(apply({ type: "failed", error }));
      }
    })();
  };
  const write = (file: string, hunkIds: readonly string[], viewed: boolean) => {
    const { phase } = linked.current.state;
    if (phase === "recovering" || phase === "deleted" || phase === "refused") return false;
    const intent = intentFor(latest.current, { file, hunkIds, viewed }, newRequestId);
    if (intent === undefined) return false;
    send(intent);
    return true;
  };
  // At most one automatic resend per announced version, so a reply lost again waits for Retry or
  // the next announcement rather than looping.
  const reading = useRef(false);
  const replayedAt = useRef<LiveState["known"]>(undefined);
  const sync = () => {
    const current = latest.current;
    const { state: now, lost } = linked.current;
    if (!mounted.current || current.busy || reading.current || now.phase !== "live") return;
    const replay = replayOf(current);
    if (replay && replayedAt.current !== now.known) {
      replayedAt.current = now.known;
      return send(replay);
    }
    if (behind(now, current) !== "read") return;
    reading.current = true;
    void operation({ command: "status", session: sessionId })
      .then(
        // A write sent meanwhile answers for itself; this read is checked again after it settles.
        (read) => {
          if (mounted.current && latest.current.busy === undefined)
            apply({ type: "status", status: statusRead(read) });
        },
        // Not this file's failure: the link recovers, then reads again from its `ready`.
        (error: unknown) => {
          if (!isExpectedFailure(error)) console.error(error);
          if (mounted.current) lost(now.generation, error);
        },
      )
      .finally(() => {
        reading.current = false;
        sync();
      });
  };
  useEffect(sync, [live.state, state]);
  return { state, write };
}

/** Keydowns that type text rather than command the reader. */
const isTextEntry = (target: Element | null) =>
  target !== null &&
  (target.closest("textarea, select, [contenteditable]:not([contenteditable='false'])") !== null ||
    (target instanceof HTMLInputElement &&
      !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
        target.type,
      )));

/** Lines a Mouse-mode j or k scrolls. */
const lineStep = 57;

function SessionReader(props: {
  session: SessionSummary;
  hunks: readonly Hunk[];
  snapshotId: string;
  firstPage: FilesPayload;
  status: StatusPayload;
}) {
  const { session, hunks, snapshotId } = props;
  const navigate = useNavigate();
  const router = useRouter();
  const [pages, setPages] = useState([props.firstPage]);
  const [selection, setSelection] = useState("");
  const [mode, setMode] = useState<LayoutMode>("auto");
  const [width, setWidth] = useState(0);
  const [loads, setLoads] = useState<ReadonlyMap<string, FileLoad>>(new Map());
  const [inputMode, setInputMode] = useState<InputMode>("vim");
  const [cursor, setCursor] = useState<Cursor>();
  const [lines, setLines] = useState<CodeViewLineSelection | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<"menu" | "help">();
  // Hidden lines opened per file. They live here, not in the renderer, which forgets them with
  // an item it drops; bumping the version re-reads the cursor model after the renderer opened some.
  const [opened] = useState(() => new Map<string, Map<number, Opened>>());
  const [, setOpenedVersion] = useState(0);
  const viewer = useRef<Viewer>(null);
  const live = useLiveSession(session.id);
  const progress = useViewedProgress(session.id, snapshotId, props.status, live);
  const mounted = useMounted();

  // A later page answers the cursor it was asked with; one already appended is dropped.
  const addPage = useCallback((after: string, page: FilesPayload) => {
    setPages((loaded) => (loaded.at(-1)!.next === after ? [...loaded, page] : loaded));
  }, []);
  // Files without hunks (binary, rename, mode) appear only once their page loads, so pages load
  // in the background, one at a time. A failure stops here; the tree's button retries.
  const nextPage = pages.at(-1)!.next;
  const [pageFailure, setPageFailure] = useState<unknown>();
  useEffect(() => {
    if (nextPage === null || pageFailure !== undefined) return;
    let current = true;
    operation({ command: "files", session: session.id, snapshotId, after: nextPage }).then(
      (page) => current && addPage(nextPage, page),
      (error: unknown) => {
        if (!isExpectedFailure(error)) console.error(error);
        if (current) setPageFailure(error);
      },
    );
    return () => {
      current = false;
    };
  }, [nextPage, pageFailure, session.id, snapshotId, addPage]);

  const manifest = useMemo(() => pages.flatMap((page) => page.files), [pages]);
  const files = useMemo(() => changedFiles(hunks, manifest), [hunks, manifest]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  // Memoized: a new list makes the renderer reconcile its items and restore the reading position.
  const shown = useMemo(
    () => files.filter((file) => isUnder(file.path, selection)),
    [files, selection],
  );
  const layout = layoutOf(mode, width);

  // The metadata each file shows, and the one place its full contents are kept: its partial
  // shape, which the renderer hydrates in place when a range opens before the file loaded eagerly,
  // or an eagerly loaded clone. Kept once loaded: the renderer retains the rendered diffs of the
  // items it recycles, so dropping ours would not bound memory (#108).
  const [diffs, setDiffs] = useState<ReadonlyMap<string, FileDiffMetadata>>(
    () =>
      new Map(
        files.flatMap((file) => (file.hunks.length > 0 ? [[file.path, fileDiffOf(file)]] : [])),
      ),
  );

  const setLoad = useCallback(
    (path: string, load: FileLoad | undefined) =>
      mounted.current &&
      setLoads((before) => {
        const next = new Map(before);
        if (load === undefined) next.delete(path);
        else next.set(path, load);
        return next;
      }),
    [mounted],
  );
  // Every captured-content read, eager or the renderer's, goes through this one bounded loader.
  // Visible and nearby files load eagerly, so every hidden range, the trailing one too, shows the
  // renderer's exact count and the cursor stops on it.
  const loader = useMemo(
    () =>
      contentLoader({
        concurrency: hydrationConcurrency,
        read: async (path, wanted) => {
          setLoad(path, "loading");
          try {
            const loaded = await capturedFiles(
              path,
              (side, offset) =>
                operation({
                  command: "code",
                  session: session.id,
                  snapshotId,
                  file: path,
                  side,
                  offset,
                }),
              wanted,
            );
            setLoad(path, undefined);
            return loaded;
          } catch (error) {
            // The renderer logs its own rejections; the file header explains a failure. A file
            // that left the window stopped on purpose and loads again on return.
            setLoad(path, error instanceof PagingStopped ? undefined : { failure: error });
            throw error;
          }
        },
        onLoaded: (path, loaded) =>
          mounted.current &&
          setDiffs((before) => {
            // The renderer may have hydrated the one it shows in place meanwhile (a range opened).
            const diff = before.get(path)!;
            // A late files page may have rebuilt it as new or deleted, which nothing hydrates.
            if (!diff.isPartial || (diff.type !== "change" && diff.type !== "rename-changed"))
              return before;
            return new Map(before).set(path, hydratePartialDiff("clone", diff, loaded));
          }),
      }),
    [session.id, snapshotId, setLoad, mounted],
  );
  // Resumed as well as stopped here: StrictMode replays this effect on the same memoized loader.
  useEffect(() => {
    loader.start();
    return () => loader.stop();
  }, [loader]);
  const loadDiffFiles = useCallback(
    (fileDiff: FileDiffMetadata) => {
      // A retry replaces the last failure at once, while it waits for a free slot.
      setLoad(fileDiff.name, "loading");
      // Rejected, not resolved empty, so the renderer hydrates nothing and the range can open
      // again. A request withdrawn before it read never reached `read`, which clears the status.
      // The renderer logs every rejection with console.error, a cancellation included:
      // `loadDiffFiles` has no abort contract, and its `disableErrorHandling` only rethrows into a
      // promise nobody observes.
      return loader.request(fileDiff.name).catch((error: unknown) => {
        if (error instanceof PagingStopped) setLoad(fileDiff.name, undefined);
        throw error;
      });
    },
    [loader, setLoad],
  );

  // A files page can bring a file's entry after its diff was built without one, and only the
  // entry says a whole side has no lines. A load that failed meanwhile no longer applies.
  useEffect(() => {
    const late = lateWholeFiles(files, diffs);
    if (late.length === 0) return;
    for (const file of late) setLoad(file.path, undefined);
    setDiffs((before) => {
      const next = new Map(before);
      for (const file of late) next.set(file.path, fileDiffOf(file));
      return next;
    });
  }, [files, diffs, setLoad]);

  const hydratable = useMemo(
    () =>
      shown.flatMap((file) => {
        const type = diffs.get(file.path)?.type;
        // Until a files page has the entry, a new or deleted file loads as a change with an empty
        // side; one known to be whole-side empty needs no load.
        return wholeFileType(file.manifest) === undefined &&
          (type === "change" || type === "rename-changed")
          ? [file.path]
          : [];
      }),
    [shown, diffs],
  );
  // A renderer request reads on while its file is selected, even outside the window, and no longer.
  useEffect(() => loader.select(shown.map((file) => file.path)), [loader, shown]);
  // The files the panel showed last; the window follows them and the selection.
  const visible = useRef<readonly string[]>([]);
  const followWindow = useCallback(() => {
    // Only files still partial: one the renderer hydrated in place (a range opened) is loaded,
    // and one whose result it dropped loads again.
    loader.want(
      hydrationWindow(hydratable, visible.current, nearbyItems).filter(
        (path) => diffs.get(path)!.isPartial,
      ),
    );
  }, [loader, hydratable, diffs]);
  useEffect(followWindow, [followWindow]);
  const onWindow = useCallback(
    (shownNow: readonly string[]) => {
      visible.current = shownNow;
      followWindow();
    },
    [followWindow],
  );

  const tree = useMemo(
    () => treeOf([...manifest.map((file) => file.path), ...files.map((file) => file.path)]),
    [manifest, files],
  );
  const hunkCount = shown.reduce((count, file) => count + file.hunks.length, 0);
  const viewedCount = shown.reduce(
    (count, file) => count + file.hunks.filter((hunk) => progress.state.viewed.has(hunk.id)).length,
    0,
  );

  // ─── the cursor's model: rows and stops of the shown files, read from logical state ───
  const model = useMemo((): Model => {
    const rows = (file: string) => {
      const diff = diffs.get(file);
      return diff && !folded.has(file) ? rowsOf(diff, opened.get(file) ?? new Map()) : [];
    };
    return {
      files: shown.map((file) => file.path),
      rows,
      stops: (file, side) => stopsOf(file, rows(file), layout, side),
    };
  }, [shown, folded, diffs, layout, opened]);
  const first = model.files[0];
  const current: Cursor | undefined =
    cursor && model.files.includes(cursor.file)
      ? cursor
      : first === undefined
        ? undefined
        : { file: first, kind: "header", side: "additions" };
  // The stop the cursor stands on in this layout; the cursor itself keeps its own side and line.
  const here = current && place(model, current);
  const vim = inputMode === "vim";
  const selecting = vim && lines !== null && here?.kind === "line" && lines.id === here.file;

  const markOf = (target: Cursor): Mark | undefined => {
    if (target.kind === "header") return { file: target.file, side: target.side };
    if (target.kind === "line")
      return { file: target.file, side: target.side, line: target.line, full: layout !== "split" };
    const row = model
      .rows(target.file)
      .find(
        (candidate): candidate is Extract<Row, { kind: "range" }> =>
          candidate.kind === "range" && candidate.range === target.range,
      );
    return row && { file: target.file, side: "additions", line: row.new, full: true };
  };

  /** Moves the cursor (and a selection's moving end) and keeps it in view. */
  const go = (target: Cursor | undefined, how: "nearest" | "top" = "nearest") => {
    if (target === undefined) return;
    setCursor(target);
    if (selecting && target.kind === "line")
      setLines({ id: lines.id, range: { ...lines.range, end: target.line, endSide: target.side } });
    const mark = markOf(target);
    if (mark) viewer.current?.reveal(mark, how);
  };

  /** Folds or unfolds files, then (in Vim) keeps the cursor's new place in view. */
  const setFolds = (paths: readonly string[], fold: boolean, then?: Cursor) => {
    flushSync(() => {
      setFolded((before) => {
        const next = new Set(before);
        for (const path of paths) {
          if (fold) next.add(path);
          else next.delete(path);
        }
        return next;
      });
      // A selection outlives its file's fold: it shows again when the file unfolds.
      if (then) setCursor(then);
    });
    if (then && vim) viewer.current?.reveal({ file: then.file, side: then.side }, "nearest");
  };

  /** Opens a hidden range whole and puts the cursor on its first line once the sides are loaded. */
  const openRange = (target: Extract<Cursor, { kind: "range" }>) => {
    const diff = diffs.get(target.file);
    const range = diff && hiddenRanges(diff).find(({ index }) => index === target.range);
    if (diff === undefined || range === undefined) return;
    const row = markOf(target);
    viewer.current?.expand(target.file, range.index, range.size);
    // A partial diff opens once its sides load; the renderer reports it back after hydration.
    if (diff.isPartial || row?.line === undefined) return;
    const byRange = opened.get(target.file) ?? new Map<number, Opened>();
    byRange.set(range.index, { fromStart: range.size, fromEnd: 0 });
    opened.set(target.file, byRange);
    const offset = row.line - range.new;
    const side = layout === "split" ? target.side : "additions";
    go({
      file: target.file,
      kind: "line",
      side,
      line: (side === "deletions" ? range.old : range.new) + offset,
    });
  };

  const hunkIdsOf = (path: string) => byPath.get(path)?.hunks.map((hunk) => hunk.id) ?? [];

  /**
   * Checks or unchecks a file section's Viewed box. Checking folds the file and goes to the next
   * unviewed file; unchecking unfolds it. Only the section's hunks change.
   */
  const toggleViewed = (path: string) => {
    const hunkIds = hunkIdsOf(path);
    if (hunkIds.length === 0) return;
    const viewed = !checkboxOf(progress.state, path, hunkIds).checked;
    if (!progress.write(path, hunkIds, viewed)) return;
    if (!viewed) return setFolds([path], false);
    const at = model.files.indexOf(path);
    const next = [...model.files.slice(at + 1), ...model.files.slice(0, Math.max(at, 0))].find(
      (other) =>
        hunkIdsOf(other).length > 0 && !sectionViewed(hunkIdsOf(other), progress.state.viewed),
    );
    const side = here?.side ?? "additions";
    flushSync(() => {
      setFolded((before) => {
        const after = new Set(before).add(path);
        if (next) after.delete(next);
        return after;
      });
      setCursor({ file: next ?? path, kind: "header", side });
    });
    viewer.current?.reveal({ file: next ?? path, side }, "top");
  };

  /** The file a Mouse-mode command acts on: the one at the top of the panel. */
  const fileInView = () => viewer.current?.fileInView() ?? first;

  const run = (id: CommandId) => {
    const view = viewer.current;
    if (id === "menu" || id === "help") return setDialog(id);
    if (id === "mode") {
      setLines(null);
      return setInputMode(vim ? "mouse" : "vim");
    }
    if (id === "split" || id === "stacked" || id === "auto") return setMode(id);
    if (id === "unfoldAll" || id === "foldAll") {
      const fold = id === "foldAll";
      return setFolds(model.files, fold, fold && here ? { ...here, kind: "header" } : undefined);
    }
    if (id === "cancel") return setLines(null);
    if (!vim) {
      // Mouse mode: movement scrolls; folds and Viewed act on the file at the top of the panel.
      const height = view?.height() ?? 0;
      const top = view?.visibleAt("top");
      const file = fileInView();
      switch (id) {
        case "down":
        case "up":
          return view?.scrollBy(id === "down" ? lineStep : -lineStep);
        case "halfDown":
        case "halfUp":
          return view?.scrollBy((id === "halfDown" ? 1 : -1) * (height / 2));
        case "top":
        case "bottom":
          return view?.scrollToEdge(id);
        case "nextChange":
        case "previousChange":
        case "nextFile":
        case "previousFile": {
          if (top === undefined) return;
          const direction = id.startsWith("next") ? 1 : -1;
          const target = id.endsWith("Change")
            ? change(model, place(model, top), direction)
            : fileStep(model, place(model, top), direction);
          const mark = target && markOf(target);
          return mark && view?.reveal(mark, "top");
        }
        case "unfold":
        case "fold":
        case "toggleFold":
          if (file === undefined || !diffs.has(file)) return;
          return setFolds([file], id === "fold" || (id === "toggleFold" && !folded.has(file)));
        case "viewed":
          return file && toggleViewed(file);
        default:
          return;
      }
    }
    if (here === undefined) return;
    switch (id) {
      case "down":
      case "up":
        return go(moved(model, here, id === "down" ? 1 : -1, selecting));
      case "halfDown":
      case "halfUp": {
        const height = view?.height() ?? 0;
        const count = Math.max(1, Math.round(height / 2 / lineHeight));
        const target = moved(model, here, (id === "halfDown" ? 1 : -1) * count, selecting);
        const from = markOf(here);
        const offset = from && view?.offsetOf(from);
        const mark = markOf(target);
        setCursor(target);
        if (selecting && target.kind === "line")
          setLines({
            id: lines.id,
            range: { ...lines.range, end: target.line, endSide: target.side },
          });
        if (mark) {
          if (offset === undefined) view?.reveal(mark, "nearest");
          else view?.placeAt(mark, offset);
        }
        return;
      }
      case "top":
      case "bottom":
        if (selecting) return go(moved(model, here, id === "top" ? -1e9 : 1e9, true));
        return go(edge(model, id === "top" ? "first" : "last", here.side));
      case "oldSide":
      case "newSide":
        if (layout !== "split" || selecting) return;
        return go(switched(model, here, id === "oldSide" ? "deletions" : "additions"));
      case "select":
        if (lines !== null) return setLines(null);
        if (here.kind !== "line") return;
        return setLines({
          id: here.file,
          range: { start: here.line, side: here.side, end: here.line, endSide: here.side },
        });
      case "nextChange":
      case "previousChange":
        if (selecting) return;
        return go(change(model, here, id === "nextChange" ? 1 : -1));
      case "nextFile":
      case "previousFile":
        if (selecting) return;
        return go(fileStep(model, here, id === "nextFile" ? 1 : -1), "top");
      case "open":
        if (here.kind === "range") return openRange(here);
        if (here.kind === "header" && diffs.has(here.file))
          return setFolds([here.file], !folded.has(here.file));
        return;
      case "unfold":
        if (here.kind === "range") return openRange(here);
        if (here.kind === "header" && folded.has(here.file)) return setFolds([here.file], false);
        return;
      case "fold":
        if (!diffs.has(here.file) || folded.has(here.file)) return;
        return setFolds([here.file], true, { ...here, kind: "header" });
      case "toggleFold":
        if (here.kind === "range") return openRange(here);
        if (!diffs.has(here.file)) return;
        if (folded.has(here.file)) return setFolds([here.file], false);
        return setFolds([here.file], true, { ...here, kind: "header" });
      case "viewed":
        return toggleViewed(here.file);
      default:
        return;
    }
  };

  // Review keys, from anywhere but text entry and the dialogs, which own their own keys. The
  // library's input filter also skips checkboxes and radios, where these keys must still work, so
  // every binding leaves the event alone and this guard decides. It reads the live DOM and `runRef`,
  // not render state: a dialog closes before React renders it closed, and the library syncs
  // callbacks after the render.
  const runRef = useRef(run);
  runRef.current = run;
  const reviewKey =
    (id: CommandId, step: Hotkey): HotkeyCallback =>
    (event) => {
      if (event.defaultPrevented || event.isComposing || !typed(step, event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("dialog") || isTextEntry(target)) return;
      if (document.querySelector("dialog[open]")) return;
      // A focused control keeps its own Enter and Space.
      if (
        (event.key === "Enter" || event.key === " ") &&
        target?.closest("button, a[href], input, select, summary")
      )
        return;
      event.preventDefault();
      runRef.current(id);
    };
  const bindingOptions = { ignoreInputs: false, preventDefault: false, stopPropagation: false };
  const commands = commandsFor(inputMode);
  const bindings = commands.flatMap((command) =>
    command.keys.map((keys) => ({ ...command, keys })),
  );
  useHotkeys(
    bindings
      .filter(({ keys }) => keys.length === 1)
      .map(({ id, keys }) => ({ hotkey: keys[0]!, callback: reviewKey(id, keys[0]!) })),
    bindingOptions,
  );
  // Disabled while a dialog is open, so keys typed in it can't start a sequence. `dialog` lags the
  // DOM by a render, so a sequence's first key just after a dialog closes may be lost.
  useHotkeySequences(
    bindings
      .filter(({ keys }) => keys.length > 1)
      .map(({ id, keys }) => ({ sequence: [...keys], callback: reviewKey(id, keys.at(-1)!) })),
    { ...bindingOptions, enabled: dialog === undefined },
  );

  /** Scrolling by hand pulls a cursor that left the panel back onto its first or last line. */
  const pullBack = () => {
    if (!vim || here === undefined || selecting) return;
    const mark = markOf(here);
    const where = mark ? viewer.current?.where(mark) : undefined;
    if (where === undefined || where === "inside") return;
    const seen = viewer.current?.visibleAt(where === "above" ? "top" : "bottom");
    // The line seen is on the renderer's side; split keeps the cursor's column, on the same row.
    if (seen && model.files.includes(seen.file))
      setCursor(layout === "split" ? switched(model, seen, here.side) : place(model, seen));
  };

  const labelOf = (command: Command) =>
    command.id === "mode" ? `Switch to ${vim ? "Mouse" : "Vim"} mode` : command.label;

  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const selected = lines && Math.abs(lines.range.end - lines.range.start) + 1;
  const cursorLabel =
    here === undefined
      ? ""
      : here.kind === "header"
        ? `${name(here.file)} · file`
        : here.kind === "range"
          ? `${name(here.file)} · hidden lines`
          : `${name(here.file)}:${here.line}${layout === "split" ? ` · ${here.side === "deletions" ? "old" : "new"}` : ""}`;

  return (
    <Frame
      fill
      top={
        <>
          <Crumb session={session} />
          <span {...stylex.props(styles.grow)} />
          <PillButton onClick={() => setDialog("menu")}>
            Commands <kbd {...stylex.props(styles.kbd)}>⌘K</kbd>
          </PillButton>
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
            failure={pageFailure}
            onPage={(after, page) => {
              setPageFailure(undefined);
              addPage(after, page);
            }}
          />
        </>
      }
      status={
        <>
          <Switch
            label="Input mode"
            name="input-mode"
            value={inputMode}
            options={[
              ["vim", "Vim"],
              ["mouse", "Mouse"],
            ]}
            onChange={(next) => {
              setLines(null);
              setInputMode(next);
            }}
          />
          {vim && <span {...stylex.props(styles.ink)}>{cursorLabel}</span>}
          {selected !== null && (
            <span {...stylex.props(styles.ink)}>
              {selected} {selected === 1 ? "line" : "lines"} selected
            </span>
          )}
          <Switch
            label="Diff layout"
            name="diff-layout"
            value={mode}
            options={[
              ["split", "Split"],
              ["stacked", "Stacked"],
              ["auto", `Auto (${layoutOf("auto", width)})`],
            ]}
            onChange={setMode}
          />
          <span>
            {viewedCount}/{hunkCount} {hunkCount === 1 ? "hunk" : "hunks"} viewed in {shown.length}{" "}
            {shown.length === 1 ? "file" : "files"}
          </span>
          <LiveStatus
            live={live.state}
            replaced={behind(live.state, progress.state) === "replaced"}
          />
          <span {...stylex.props(styles.grow)} />
          <button
            type="button"
            {...stylex.props(styles.keysButton)}
            onClick={() => setDialog("help")}
          >
            Keys <kbd {...stylex.props(styles.kbd)}>?</kbd>
          </button>
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
          ref={viewer}
          files={shown}
          diffs={diffs}
          layout={layout}
          inputMode={inputMode}
          folded={folded}
          opened={opened}
          mark={vim && here ? markOf(here) : undefined}
          lines={lines}
          loadDiffFiles={loadDiffFiles}
          onWindow={onWindow}
          onWidth={setWidth}
          onOpened={() => setOpenedVersion((version) => version + 1)}
          onLineClick={(target) => vim && setCursor(target)}
          onLines={(next) => {
            const single =
              next !== null &&
              next.range.start === next.range.end &&
              (next.range.endSide ?? next.range.side) === next.range.side;
            if (vim && next !== null) {
              const side = next.range.endSide ?? next.range.side ?? "additions";
              setCursor({ file: next.id, kind: "line", side, line: next.range.end });
            }
            setLines(vim && single ? null : next);
          }}
          onManualScroll={pullBack}
          renderHeader={(path) => {
            const file = byPath.get(path)!;
            const hunkIds = file.hunks.map((hunk) => hunk.id);
            const box = checkboxOf(progress.state, path, hunkIds);
            return (
              <FileHeader
                file={file}
                // A file a late files page found whole-side empty needs no captured contents, so a
                // read that failed after it was rebuilt no longer applies.
                load={wholeFileType(file.manifest) === undefined ? loads.get(path) : undefined}
                cursor={vim && here?.kind === "header" && here.file === path}
                folded={diffs.has(path) ? folded.has(path) : undefined}
                onFold={() => setFolds([path], !folded.has(path))}
                viewed={
                  hunkIds.length === 0
                    ? undefined
                    : {
                        ...box,
                        onToggle: () => toggleViewed(path),
                        onReload: () => void router.invalidate(),
                      }
                }
              />
            );
          }}
        />
      )}
      {dialog === "menu" && (
        <CommandMenu
          commands={commands}
          labelOf={labelOf}
          onRun={run}
          // Each dialog clears only itself: the menu's queued close can land after help opened.
          onClose={() => setDialog((open) => (open === "menu" ? undefined : open))}
        />
      )}
      {dialog === "help" && (
        <KeyHelp
          commands={commands}
          labelOf={labelOf}
          onClose={() => setDialog((open) => (open === "help" ? undefined : open))}
        />
      )}
    </Frame>
  );
}

const styles = stylex.create({
  muted: { color: theme.muted },
  ink: { color: theme.ink },
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
  kbd: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: "18px",
    height: "18px",
    padding: "0 4px",
    marginLeft: "4px",
    borderRadius: "4px",
    backgroundColor: theme.line,
    color: theme.ink,
    fontFamily: theme["--mono"],
    fontSize: "11px",
  },
  keysButton: { color: { default: theme.muted, ":hover": theme.ink } },
});

/**
 * Whether the reader follows the session's committed state, and what to do when it can't. Said in
 * the status line, so a change never shifts the diff being read.
 */
function LiveStatus({ live, replaced }: { live: LiveState; replaced: boolean }) {
  const router = useRouter();
  if (live.phase === "deleted")
    return (
      <span role="alert" {...stylex.props(liveStyles.alert)}>
        This session was deleted.
      </span>
    );
  if (live.phase === "refused")
    return (
      <span role="alert" {...stylex.props(liveStyles.alert)}>
        {live.failure instanceof Error ? live.failure.message : "gyst refused this browser."}
      </span>
    );
  return (
    <>
      <span {...stylex.props(live.phase === "live" && styles.ink)}>
        {live.phase === "live"
          ? "Live"
          : live.phase === "connecting"
            ? "Connecting…"
            : "Reconnecting…"}
      </span>
      {live.phase === "recovering" && (
        <span {...stylex.props(liveStyles.alert)}>
          Can't reach gyst; retrying. Viewed changes are paused.
        </span>
      )}
      {replaced && (
        <span role="alert" {...stylex.props(liveStyles.alert, liveStyles.reload)}>
          This session was refreshed.
          <PillButton onClick={() => void router.invalidate()}>Reload session</PillButton>
        </span>
      )}
    </>
  );
}

const liveStyles = stylex.create({
  alert: { color: theme.del },
  reload: { display: "flex", alignItems: "center", gap: "6px" },
});

// ─── continuous diff ─────────────────────────────────────────────────────

/** What the reader asks of the diff view: geometry and scrolling, by logical place. */
type Viewer = {
  /** Keeps a mark in view with a margin, or puts it at the top of the panel. */
  reveal(mark: Mark, how: "nearest" | "top"): void;
  /** How far below the panel's top a rendered mark sits. */
  offsetOf(mark: Mark): number | undefined;
  /** Scrolls so a mark sits `offset` below the panel's top. */
  placeAt(mark: Mark, offset: number): void;
  /** Whether a mark is above, inside or below the panel. */
  where(mark: Mark): "above" | "inside" | "below";
  /** The header or line at the panel's top or bottom edge. */
  visibleAt(end: "top" | "bottom"): Cursor | undefined;
  fileInView(): string | undefined;
  height(): number;
  scrollBy(pixels: number): void;
  scrollToEdge(end: "top" | "bottom"): void;
  /** Opens `count` hidden lines of a rendered file's range from both ends. */
  expand(file: string, range: number, count: number): void;
};

/** How far the cursor stays from the panel's edges, and how far in a pulled-back cursor lands. */
const scrolloff = 96;
const pullMargin = 40;
const lineHeight = 20;

const smooth = (): ScrollBehavior =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/**
 * The selected files' captured changes as one virtualized, continuous reading surface. Each file
 * reads as one diff over its captured full contents: hidden ranges show their counts and expand
 * independently, loading the captured sides on first expansion. The reading position is logical
 * (file, side, line), so layout switches and selection changes restore it instead of a pixel offset.
 */
function ContinuousDiff(props: {
  ref: Ref<Viewer>;
  files: readonly ReaderFile[];
  diffs: ReadonlyMap<string, FileDiffMetadata>;
  layout: "split" | "stacked";
  inputMode: InputMode;
  folded: ReadonlySet<string>;
  opened: Map<string, Map<number, Opened>>;
  mark: Mark | undefined;
  lines: CodeViewLineSelection | null;
  loadDiffFiles: FileDiffContentsLoader;
  /** The files the panel shows now, after each render and scroll. */
  onWindow: (visible: readonly string[]) => void;
  onWidth: (width: number) => void;
  onOpened: () => void;
  onLineClick: (cursor: Cursor) => void;
  onLines: (selection: CodeViewLineSelection | null) => void;
  onManualScroll: () => void;
  renderHeader: (path: string) => ReactNode;
}) {
  const { diffs, layout, onWidth } = props;
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition>(undefined);
  // While a restoration is in flight, and while the reader stays where it put them, the renderer's
  // own scrolls and re-renders must not replace the position being restored.
  const restoring = useRef(false);
  const restoredTop = useRef<number>(undefined);
  // The latest callbacks and mark, for the renderer's callbacks and our listeners.
  const latest = useRef(props);
  latest.current = props;

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

  /** Tells the reader which files the panel shows now, once per change of that list. */
  const lastWindow = useRef("");
  const reportWindow = useCallback(() => {
    const viewer = view.current?.getInstance();
    const node = root.current;
    if (viewer === undefined || node === null) return;
    const top = viewer.getScrollTop();
    const bottom = top + node.clientHeight;
    const visible = viewer.getRenderedItems().flatMap(({ id, instance }) => {
      const itemTop = viewer.getTopForItem(id);
      return itemTop !== undefined && itemTop < bottom && itemTop + instance.height > top
        ? [id]
        : [];
    });
    const key = visible.join("\n");
    if (key === lastWindow.current) return;
    lastWindow.current = key;
    latest.current.onWindow(visible);
  }, []);

  /** A mark's box in the panel's scroll coordinates, while its file is rendered. */
  const boxOf = useCallback((mark: Mark) => {
    const viewer = view.current?.getInstance();
    const node = root.current;
    const rendered = viewer?.getRenderedItems().find((item) => item.id === mark.file);
    // Rows come from the item's top; its element holds only the rendered window of rows, so it
    // gives the horizontal extent alone.
    const top = viewer?.getTopForItem(mark.file);
    if (node === null || rendered === undefined || top === undefined) return undefined;
    const outer = node.getBoundingClientRect();
    const rect = rendered.element.getBoundingClientRect();
    const left = rect.left - outer.left + node.scrollLeft;
    if (mark.line === undefined) return { top, height: headerHeight, left, width: rect.width };
    if (rendered.type !== "diff") return undefined;
    const at = rendered.instance.getLinePosition(mark.line, mark.side);
    if (at === undefined) return undefined;
    const half = rect.width / 2;
    return {
      top: top + at.top,
      height: at.height,
      left: mark.full || mark.side === "deletions" ? left : left + half,
      width: mark.full ? rect.width : half,
    };
  }, []);

  // ─── the Vim cursor bar ───
  const bar = useRef<HTMLDivElement>(null);
  const paint = useCallback(() => {
    const element = bar.current;
    if (element === null) return;
    const { mark } = latest.current;
    const box = mark?.line === undefined ? undefined : boxOf(mark);
    element.hidden = box === undefined;
    if (box === undefined) return;
    element.style.top = `${box.top}px`;
    element.style.left = `${box.left}px`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
  }, [boxOf]);

  // ─── scrolling ───
  // Where the reader's own smooth scroll is heading, so a held key retargets it rather than
  // measuring from a position the scroll is about to leave. Cleared when it lands or a hand scrolls.
  const pendingTop = useRef<number>(undefined);
  const manualAt = useRef(-Infinity);
  const scrollTop = (top: number) => {
    const node = root.current;
    if (node === null) return;
    const target = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
    // The reader's own scroll ends any hand scroll, so it never pulls the cursor back.
    manualAt.current = -Infinity;
    pendingTop.current = Math.abs(target - node.scrollTop) < 1 ? undefined : target;
    node.scrollTo({ top: target, behavior: smooth() });
  };

  useImperativeHandle(props.ref, (): Viewer => {
    const node = () => root.current!;
    const where = (mark: Mark) => {
      const box = boxOf(mark);
      const { scrollTop: top, clientHeight } = node();
      if (box === undefined) {
        const itemTop = view.current?.getInstance()?.getTopForItem(mark.file) ?? 0;
        return itemTop < top ? "above" : "below";
      }
      const reserved = mark.line === undefined ? 0 : headerHeight;
      if (box.top + box.height <= top + reserved) return "above";
      return box.top >= top + clientHeight ? "below" : "inside";
    };
    return {
      reveal(mark, how) {
        const box = boxOf(mark);
        if (box === undefined) {
          // Not rendered: the renderer finds it; its next render paints the cursor there.
          pendingTop.current = undefined;
          manualAt.current = -Infinity;
          view.current?.scrollTo(
            mark.line === undefined
              ? { type: "item", id: mark.file, align: "start", behavior: "smooth-auto" }
              : {
                  type: "line",
                  id: mark.file,
                  lineNumber: mark.line,
                  side: mark.side,
                  align: how === "top" ? "start" : "center",
                  behavior: "smooth-auto",
                },
          );
          return;
        }
        // A line sits below the sticky header of its file; a header is at its item's top.
        const reserved = mark.line === undefined ? 0 : headerHeight;
        const { scrollTop: top, clientHeight } = node();
        const base = pendingTop.current ?? top;
        if (how === "top") return scrollTop(box.top - reserved - (reserved ? 0 : 8));
        if (box.top < base + reserved + scrolloff) scrollTop(box.top - reserved - scrolloff);
        else if (box.top + box.height > base + clientHeight - scrolloff)
          scrollTop(box.top + box.height + scrolloff - clientHeight);
      },
      offsetOf(mark) {
        const box = boxOf(mark);
        return box && box.top - node().scrollTop;
      },
      placeAt(mark, offset) {
        const box = boxOf(mark);
        if (box === undefined) return this.reveal(mark, "nearest");
        scrollTop(box.top - offset);
      },
      where,
      visibleAt(end) {
        const viewer = view.current?.getInstance();
        if (viewer === undefined) return undefined;
        const { scrollTop: top, clientHeight } = node();
        const y =
          end === "top"
            ? top + headerHeight + pullMargin
            : top + clientHeight - pullMargin - lineHeight;
        for (const { id, type, instance } of viewer.getRenderedItems()) {
          const itemTop = viewer.getTopForItem(id);
          if (itemTop === undefined || y < itemTop || y >= itemTop + instance.height) continue;
          const anchor =
            type === "diff" && y >= itemTop + headerHeight
              ? instance.getNumericScrollAnchor(y - itemTop)
              : undefined;
          return anchor
            ? { file: id, kind: "line", side: anchor.side ?? "additions", line: anchor.lineNumber }
            : { file: id, kind: "header", side: "additions" };
        }
        return undefined;
      },
      fileInView: () => position.current?.file ?? props.files[0]?.path,
      height: () => node().clientHeight,
      scrollBy(pixels) {
        scrollTop((pendingTop.current ?? node().scrollTop) + pixels);
      },
      scrollToEdge(end) {
        scrollTop(end === "top" ? 0 : node().scrollHeight);
      },
      expand(file, range, count) {
        const rendered = view.current
          ?.getInstance()
          ?.getRenderedItems()
          .find((item) => item.id === file);
        if (rendered?.type === "diff") rendered.instance.expandHunk(range, "both", count);
      },
    };
  });

  /**
   * Keeps the hidden lines the reader opened and the renderer's own in step after a render: lines
   * the renderer opened (a click) are recorded, and lines it forgot (it dropped and rebuilt the
   * item) are opened again. Loaded sides only: a partial diff opens nothing yet.
   */
  const syncOpened = useCallback((file: string, instance: FileDiff) => {
    const diff = instance.fileDiff;
    if (diff === undefined || diff.isPartial) return;
    const { opened, onOpened } = latest.current;
    const byRange = opened.get(file) ?? new Map<number, Opened>();
    let changed = false;
    for (const range of hiddenRanges(diff)) {
      if (range.size <= 1) continue;
      const mine = byRange.get(range.index) ?? { fromStart: 0, fromEnd: 0 };
      const shows = (offset: number) => instance.isLineRenderable(range.new + offset);
      if (
        (mine.fromStart > 0 && !shows(mine.fromStart - 1)) ||
        (mine.fromEnd > 0 && !shows(range.size - mine.fromEnd))
      ) {
        if (mine.fromStart > 0) instance.expandHunk(range.index, "up", mine.fromStart);
        if (mine.fromEnd > 0) instance.expandHunk(range.index, "down", mine.fromEnd);
        continue;
      }
      let { fromStart, fromEnd } = mine;
      while (fromStart + fromEnd < range.size && shows(fromStart)) fromStart++;
      while (fromStart + fromEnd < range.size && shows(range.size - 1 - fromEnd)) fromEnd++;
      if (fromStart === mine.fromStart && fromEnd === mine.fromEnd) continue;
      byRange.set(range.index, { fromStart, fromEnd });
      changed = true;
    }
    if (!changed) return;
    opened.set(file, byRange);
    onOpened();
  }, []);

  // One item per file, reused while its fold and metadata are unchanged so the renderer keeps its
  // state. A replaced item carries a new version: the renderer reads an item again only then. Only
  // the shown files' items stay cached, so an unselected file's contents are not kept here.
  const itemCache = useRef(new Map<string, CodeViewItem<undefined>>());
  const itemVersion = useRef(0);
  const items = useMemo(() => {
    const cache = itemCache.current;
    itemCache.current = new Map();
    return props.files.map((file): CodeViewItem<undefined> => {
      const fileDiff = diffs.get(file.path);
      const collapsed = fileDiff === undefined || props.folded.has(file.path);
      const cached = cache.get(file.path);
      if (
        cached &&
        cached.collapsed === collapsed &&
        (cached.type !== "diff" || cached.fileDiff === fileDiff)
      ) {
        itemCache.current.set(file.path, cached);
        return cached;
      }
      const version = ++itemVersion.current;
      const item: CodeViewItem<undefined> = fileDiff
        ? { id: file.path, type: "diff", fileDiff, collapsed, version }
        : // No captured text to show: the header alone says why.
          {
            id: file.path,
            type: "file",
            file: { name: file.path, contents: "" },
            collapsed: true,
            version,
          };
      itemCache.current.set(file.path, item);
      return item;
    });
  }, [props.files, diffs, props.folded]);

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
      itemMetrics: { diffHeaderHeight: headerHeight, lineHeight },
      layout: { paddingTop: 24, paddingBottom: 120, gap: 10 },
      unsafeCSS: fileBoxCSS,
      // Dragging line numbers selects lines in both modes; Mouse mode adds the hover +.
      enableLineSelection: true,
      enableGutterUtility: props.inputMode === "mouse",
      onGutterUtilityClick: (range, context) =>
        latest.current.onLines({ id: context.item.id, range }),
      onLineClick: (line, context) => {
        if (!("annotationSide" in line)) return;
        latest.current.onLineClick({
          file: context.item.id,
          kind: "line",
          side: line.annotationSide,
          line: line.lineNumber,
        });
      },
      // The renderer notifies scrolls before it moves its window, and renders items synchronously
      // inside its frame; reading once the frame is done sees the window a jump landed in.
      onPostRender: (_node, instance, phase, context) => {
        if (phase !== "unmount" && instance instanceof FileDiff)
          syncOpened(context.item.id, instance);
        queueMicrotask(capture);
        queueMicrotask(paint);
        queueMicrotask(reportWindow);
      },
    }),
    [layout, props.loadDiffFiles, props.inputMode, capture, paint, syncOpened, reportWindow],
  );

  // The panel's content width decides auto layout; the viewport's never does. Scrolling by hand
  // (wheel, touch, the scrollbar or scrolling keys) is told apart from the reader's own scrolls.
  const observer = useRef<ResizeObserver>(undefined);
  const detach = useRef<() => void>(undefined);
  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = undefined;
      detach.current?.();
      detach.current = undefined;
      root.current = node;
      if (node === null) return;
      onWidth(node.clientWidth - horizontalPadding(node));
      observer.current = new ResizeObserver(([entry]) => {
        onWidth(entry!.contentRect.width);
        paint();
      });
      observer.current.observe(node);
      const manual = () => {
        manualAt.current = performance.now();
        pendingTop.current = undefined;
      };
      const onPointer = (event: PointerEvent) => event.target === node && manual();
      const onKey = (event: KeyboardEvent) =>
        ["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"].includes(event.key) &&
        manual();
      const settled = () => (pendingTop.current = undefined);
      node.addEventListener("wheel", manual, { passive: true });
      node.addEventListener("touchmove", manual, { passive: true });
      node.addEventListener("pointerdown", onPointer);
      node.addEventListener("scrollend", settled);
      window.addEventListener("keydown", onKey);
      detach.current = () => {
        node.removeEventListener("wheel", manual);
        node.removeEventListener("touchmove", manual);
        node.removeEventListener("pointerdown", onPointer);
        node.removeEventListener("scrollend", settled);
        window.removeEventListener("keydown", onKey);
      };
    },
    [onWidth, paint],
  );

  // Restore the logical position after a layout switch or a new selection that still holds it.
  // A layout effect: it reads the position before any capture from the renderer's own re-render.
  useLayoutEffect(() => {
    const at = position.current;
    pendingTop.current = undefined;
    manualAt.current = -Infinity;
    if (at === undefined || !props.files.some((file) => file.path === at.file)) {
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
    // Cancelled by the next restore or abandon, so an older frame cannot reinstate its marker.
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
      restoredTop.current = view.current?.getInstance()?.getScrollTop();
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, props.files]);
  useLayoutEffect(paint);

  return (
    <CodeView
      ref={view}
      {...stylex.props(diffStyles.view)}
      containerRef={containerRef}
      items={items}
      options={options}
      selectedLines={props.lines}
      onSelectedLinesChange={(selection) => latest.current.onLines(selection)}
      onScroll={() => {
        capture();
        paint();
        reportWindow();
        if (performance.now() - manualAt.current < 1000) latest.current.onManualScroll();
      }}
      renderCodeViewHeader={() => <CursorOverlay ref={bar} />}
      renderCustomHeader={(item) => props.renderHeader(item.id)}
    />
  );
}

/**
 * The Vim cursor's accent bar and tint over a code line or hidden range: an app-owned element
 * placed from the renderer's public geometry (rendered items, their element boxes and
 * `getLinePosition`), never from inside its shadow roots. @pierre/diffs 1.4.3 has no public
 * per-line decoration hook; replace this overlay with that hook once the renderer offers one.
 */
function CursorOverlay(props: { ref: Ref<HTMLDivElement> }) {
  return <div ref={props.ref} hidden data-cursor aria-hidden {...stylex.props(cursorStyles.bar)} />;
}

const cursorStyles = stylex.create({
  bar: {
    position: "absolute",
    zIndex: 1,
    pointerEvents: "none",
    backgroundColor: `color-mix(in srgb, ${theme["--accent"]} 14%, transparent)`,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
});
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
    // The cursor overlay is placed in the panel's scroll coordinates.
    position: "relative",
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

/** A file section's Viewed checkbox state, from `checkboxOf`, and what it can do. */
type ViewedBox = ReturnType<typeof checkboxOf> & { onToggle: () => void; onReload: () => void };

/**
 * The compact inset bar above each file's diff: its fold toggle, name, folder, notes and line
 * counts, and its Viewed checkbox when it has hunks. Pending, failed and conflicting writes are
 * said in words, not colour alone.
 */
function FileHeader(props: {
  file: ReaderFile;
  load: FileLoad | undefined;
  /** The Vim cursor is on this header. */
  cursor: boolean;
  /** Undefined for a file without a diff to fold. */
  folded: boolean | undefined;
  onFold: () => void;
  viewed: ViewedBox | undefined;
}) {
  const { file, load, viewed } = props;
  const failure = typeof load === "object" ? load.failure : undefined;
  const router = useRouter();
  const slash = file.path.lastIndexOf("/");
  const notes = fileNotes(file);
  const stats = file.hunks.length > 0 ? lineStats(file.hunks) : undefined;
  const stale = isDaemonError(failure, "stale_revision");
  const title = (
    <>
      <span {...stylex.props(headerStyles.name)}>{file.path.slice(slash + 1)}</span>
      {slash >= 0 && (
        <span {...stylex.props(headerStyles.dir)}>{file.path.slice(0, slash + 1)}</span>
      )}
    </>
  );
  return (
    <div
      {...stylex.props(headerStyles.bar, props.cursor && headerStyles.cursor)}
      data-cursor={props.cursor || undefined}
    >
      <h2 {...stylex.props(headerStyles.title)} aria-label={file.path}>
        {props.folded === undefined ? (
          title
        ) : (
          <button
            type="button"
            {...stylex.props(headerStyles.fold)}
            aria-expanded={!props.folded}
            aria-label={`${props.folded ? "Unfold" : "Fold"} ${file.path}`}
            onClick={props.onFold}
          >
            <span
              {...stylex.props(headerStyles.chevron, !props.folded && headerStyles.chevronOpen)}
            />
            {title}
          </button>
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
            <span {...stylex.props(headerStyles.failureText)}>
              Couldn't load the captured file
              {failure instanceof Error ? `: ${failure.message}` : ""}. Expand again to retry.
            </span>
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
      {viewed && <ViewedToggle path={file.path} box={viewed} />}
    </div>
  );
}

/** The header's Viewed checkbox and, beside it, its pending write, failure or conflict in words. */
function ViewedToggle({ path, box }: { path: string; box: ViewedBox }) {
  const failed = box.failure !== undefined;
  return (
    <>
      {box.pending && (
        <span role="status" {...stylex.props(headerStyles.note)}>
          {box.pending === "sending" ? "Saving…" : "Reading progress again…"}
        </span>
      )}
      {failed && (
        <span role="alert" {...stylex.props(headerStyles.failure)}>
          <span {...stylex.props(headerStyles.failureText)}>
            Couldn't save Viewed
            {box.failure instanceof Error ? `: ${box.failure.message.replace(/\.$/, "")}` : ""}.
          </span>
          <PillButton onClick={box.onToggle}>Retry</PillButton>
        </span>
      )}
      {box.notice?.kind === "conflict" && !box.pending && (
        <span role="status" {...stylex.props(headerStyles.note)}>
          Not saved: progress changed elsewhere and was read again.
        </span>
      )}
      {box.notice?.kind === "reload" && (
        <span role="alert" {...stylex.props(headerStyles.failure)}>
          <span {...stylex.props(headerStyles.failureText)}>Progress can't be read again.</span>
          <PillButton onClick={box.onReload}>Reload session</PillButton>
        </span>
      )}
      <label {...stylex.props(headerStyles.viewed, box.checked && headerStyles.viewedOn)}>
        <input
          type="checkbox"
          checked={box.checked}
          aria-label={`${path} viewed`}
          aria-busy={box.pending !== undefined || undefined}
          // A failed write keeps its intent; checking again retries it with the same request id.
          onChange={box.onToggle}
          {...stylex.props(headerStyles.check)}
        />
        Viewed
      </label>
    </>
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
  // The Vim cursor on a header: the same accent bar and tint as on a line.
  cursor: {
    backgroundImage: `linear-gradient(color-mix(in srgb, ${theme["--accent"]} 14%, transparent), color-mix(in srgb, ${theme["--accent"]} 14%, transparent))`,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
  fold: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
  },
  chevron: {
    alignSelf: "center",
    flexShrink: 0,
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
  viewed: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: 0,
    color: theme.muted,
    fontSize: "12px",
    cursor: "pointer",
  },
  viewedOn: { color: theme.add },
  check: { margin: 0, accentColor: theme.add },
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
  // Only the words shorten: the alert's button always stays whole and clickable.
  failure: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, color: theme.del },
  failureText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  stat: { fontFamily: theme["--mono"], fontSize: "11.5px", lineHeight: "normal" },
  add: { color: theme.add },
  del: { color: theme.del },
});

// ─── switches ────────────────────────────────────────────────────────────

/** A labelled radio group in the status line: the diff layout or the input mode. */
function Switch<Value extends string>(props: {
  label: string;
  name: string;
  value: Value;
  options: readonly (readonly [Value, string])[];
  onChange: (value: Value) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} {...stylex.props(switchStyles.group)}>
      {props.options.map(([value, text]) => (
        <label
          key={value}
          {...stylex.props(switchStyles.option, props.value === value && switchStyles.checked)}
        >
          <input
            type="radio"
            name={props.name}
            checked={props.value === value}
            onChange={() => props.onChange(value)}
            {...stylex.props(switchStyles.input)}
          />
          {text}
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
 * Retries the background load of the snapshot's next files page after it failed. A refresh that
 * replaced the snapshot makes the page cursor stale for good, so that failure offers a session
 * reload instead of a retry.
 */
function MoreFiles(props: {
  sessionId: string;
  snapshotId: string;
  pages: readonly FilesPayload[];
  failure: unknown;
  onPage: (after: string, page: FilesPayload) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [retryFailure, setFailure] = useState<unknown>();
  const failure = retryFailure ?? props.failure;
  const mounted = useMounted();
  const after = props.pages.at(-1)!.next;
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
      if (mounted.current) props.onPage(path, page);
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (failure === undefined) return null;
  return (
    <div {...stylex.props(moreStyles.box)}>
      <FailureNotice error={failure} />
      {isDaemonError(failure, "stale_revision") ? (
        <PillButton onClick={() => void router.invalidate()}>Reload session</PillButton>
      ) : (
        after !== null && (
          <PillButton disabled={pending} onClick={() => void more(after)}>
            {pending ? "Loading files…" : "Retry loading files"}
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
