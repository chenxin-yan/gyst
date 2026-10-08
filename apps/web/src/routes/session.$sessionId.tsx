import {
  type CapturedRange,
  type Draft,
  type FilesPayload,
  type Hunk,
  pullRequestUrlOf,
  type SessionSummary,
  type StatusPayload,
  type Thread,
} from "@gyst/core/wire";
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
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
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  events,
  isDaemonError,
  isExpectedFailure,
  isUncertain,
  newRequestId,
  operation,
  TransportError,
} from "../api.ts";
import { AuthorEntry, CommitsCard, DescriptionCard, useRangeCommits } from "../author.tsx";
import { CommandMenu, KeyHelp } from "../commands.tsx";
import {
  draftChange,
  draftPlace,
  forgetDraftText,
  liveNote,
  notesById,
  type ThreadPlace,
  threadPlaces,
} from "../conversation.ts";
import { Composer, CommentsList, ThreadCard, useConversations } from "../conversation.tsx";
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
  type CodeRead,
  linesOf,
  notCaptured,
  type RangeRead,
  readRange,
  referenceAvailability,
} from "../captured.ts";
import {
  capturedRows,
  change,
  type Cursor,
  edge,
  fileStep,
  hiddenRanges,
  lineOn,
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
import { CapturedHeader, useWholeSides } from "../expanded.tsx";
import { contentLoader, hydrationConcurrency, hydrationWindow, nearbyItems } from "../hydration.ts";
import {
  type Command,
  type CommandId,
  commandsFor,
  completesSequence,
  type InputMode,
  typed,
} from "../keymap.ts";
import {
  behind,
  initialLive,
  type LiveEvent,
  liveReducer,
  type LiveState,
  retryDelay,
  synchronizing,
} from "../live.ts";
import {
  type BackStack,
  type Peek,
  type PeekOrigin,
  type Place,
  popped,
  pushed,
  type ReadingPosition,
  type Restore,
  restoreFor,
  resumable,
} from "../navigation.ts";
import {
  type Extent,
  type PeekHandle,
  type PeekOverlay,
  PeekSpacer,
  ReferencePeek,
} from "../peek.tsx";
import {
  capturedFiles,
  changedFiles,
  PagingStopped,
  fileDiffOf,
  lateWholeFiles,
  type LayoutMode,
  layoutOf,
  lineStats,
  type ReaderFile,
  splitMinWidth,
  statusOf,
  type TreeNode,
  treeKey,
  treeOf,
  wholeFileType,
} from "../reader.ts";
import { type ReadingPlace, recall, remember } from "../reading-memory.ts";
import {
  diffText,
  type Hit,
  hitsOf,
  indexOf,
  type MatchAt,
  orderOf,
  readingOrder,
  type SearchPlace,
  type SearchResult,
  searchStep,
  wholeText,
} from "../search.ts";
import { SearchField, type SearchSource, useSearchScan } from "../search.tsx";
import type { CodeSide, SemanticAsk } from "../semantic.ts";
import { SemanticPeekView, semanticKey, useSemanticNavigation } from "../semantic.tsx";
import { StackSwitcher } from "../stack.tsx";
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
import {
  annotationsOf,
  type DiffAnnotation,
  type NoteFrom,
  noteSequence,
  noteStep,
  outdatedReason,
  type ReviewView,
  viewFiles,
  type ViewFiles,
} from "../walkthrough.ts";
import {
  EarlierNoteCard,
  ForeignHunkLabel,
  NoteCard,
  OverviewCard,
  WalkthroughNav,
} from "../walkthrough.tsx";

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

/**
 * What the cursor overlay marks: a line on one split column or across the diff, a hidden range
 * (by its first hidden line, across the diff), or with no line a file header.
 */
type Mark = { file: string; side: Side; line?: number; full?: boolean };

/** What of a status the reader draws as guidance, compared as one value. */
const guidanceOf = ({ overview, groups, preparation }: StatusPayload) =>
  JSON.stringify({ overview, groups, preparation });

const statusRead = (status: StatusPayload): StatusRead => ({
  snapshotId: status.session.snapshotId,
  revision: status.revision,
  viewedHunkIds: status.viewedHunkIds,
});

const replyLost = () =>
  new TransportError("unavailable", "The connection to gyst was lost before it answered.");

/**
 * The reader's live link: its rendered state, its state as of now (a loss or connection not yet
 * rendered included), and how a failed read of what it announced reports itself; true when that
 * ended the current connection.
 */
type LiveSession = {
  state: LiveState;
  now: () => LiveState;
  lost: (generation: number, error: unknown) => boolean;
};

/**
 * The reader's subscription to its session's committed state, for as long as it is mounted. A
 * lost stream connects again with backoff and resynchronizes from its `ready`, until the session
 * is deleted or gyst refuses this browser.
 */
function useLiveSession(sessionId: string): LiveSession {
  const [state, setState] = useState(initialLive);
  const latest = useRef(state);
  const restart = useRef<LiveSession["lost"]>(() => false);
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
      if (apply({ type: "lost", generation, error }) === before) return false;
      connection.abort();
      return true;
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
  return {
    state,
    now: () => latest.current,
    lost: (generation, error) => restart.current(generation, error),
  };
}

/**
 * Viewed progress, shared by every view of the snapshot: the reader's one copy of the Viewed hunk
 * ids and its writes. A write is refused while another is sent or status is read again, while
 * gyst can't be reached and until a reconnect has read what it missed: nothing is queued. The live
 * link keeps it current: progress committed elsewhere is read once more (one read at a time, for
 * the current connection only), and a write whose reply was lost is resent with its request id
 * once gyst answers again.
 */
function useViewedProgress(
  sessionId: string,
  snapshotId: string,
  status: StatusPayload,
  live: LiveSession,
) {
  const [state, setState] = useState(() => initialViewed(statusRead(status)));
  const latest = useRef<ViewedState>(state);
  // The newest status read for this snapshot: guidance an agent publishes while the reader is
  // open arrives with the read its announcement causes, not only with a session reload. Loader
  // and live reads are ordered by the newest revision accepted, which moves even when the
  // guidance object is kept, so a late answer never brings back older guidance. Only a change of
  // guidance replaces it: a read for Viewed alone keeps the views and the renderer's items, and
  // so the reading position, as they were.
  const [shown, setShown] = useState(status);
  // A PR session's stack context, kept apart so a change of it never rebuilds the guidance views.
  const [pullRequest, setPullRequest] = useState(status.pullRequest);
  const accepted = useRef(status.revision);
  const show = (next: StatusPayload) => {
    if (next.session.snapshotId !== snapshotId || next.revision < accepted.current) return false;
    accepted.current = next.revision;
    setShown((before) => (guidanceOf(next) === guidanceOf(before) ? before : next));
    setPullRequest((before) =>
      JSON.stringify(before) === JSON.stringify(next.pullRequest) ? before : next.pullRequest,
    );
    return true;
  };
  // The announced stack context the shown status was read at: the revision doesn't version it, and
  // the loader's read comes before any announcement, so until a live read it is unknown.
  const contextRead = useRef<string>(undefined);
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
  // A write on the wire answers for itself. The loader's read may be older than the live one
  // shown, so its stack context is unknown until read live again; Viewed may not change with it,
  // so that read is asked for here.
  const loaded = useRef(status);
  useEffect(() => {
    if (loaded.current === status) return;
    loaded.current = status;
    const taken = show(status);
    if (taken) contextRead.current = undefined;
    if (latest.current.busy === undefined) apply({ type: "status", status: statusRead(status) });
    if (taken) sync();
  });
  // The connection the write on the wire was sent over, and how many writes were sent: a status
  // read sent before the latest write says nothing of it.
  const sentOver = useRef(0);
  const sends = useRef(0);
  const send = (intent: ViewedIntent) => {
    sentOver.current = linked.current.now().generation;
    sends.current++;
    apply({ type: "send", intent });
    // Only the intent still on the wire is settled by its reply: one given up meanwhile was resent
    // or replaced, and a late answer must not overwrite what came after.
    const settle = (event: ViewedEvent) => {
      if (mounted.current && latest.current.intent === intent) apply(event);
    };
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
        settle({ type: "applied", result });
      } catch (error) {
        if (!isExpectedFailure(error)) console.error(error);
        settle({ type: "failed", error });
      }
    })();
  };
  const write = (file: string, hunkIds: readonly string[], viewed: boolean) => {
    const { state: now } = linked.current;
    const { phase } = now;
    if (phase === "recovering" || phase === "deleted" || phase === "refused") return false;
    if (synchronizing(now, latest.current)) return false;
    const intent = intentFor(latest.current, { file, hunkIds, viewed }, newRequestId);
    if (intent === undefined) return false;
    send(intent);
    return true;
  };
  // The status read on the wire, for the connection it was sent over: one a write's answer asks
  // for before any new write (`required`), or one of progress announced elsewhere. A read for a
  // connection since given up neither holds off the next connection's read nor applies.
  const reading = useRef<{ generation: number; required: boolean }>(undefined);
  // At most one automatic resend per announced version, so a reply lost again waits for Retry or
  // the next announcement rather than looping.
  const replayedAt = useRef<LiveState["known"]>(undefined);
  const read = (generation: number, required: boolean) => {
    const mine = { generation, required };
    reading.current = mine;
    const since = sends.current;
    const context = linked.current.now().known?.context;
    const current = () => mounted.current && linked.current.now().generation === generation;
    let recovering = false;
    void operation({ command: "status", session: sessionId })
      .then(
        // A write sent meanwhile answers for itself, even once its reply is lost, and a read sent
        // before a write's answer asked for one says nothing of that answer; either is checked
        // again once this read settles.
        (answer) => {
          const { busy } = latest.current;
          if (!current()) return;
          if (show(answer)) contextRead.current = context;
          if (
            sends.current === since &&
            (busy === undefined || (required && busy.kind === "rereading"))
          )
            apply({ type: "status", status: statusRead(answer) });
        },
        (error: unknown) => {
          if (!isExpectedFailure(error)) console.error(error);
          if (!current()) return;
          // A required read that fails blocks writes until a session reload; any other is not
          // this file's failure: the link recovers, then reads again from its `ready`.
          if (required) apply({ type: "unread", error });
          else recovering = linked.current.lost(generation, error);
        },
      )
      .finally(() => {
        if (reading.current !== mine) return;
        reading.current = undefined;
        // The loss isn't rendered yet, so checking again now would read over the given-up link.
        if (!recovering) sync();
      });
  };
  const sync = () => {
    let current = latest.current;
    const { state: now } = linked.current;
    const { generation, phase } = now;
    if (!mounted.current || reading.current?.generation === generation) return;
    // A write sent over a connection since lost may never be answered. The new connection gives
    // up on its reply and resends it with its request id, which tells whether it applied.
    if (current.busy?.kind === "sending" && phase === "live" && sentOver.current !== generation)
      current = apply({ type: "failed", error: replyLost() });
    // Required even before the first connection is live; a lost one reads again from its `ready`.
    if (current.busy?.kind === "rereading") {
      if (phase === "connecting" || phase === "live") read(generation, true);
      return;
    }
    if (current.busy || phase !== "live") return;
    const replay = replayOf(current);
    if (replay && replayedAt.current !== now.known) {
      replayedAt.current = now.known;
      return send(replay);
    }
    if (behind(now, { ...current, context: contextRead.current }) === "read")
      read(generation, false);
  };
  useEffect(sync, [live.state, state]);
  return { state, write, status: shown, pullRequest };
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

const noWholeFiles: ReadonlyMap<string, string> = new Map();

const generatedOf = (status: StatusPayload): ReadonlySet<string> =>
  new Set(status.files.flatMap(({ path, generated }) => (generated ? [path] : [])));

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
  // Where the reader left this session earlier in this page's life, as far as a refresh kept it.
  const [recalled] = useState(() =>
    recall(session.id, snapshotId, hunks, generatedOf(props.status)),
  );
  const [review, setReview] = useState<ReviewView>(recalled?.review ?? { kind: "files", path: "" });
  const [mode, setMode] = useState<LayoutMode>("auto");
  const [width, setWidth] = useState(0);
  const [loads, setLoads] = useState<ReadonlyMap<string, FileLoad>>(new Map());
  const [inputMode, setInputMode] = useState<InputMode>(recalled?.inputMode ?? "vim");
  const [cursor, setCursor] = useState<Cursor | undefined>(recalled?.cursor);
  const [lines, setLines] = useState<CodeViewLineSelection | null>(null);
  // Generated files start folded in every view; the fold state is shared, so they unfold as usual.
  // A return keeps the folds it left.
  const [folded, setFolded] = useState<ReadonlySet<string>>(
    () => recalled?.folded ?? generatedOf(props.status),
  );
  const [dialog, setDialog] = useState<"menu" | "help" | "comments">();
  // Hidden lines opened per file. They live here, not in the renderer, which forgets them with
  // an item it drops; bumping the version re-reads the cursor model after the renderer opened some.
  const [opened] = useState(() => recalled?.opened ?? new Map<string, Map<number, Opened>>());
  const [openedVersion, setOpenedVersion] = useState(0);
  const viewer = useRef<Viewer>(null);
  // The main panel's scroller while the view has no changes to show, so no viewer.
  const alone = useRef<HTMLDivElement>(null);
  const live = useLiveSession(session.id);
  const progress = useViewedProgress(session.id, snapshotId, props.status, live);
  const status = progress.status;
  // The change author's explanation above the diff: a PR's description or a range's commits.
  const [authorShown, setAuthorShown] = useState(recalled?.author.shown ?? false);
  const authorId = useId();
  const rangeCommits = useRangeCommits(
    session.id,
    snapshotId,
    authorShown && session.scope.kind === "range",
    recalled?.author.commits,
  );
  const conversations = useConversations(session.id, live.state.known?.revision);
  // One conversation is open at a time, and one composer, shown only once asked for.
  const [expandedThread, setExpandedThread] = useState<string>();
  const [activeDraft, setActiveDraft] = useState<string>();
  const mounted = useMounted();
  // Captured-code navigation: the reference expanded in the main panel, the open peek, the places
  // Back returns to, and the panel's restart key with where it starts. Never Viewed. A return from
  // another session starts them as they were left.
  const [captured, setCaptured] = useState<CapturedRange | undefined>(recalled?.captured);
  const [peek, setPeek] = useState<Peek | undefined>(() => resumable(recalled?.peek));
  const [back, setBack] = useState<BackStack>(recalled?.back ?? []);
  const [panel, setPanel] = useState<{ key: number; restore: Restore | undefined }>({
    key: 0,
    restore: undefined,
  });
  const [spacer, setSpacer] = useState<HTMLDivElement | null>(null);
  const peekHandle = useRef<PeekHandle>(null);
  // The control a peek was followed from, focused again when the peek closes. The renderer
  // remounts a note as its annotations change, and Back rebuilds an overview, so a reference no
  // longer on the page is found again by identity.
  const peekOpener = useRef<HTMLElement | null>(null);
  const [refocus, setRefocus] = useState<{ origin: PeekOrigin; target: CapturedRange }>();
  // An expanded file opens its hidden lines in its own map, so Back finds the origin's as it was.
  const expandedOpened = useRef(recalled?.expandedOpened ?? new Map<string, Map<number, Opened>>());
  const [notice, setNotice] = useState<string>();
  // Search over the current view: the query, kept while its highlight is cleared; whether the
  // highlight and the field show; the match last gone to or, while typing, the one Enter goes to;
  // a request to focus the field; and a step waiting for the scan of a new query or view.
  const [query, setQuery] = useState("");
  const [searchShown, setSearchShown] = useState(false);
  const [match, setMatch] = useState<{ file: string; hit: Hit; reached: boolean }>();
  const [searchFocus, setSearchFocus] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchPending = useRef<1 | -1>(undefined);
  const semantic = useSemanticNavigation({ sessionId: session.id, snapshotId, peek, setPeek });
  // Continue without navigation: a right-click shows the browser's own menu again; gd and gr,
  // asked explicitly, still ask.
  const [withoutNavigation, setWithoutNavigation] = useState(false);
  const readCode = useCallback<CodeRead>(
    (request) => operation({ ...request, session: session.id }),
    [session.id],
  );
  const wholeSides = useWholeSides(readCode);
  // A peek's lines, read once per target and kept for the session (#108).
  const rangeReads = useRef(new Map<string, Promise<RangeRead>>());

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
  const manifestByPath = useMemo(
    () => new Map(manifest.map((file) => [file.path, file])),
    [manifest],
  );
  const files = useMemo(() => changedFiles(hunks, manifest), [hunks, manifest]);
  // From status as well as pages: it is complete when the reader starts.
  const generated = useMemo(() => generatedOf(status), [status]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  // Memoized: a new list makes the renderer reconcile its items and restore the reading position.
  // An expanded reference shows its one file: every hunk of a changed one, with no Viewed section.
  // A reference into an earlier snapshot expands as that snapshot's file, read whole from it, never
  // as the current files' diff or entry at its path.
  const earlierPath =
    captured !== undefined && captured.snapshotId !== snapshotId ? captured.path : undefined;
  const currentPath = earlierPath === undefined ? captured?.path : undefined;
  const capturedFile = currentPath === undefined ? undefined : byPath.get(currentPath);
  const capturedEntry = currentPath === undefined ? undefined : manifestByPath.get(currentPath);
  const inView = useMemo(
    (): ViewFiles =>
      captured
        ? {
            files: [capturedFile ?? { path: captured.path, hunks: [], manifest: capturedEntry }],
            hunkIds: new Map(),
            group: undefined,
          }
        : viewFiles(review, files, status),
    [captured, capturedFile, capturedEntry, review, files, status],
  );
  const shown = inView.files;
  const shownPaths = useMemo(() => shown.map((file) => file.path), [shown]);
  const shownByPath = useMemo(() => new Map(shown.map((file) => [file.path, file])), [shown]);
  // Current notes explain current lines, which an earlier snapshot's file does not show.
  const notes = useMemo(
    () => (earlierPath === undefined ? noteSequence(inView, status) : []),
    [earlierPath, inView, status],
  );
  const noteAnnotations = useMemo(
    () => annotationsOf(inView, notes, status),
    [inView, notes, status],
  );
  // A peek under a note reserves its row after the note; one asked on a code line, under that line.
  const peekNote =
    peek?.kind === "reference" && peek.origin.kind === "note" ? peek.origin.noteId : undefined;
  const peekLine = peek?.kind === "semantic" ? peek.origin : undefined;
  const [lineFile, lineSide, lineNumber] = [peekLine?.file, peekLine?.side, peekLine?.line];
  const peekPlace = useMemo((): { file: string; side: Side; line: number } | undefined => {
    if (lineFile !== undefined && lineNumber !== undefined)
      return {
        file: lineFile,
        side: lineSide === "old" ? "deletions" : "additions",
        line: lineNumber,
      };
    return peekNote === undefined ? undefined : notes.find(({ note }) => note.id === peekNote);
  }, [lineFile, lineSide, lineNumber, peekNote, notes]);
  // Threads read where their code is shown: an expanded earlier file shows its own snapshot's.
  const codeSnapshot = captured?.snapshotId ?? snapshotId;
  const allNotes = useMemo(() => notesById(status), [status]);
  const threadsShown = useMemo(
    () => threadPlaces(conversations.threads, shownPaths, codeSnapshot, notes, allNotes),
    [conversations.threads, shownPaths, codeSnapshot, notes, allNotes],
  );
  const draftNow = conversations.drafts.find(({ id }) => id === activeDraft);
  const draftAt = draftNow && draftPlace(draftNow, shownPaths, codeSnapshot);
  // Rebuilt only when what sits where changes, so a reread keeps the renderer's items and the
  // composer being typed in.
  const conversationRows = JSON.stringify([
    threadsShown.flatMap(({ thread, note, file, side, line }) =>
      note === undefined ? [[thread.id, file, side, line]] : [],
    ),
    draftAt && [draftNow.id, draftAt.file, draftAt.side, draftAt.line],
  ]);
  const annotations = useMemo(() => {
    const rows = new Map(noteAnnotations);
    const add = (file: string, annotation: DiffLineAnnotation<DiffAnnotation>) =>
      rows.set(file, [...(rows.get(file) ?? []), annotation]);
    const [threadRows, draftRow] = JSON.parse(conversationRows) as [
      [string, string, "deletions" | "additions", number][],
      [string, string, "deletions" | "additions", number] | undefined,
    ];
    for (const [threadId, file, side, line] of threadRows)
      add(file, { side, lineNumber: line, metadata: { kind: "thread", threadId } });
    if (draftRow) {
      const [draftId, file, side, line] = draftRow;
      add(file, { side, lineNumber: line, metadata: { kind: "draft", draftId } });
    }
    if (peekPlace !== undefined)
      add(peekPlace.file, {
        side: peekPlace.side,
        lineNumber: peekPlace.line,
        metadata: { kind: "peek" },
      });
    return rows;
  }, [noteAnnotations, peekPlace, conversationRows]);
  const [collapsedNotes, setCollapsedNotes] = useState<ReadonlySet<string>>(new Set());
  // The note Mouse mode last scrolled to, which its scrolled-to place no longer names.
  const lastNote = useRef<number>(undefined);
  // The note `]n`/`[n` last put the Vim cursor on: notes can share a line, which the cursor can't.
  const cursorNote = useRef<string>(undefined);
  const layout = layoutOf(mode, width);

  // The metadata each file shows, and the one place its full contents are kept: its partial
  // shape, which the renderer hydrates in place when a range opens before the file loaded eagerly,
  // or an eagerly loaded clone. Kept once loaded: the renderer retains the rendered diffs of the
  // items it recycles, so dropping ours would not bound memory (#108).
  const [loadedDiffs, setDiffs] = useState<ReadonlyMap<string, FileDiffMetadata>>(
    () =>
      new Map(
        files.flatMap((file) => (file.hunks.length > 0 ? [[file.path, fileDiffOf(file)]] : [])),
      ),
  );
  // What the panel shows: an expanded earlier snapshot's file has no current diff.
  const diffs = useMemo(() => {
    if (earlierPath === undefined) return loadedDiffs;
    const shownDiffs = new Map(loadedDiffs);
    shownDiffs.delete(earlierPath);
    return shownDiffs;
  }, [loadedDiffs, earlierPath]);

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
    const late = lateWholeFiles(files, loadedDiffs);
    if (late.length === 0) return;
    for (const file of late) setLoad(file.path, undefined);
    setDiffs((before) => {
      const next = new Map(before);
      for (const file of late) next.set(file.path, fileDiffOf(file));
      return next;
    });
  }, [files, loadedDiffs, setLoad]);

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
  // This session's reading place, kept for a return from another session. The position at the top
  // changes by scrolling alone, without a render, so the panel reports it. Until a return has put
  // the recalled position back, the panel's own start is not the reader's place.
  const readingPlace = useRef<ReadingPlace>({
    review,
    captured,
    expandedOpened: expandedOpened.current,
    peek,
    back,
    inputMode,
    cursor,
    opened,
    folded,
    author: { shown: authorShown, commits: rangeCommits.read },
    top: recalled?.top,
  });
  readingPlace.current = {
    ...readingPlace.current,
    review,
    captured,
    expandedOpened: expandedOpened.current,
    peek,
    back,
    inputMode,
    cursor,
    folded,
    author: { shown: authorShown, commits: rangeCommits.read },
  };
  useEffect(() => remember(session.id, snapshotId, hunks, readingPlace.current));
  const returning = useRef(recalled !== undefined);
  const onPosition = useCallback(
    (top: Restore) => {
      if (returning.current) return;
      readingPlace.current = { ...readingPlace.current, top };
      remember(session.id, snapshotId, hunks, readingPlace.current);
    },
    [session.id, snapshotId, hunks],
  );

  const tree = useMemo(
    () => treeOf([...manifest.map((file) => file.path), ...files.map((file) => file.path)]),
    [manifest, files],
  );
  // A view's Viewed sections: a file's hunks in a files view, the group's own in a group view.
  const hunkIdsOf = (path: string) => inView.hunkIds.get(path) ?? [];
  const hunkCount = shown.reduce((count, file) => count + hunkIdsOf(file.path).length, 0);
  const viewedCount = shown.reduce(
    (count, file) =>
      count + hunkIdsOf(file.path).filter((id) => progress.state.viewed.has(id)).length,
    0,
  );

  // An expanded file without a diff reads as its whole captured side.
  const whole = captured && !diffs.has(captured.path) ? wholeSides.of(captured) : undefined;
  const loadWhole = wholeSides.load;
  // Read once; a failed read waits for the header's Retry.
  const wholeUnread = captured !== undefined && !diffs.has(captured.path) && whole === undefined;
  useEffect(() => {
    if (captured && wholeUnread) loadWhole(captured);
  }, [captured, wholeUnread, loadWhole]);
  const wholeFiles = useMemo(
    (): ReadonlyMap<string, string> =>
      captured && typeof whole === "object" && "text" in whole
        ? new Map([[captured.path, whole.text]])
        : noWholeFiles,
    [captured, whole],
  );
  const openedNow = captured ? expandedOpened.current : opened;

  /** A shown file's rows whatever its fold: its diff's, or a captured side shown whole. */
  const unfoldedRows = useCallback(
    (file: string): Row[] => {
      const diff = diffs.get(file);
      if (diff) return rowsOf(diff, openedNow.get(file) ?? new Map());
      const text = wholeFiles.get(file);
      return text === undefined || captured === undefined
        ? []
        : capturedRows(linesOf(text).length, captured.side === "old" ? "deletions" : "additions");
    },
    [diffs, openedNow, wholeFiles, captured],
  );

  // ─── the cursor's model: rows and stops of the shown files, read from logical state ───
  const model = useMemo((): Model => {
    const rows = (file: string) => (folded.has(file) ? [] : unfoldedRows(file));
    return {
      files: shownPaths,
      rows,
      stops: (file, side) => stopsOf(file, rows(file), layout, side),
    };
  }, [shownPaths, folded, layout, unfoldedRows]);
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

  // ─── search over the current view ───
  // A fold hides no match: search reads every shown file's rows unfolded. The opened lines change
  // in place, so their version is what tells the scan they changed.
  const searchSource = useCallback(
    (file: string): SearchSource | undefined => {
      const diff = diffs.get(file);
      const fileOpened = openedNow.get(file);
      if (diff)
        return {
          key: [diff, diff.isPartial, fileOpened && JSON.stringify([...fileOpened]), layout],
          hits: (test) => hitsOf(readingOrder(unfoldedRows(file), layout), diffText(diff), test),
        };
      const text = wholeFiles.get(file);
      if (text === undefined) return undefined;
      return {
        key: [text, captured?.side],
        hits: (test) => hitsOf(unfoldedRows(file), wholeText(linesOf(text)), test),
      };
    },
    [diffs, openedNow, openedVersion, wholeFiles, captured, layout, unfoldedRows],
  );
  const scan = useSearchScan(query, shownPaths, searchSource);
  const searchResult = scan.result;
  // The match gone to, found again in the latest result by its file and lines.
  const matchHere = ((): MatchAt | undefined => {
    if (match === undefined || searchResult === undefined) return undefined;
    const fileIndex = searchResult.files.indexOf(match.file);
    const hit = (searchResult.hits[fileIndex] ?? []).findIndex(
      (candidate) => candidate.old === match.hit.old && candidate.new === match.hit.new,
    );
    return hit < 0 ? undefined : { fileIndex, hit };
  })();
  /** Where a cursor stands among the view's matches. */
  const searchPlace = (target: Cursor): SearchPlace => ({
    fileIndex: shownPaths.indexOf(target.file),
    order: orderOf(readingOrder(unfoldedRows(target.file), layout), target),
  });
  /**
   * The next or previous match from where the reader is: the Vim cursor, or in Mouse mode the match
   * gone to, else the panel's top. A preview steps from the cursor or the top alone.
   */
  const searchFrom = (result: SearchResult, direction: 1 | -1, preview = false) => {
    const start = { fileIndex: 0, order: -1 };
    if (vim) return searchStep(result, here ? searchPlace(here) : start, direction);
    if (matchHere && !preview) {
      const order = result.hits[matchHere.fileIndex]![matchHere.hit]!.order;
      // A match previewed while typing is gone to first.
      const inclusive = direction === 1 && match?.reached === false;
      return searchStep(result, { fileIndex: matchHere.fileIndex, order }, direction, inclusive);
    }
    const top = viewer.current?.visibleAt("top");
    return searchStep(result, top ? searchPlace(top) : start, direction, direction === 1);
  };

  // A return to this session puts the position it showed back at the top (an overview's offset, or
  // a reading position), or else its cursor. Once the panel has a width: until then the layout may
  // still switch, which resets the panel to its top. A line in hidden lines the reader had opened
  // waits until its file loaded and the renderer opened them again, its file brought into view
  // meanwhile so it loads. Moving the cursor or scrolling by hand first leaves the reader where
  // they went.
  const fileRevealed = useRef(false);
  useEffect(() => {
    if (!returning.current || width === 0 || recalled === undefined) return;
    const view = viewer.current;
    if (!view) return;
    if (cursor !== recalled.cursor) return void (returning.current = false);
    const restore = recalled.top;
    if (restore !== undefined && "scrollTop" in restore) {
      returning.current = false;
      // After the renderer's first frames, which lay out the panel it starts at its top.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => viewer.current?.scrollTo(restore.scrollTop)),
      );
      return;
    }
    const top = restore?.position;
    if (top === undefined || !model.files.includes(top.file)) {
      returning.current = false;
      const mark = recalled.cursor && here ? markOf(here) : undefined;
      if (mark) view.reveal(mark, "top");
      return;
    }
    const side = top.side ?? "additions";
    const diff = diffs.get(top.file);
    // Until the renderer opened the file's hidden lines again, the line may be hidden, or sit
    // lower once lines above it open.
    const reopened = [...(openedNow.get(top.file) ?? [])].every(([index, open]) => {
      if (diff === undefined || diff.isPartial) return false;
      const range = hiddenRanges(diff).find((candidate) => candidate.index === index);
      return (
        range === undefined ||
        ((open.fromStart === 0 || view.renders(top.file, range.new)) &&
          (open.fromEnd === 0 || view.renders(top.file, range.new + range.size - 1)))
      );
    });
    const ready =
      reopened &&
      (top.line === undefined ||
        model.rows(top.file).some((row) => row.kind === "line" && lineOn(row, side) === top.line));
    if (ready) {
      returning.current = false;
      const mark = { file: top.file, side, ...(top.line !== undefined && { line: top.line }) };
      // After the renderer's next frame, which lays out the lines it has just opened again.
      requestAnimationFrame(() => requestAnimationFrame(() => viewer.current?.reveal(mark, "top")));
    } else if (!fileRevealed.current) {
      fileRevealed.current = true;
      view.reveal({ file: top.file, side }, "top");
    }
  });

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
    const byRange = openedNow.get(target.file) ?? new Map<number, Opened>();
    byRange.set(range.index, { fromStart: range.size, fromEnd: 0 });
    openedNow.set(target.file, byRange);
    setOpenedVersion((version) => version + 1);
    const offset = row.line - range.new;
    const side = layout === "split" ? target.side : "additions";
    go({
      file: target.file,
      kind: "line",
      side,
      line: (side === "deletions" ? range.old : range.new) + offset,
    });
  };

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

  /** Where a cursor stands, to step from to a note: header lines count as before the file's code. */
  const noteFrom = (target: Cursor): NoteFrom => ({
    fileIndex: model.files.indexOf(target.file),
    side: target.side,
    line: markOf(target)?.line ?? 0,
  });

  /** The note the Vim cursor stands on: the one `]n`/`[n` went to, else the first on its line. */
  const noteAt = (target: Cursor | undefined) => {
    if (target?.kind !== "line") return undefined;
    const from = noteFrom(target);
    const onLine = notes.filter(
      (at) => at.fileIndex === from.fileIndex && at.side === from.side && at.line === from.line,
    );
    return onLine.find((at) => at.note.id === cursorNote.current) ?? onLine[0];
  };

  const setNoteCollapsed = (id: string, collapse: boolean) =>
    setCollapsedNotes((before) => {
      const after = new Set(before);
      if (collapse) after.add(id);
      else after.delete(id);
      return after;
    });

  /** Goes to the next or previous note: the Vim cursor moves to its line, Mouse mode scrolls to it. */
  const stepNote = (direction: 1 | -1) => {
    if (vim) {
      if (here === undefined || selecting) return;
      const on = noteAt(here);
      const index = noteStep(notes, noteFrom(here), direction, on && notes.indexOf(on));
      const at = index === undefined ? undefined : notes[index]!;
      if (at === undefined) return;
      cursorNote.current = at.note.id;
      if (folded.has(at.file)) setFolds([at.file], false);
      return go({ file: at.file, kind: "line", side: at.side, line: at.line });
    }
    const top = viewer.current?.visibleAt("top");
    const index = noteStep(notes, top && noteFrom(top), direction, lastNote.current);
    const at = index === undefined ? undefined : notes[index]!;
    if (at === undefined) return;
    lastNote.current = index;
    if (folded.has(at.file)) setFolds([at.file], false);
    viewer.current?.reveal(
      { file: at.file, side: at.side, line: at.line, full: layout !== "split" },
      "top",
    );
  };

  /** Shows the author's explanation at the top of the main panel, or hides it. */
  const toggleAuthor = () => {
    const showing = !authorShown;
    flushSync(() => setAuthorShown(showing));
    if (!showing) return;
    viewer.current?.scrollToEdge("top");
    alone.current?.scrollTo({ top: 0 });
  };

  /** Goes to a match: the Vim cursor lands on it, Mouse mode scrolls to it; its file unfolds. */
  const goToMatch = (result: SearchResult, at: MatchAt) => {
    const file = result.files[at.fileIndex]!;
    const hit = result.hits[at.fileIndex]![at.hit]!;
    const { old, new: added } = hit;
    setMatch({ file, hit, reached: true });
    // A line on both sides keeps a split cursor's column.
    const side: Side =
      added === undefined || (old !== undefined && layout === "split" && here?.side === "deletions")
        ? "deletions"
        : "additions";
    const line = side === "deletions" ? old! : added!;
    if (folded.has(file)) setFolds([file], false);
    if (vim) return go({ file, kind: "line", side, line });
    viewer.current?.reveal(
      { file, side, line, full: layout !== "split" || (old !== undefined && added !== undefined) },
      "nearest",
    );
  };

  /**
   * Goes to the next or previous match and shows the highlight again. A step taken before the scan
   * of a new query or view has finished waits for it. Selecting lines keeps the cursor in place.
   */
  const stepSearch = (direction: 1 | -1) => {
    if (query === "") return;
    setSearchShown(true);
    if (selecting) return;
    if (!scan.current || searchResult === undefined) {
      searchPending.current = direction;
      return;
    }
    const at = searchFrom(searchResult, direction);
    if (at) goToMatch(searchResult, at);
  };
  useEffect(() => {
    const direction = searchPending.current;
    if (direction === undefined || !scan.current) return;
    searchPending.current = undefined;
    stepSearch(direction);
  });
  // While typing, the match Enter goes to is the current one, unvisited: once per result, from
  // where the reader is then.
  useEffect(() => {
    if (!scan.current || searchResult === undefined) return;
    if (document.activeElement === null || document.activeElement !== searchInput.current) return;
    const at = searchFrom(searchResult, 1, true);
    const hit = at && searchResult.hits[at.fileIndex]![at.hit]!;
    setMatch(hit && { file: searchResult.files[at.fileIndex]!, hit, reached: false });
  }, [searchResult]);

  /** Enter in the field: the query typed so far, then the next or previous match. */
  const enterSearch = (text: string, direction: 1 | -1) => {
    searchInput.current?.blur();
    if (text !== query) {
      setQuery(text);
      searchPending.current = direction;
      return;
    }
    stepSearch(direction);
  };
  /**
   * Clears the highlight; the query stays for n and N. A step still waiting for the scan is dropped,
   * or it would show the highlight again and move once the scan ends.
   */
  const closeSearch = () => {
    if (document.activeElement === searchInput.current) searchInput.current?.blur();
    searchPending.current = undefined;
    setSearchShown(false);
  };
  // `/` focuses the field once it shows, after a dialog it was run from gave focus back.
  useEffect(() => {
    if (searchFocus === 0) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [searchFocus]);
  const searchStatus =
    query === ""
      ? ""
      : scan.searching || searchResult === undefined
        ? "Searching…"
        : searchResult.total === 0
          ? "No matches"
          : `${matchHere ? indexOf(searchResult, matchHere) + 1 : "–"}/${searchResult.total}`;

  // ─── captured-code navigation ───
  /** A view the reader picks: it leaves any expanded reference, and Back starts over. */
  const chooseView = (view: ReviewView) => {
    setReview(view);
    setPeek(undefined);
    setBack([]);
    if (captured === undefined) return;
    if (back[0]) setFolded(back[0].folded);
    setCaptured(undefined);
    setPanel(({ key }) => ({ key: key + 1, restore: undefined }));
  };

  /** Opens a reference's peek where it was followed, in place of any other. */
  const follow = (target: CapturedRange, origin: PeekOrigin) => {
    peekOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRefocus(undefined);
    setPeek({ kind: "reference", target, origin });
  };

  /** Closes the peek and gives focus back to the reference it was followed from. */
  const closePeek = () => {
    if (peek === undefined) return;
    const opener = peekOpener.current;
    peekOpener.current = null;
    flushSync(() => setPeek(undefined));
    // A semantic peek leaves focus with the page, whose keys go on from its code line.
    if (peek.kind === "semantic") return;
    if (peek.origin.kind === "overview" && opener?.isConnected)
      opener.focus({ preventScroll: true });
    else setRefocus({ origin: peek.origin, target: peek.target });
  };

  /** Shows a peek's target in the main panel; Back returns to this place and this peek. */
  const expand = (target: CapturedRange) => {
    const at = viewer.current?.position() ?? { position: undefined, scrollTop: 0 };
    const origin: Place = {
      review,
      captured,
      cursor: current,
      lines,
      folded,
      restore: restoreFor(peek, at),
      peek,
    };
    setBack((stack) => pushed(stack, origin));
    expandedOpened.current = new Map();
    setFolded(new Set());
    setCaptured(target);
    setPeek(undefined);
    setLines(null);
    setCursor({
      file: target.path,
      kind: "line",
      side: target.side === "old" ? "deletions" : "additions",
      line: target.startLine,
    });
    setPanel(({ key }) => ({ key: key + 1, restore: undefined }));
  };

  /** Returns to the place the last Expand left: its view, position, cursor, selection and peek. */
  const goBack = () => {
    const step = popped(back);
    if (step === undefined) return;
    const to = step.place;
    setBack(step.stack);
    expandedOpened.current = new Map();
    setReview(to.review);
    setCaptured(to.captured);
    setCursor(to.cursor);
    setLines(to.lines);
    setFolded(to.folded);
    setPeek(to.peek);
    setPanel(({ key }) => ({ key: key + 1, restore: to.restore }));
  };

  // An expanded target scrolls into view once its file's lines are there to show; a place Back
  // returns to restores its own position instead.
  const revealed = useRef(0);
  useEffect(() => {
    if (captured === undefined || panel.restore !== undefined || revealed.current === panel.key)
      return;
    const diff = diffs.get(captured.path);
    if (diff ? diff.isPartial : !wholeFiles.has(captured.path)) return;
    revealed.current = panel.key;
    viewer.current?.reveal(
      {
        file: captured.path,
        side: captured.side === "old" ? "deletions" : "additions",
        line: Math.max(1, captured.startLine - 3),
        full: true,
      },
      "top",
    );
  });

  const peekAvailability =
    peek?.kind === "reference" &&
    referenceAvailability(peek.target, {
      snapshotId,
      file: manifestByPath.get(peek.target.path),
      complete: pages.at(-1)!.next === null,
    });
  /** A target's lines with their context, read once and kept for the session (#108). */
  const readOnce = useCallback(
    (target: CapturedRange) => {
      const key = JSON.stringify(target);
      let read = rangeReads.current.get(key);
      if (read === undefined) {
        read = readRange(target, readCode);
        // A failed read is read again when asked again.
        read.catch(() => rangeReads.current.delete(key));
        rangeReads.current.set(key, read);
      }
      return read;
    },
    [readCode],
  );
  const peekRead = useMemo(
    () => (peek?.kind === "reference" ? () => readOnce(peek.target) : undefined),
    [peek, readOnce],
  );
  /** Asks for a code line's symbols, for one query or (a right-click) at one character of it. */
  const lookUp = (at: { file: string; side: Side; line: number }, ask: SemanticAsk) => {
    // A file shown whole has one column, on the expanded reference's side.
    const side: CodeSide =
      captured && !diffs.has(at.file) ? captured.side : at.side === "deletions" ? "old" : "new";
    semantic.ask(
      {
        kind: "line",
        snapshotId: captured?.snapshotId ?? snapshotId,
        side,
        file: at.file,
        line: at.line,
      },
      ask,
    );
  };
  const continueWithoutNavigation = () => {
    closePeek();
    setWithoutNavigation(true);
    setNotice("Continuing without navigation; gd and gr still ask when pressed.");
  };
  const peekOf = (overlay?: PeekOverlay) =>
    peek?.kind === "semantic" ? (
      <SemanticPeekView
        // Keyed: another ask or answer is another peek, focused anew; a selection is not.
        key={semanticKey(peek)}
        peek={peek}
        snapshotId={snapshotId}
        read={readOnce}
        narrow={width < splitMinWidth}
        onSelect={semantic.select}
        onChoose={semantic.choose}
        onExpand={expand}
        onClose={closePeek}
        onCheckAgain={semantic.checkAgain}
        onRetry={semantic.retry}
        onContinue={continueWithoutNavigation}
        overlay={overlay}
        handle={overlay && peekHandle}
      />
    ) : (
      peek &&
      peekAvailability &&
      peekRead && (
        <ReferencePeek
          // Keyed: another target is another peek, focused anew.
          key={JSON.stringify(peek)}
          peek={peek}
          availability={peekAvailability}
          read={peekRead}
          narrow={width < splitMinWidth}
          snapshotId={snapshotId}
          onExpand={() => expand(peek.target)}
          onClose={closePeek}
          {...(overlay && { overlay, handle: peekHandle })}
        />
      )
    );

  // The view's overview: a group's, with its notes on earlier code, or the walkthrough's above the
  // whole snapshot.
  const earlierNotes =
    inView.group?.notes.filter(({ anchor }) => anchor.snapshotId !== snapshotId) ?? [];
  const overviewHeader = inView.group ? (
    <OverviewCard
      label="Group overview"
      title={inView.group.title}
      overview={inView.group.overview}
      outdated={outdatedReason(inView.group.overview?.outdated, inView.group.hunkIds.length === 0)}
      onReference={(target) => follow(target, { kind: "overview" })}
      earlierNotes={
        earlierNotes.length > 0 && (
          <section aria-label="Notes on earlier code" {...stylex.props(styles.earlierNotes)}>
            {earlierNotes.map((note) => (
              <EarlierNoteCard
                key={note.id}
                note={note}
                read={() => readOnce(note.anchor)}
                onReference={(target) => follow(target, { kind: "overview" })}
              />
            ))}
          </section>
        )
      }
      peek={peek?.origin.kind === "overview" && peekOf()}
      refocus={refocus?.origin.kind === "overview" ? refocus.target : undefined}
    />
  ) : (
    review.kind === "files" &&
    review.path === "" &&
    status.overview && (
      <OverviewCard
        label="Walkthrough overview"
        overview={status.overview}
        outdated={outdatedReason(status.overview.outdated)}
        onReference={(target) => follow(target, { kind: "overview" })}
        peek={peek?.origin.kind === "overview" && peekOf()}
        refocus={refocus?.origin.kind === "overview" ? refocus.target : undefined}
      />
    )
  );

  // A refresh whose reply did not arrive is sent again under its own id, so a lost acknowledgement
  // gets the recorded result instead of refreshing twice; any reply settles it.
  const pendingRefresh = useRef<{ snapshotId: string; requestId: string }>(undefined);
  const refreshing = useRef(false);
  const refresh = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const request =
      pendingRefresh.current?.snapshotId === snapshotId
        ? pendingRefresh.current
        : { snapshotId, requestId: newRequestId() };
    pendingRefresh.current = request;
    setNotice("Refreshing from the source…");
    try {
      const result = await operation({ command: "refresh", session: session.id, ...request });
      pendingRefresh.current = undefined;
      if (!mounted.current) return;
      if (!result.replaced) return setNotice("Nothing changed since this snapshot.");
      setNotice(undefined);
      // The reader starts again on the new snapshot, where what it was reading survives.
      void router.invalidate();
    } catch (error) {
      const uncertain = isUncertain(error);
      if (!uncertain) pendingRefresh.current = undefined;
      if (!isExpectedFailure(error)) console.error(error);
      if (!mounted.current) return;
      setNotice(
        isDaemonError(error, "stale_revision")
          ? "This session was already refreshed; reload it to read the new snapshot."
          : uncertain
            ? "The refresh may not have finished. Press R to try again; it won't refresh twice."
            : `Couldn't refresh; nothing changed.${error instanceof Error && error.message ? ` ${error.message}` : ""}`,
      );
    } finally {
      refreshing.current = false;
    }
  };

  /** Says whether the source changed since this snapshot; it never refreshes or changes progress. */
  const checkSource = async () => {
    setNotice("Checking the source…");
    try {
      const result = await operation({ command: "check", session: session.id });
      if (!mounted.current) return;
      setNotice(
        result.snapshotId !== snapshotId
          ? "This session was already refreshed; reload it to read the new snapshot."
          : result.state === "unchanged"
            ? "The source matches this snapshot."
            : result.state === "changed"
              ? "The source changed since this snapshot; press R to refresh."
              : `Can't tell whether the source changed${result.message ? `: ${result.message}` : ""}.`,
      );
    } catch (error) {
      if (mounted.current)
        setNotice(
          `Couldn't check the source${error instanceof Error && error.message ? `: ${error.message}` : ""}.`,
        );
    }
  };

  // ─── conversations ───
  /**
   * The thread a command acts on: in Vim mode one at the cursor's line, the open one first; in
   * Mouse mode, which has no cursor, the open one.
   */
  const threadAt = (target: Cursor | undefined): ThreadPlace | undefined => {
    if (!vim) return threadsShown.find(({ thread }) => thread.id === expandedThread);
    if (target?.kind !== "line") return undefined;
    const from = noteFrom(target);
    const onLine = threadsShown.filter(
      (at) => at.fileIndex === from.fileIndex && at.side === from.side && at.line === from.line,
    );
    return onLine.find(({ thread }) => thread.id === expandedThread) ?? onLine[0];
  };
  const conversationOf = (id: string) => conversations.threads.find((thread) => thread.id === id);
  const sayFailure = (what: string, error: unknown) => {
    if (!isExpectedFailure(error)) console.error(error);
    setNotice(
      `Couldn't ${what}${error instanceof Error && error.message ? `: ${error.message}` : "."}`,
    );
  };
  /** Pins what a message is composed against, then opens its composer; a lost link pins nothing. */
  const startDraft = async (
    target:
      | { kind: "comment"; anchor: CapturedRange }
      | { kind: "thread"; thread: string }
      | { kind: "note"; note: string },
    wording: string | undefined,
  ) => {
    if (live.state.phase !== "live")
      return setNotice("Can't reach gyst, so nothing can be written now; your drafts are kept.");
    try {
      const { draft } = await conversations.act({
        command: "draft",
        requestId: newRequestId(),
        target,
        ...(wording !== undefined && { wording }),
      });
      if (!mounted.current) return;
      setLines(null);
      setActiveDraft(draft);
      setExpandedThread(target.kind === "thread" ? target.thread : undefined);
    } catch (error) {
      if (mounted.current) sayFailure("start writing", error);
    }
  };
  /** A comment on the selected lines, or the Vim cursor's line: one side of one shown file. */
  const comment = () => {
    const picked =
      lines ??
      (vim && here?.kind === "line"
        ? { id: here.file, range: { start: here.line, side: here.side, end: here.line } }
        : undefined);
    if (picked === undefined)
      return setNotice("Select lines, or put the cursor on a line, to comment on them.");
    const { range } = picked;
    const shownWhole = captured !== undefined && !diffs.has(picked.id);
    if (!shownWhole && range.endSide !== undefined && range.endSide !== range.side)
      return setNotice("A comment covers lines of one side; select them on one side.");
    const side = shownWhole ? captured.side : range.side === "deletions" ? "old" : "new";
    const existing = conversations.drafts.find(
      ({ anchor, thread, note }) =>
        thread === undefined &&
        note === undefined &&
        anchor.path === picked.id &&
        anchor.side === side &&
        anchor.startLine === Math.min(range.start, range.end) &&
        anchor.endLine === Math.max(range.start, range.end),
    );
    if (existing) return setActiveDraft(existing.id);
    void startDraft(
      {
        kind: "comment",
        anchor: {
          snapshotId: shownWhole ? captured.snapshotId : snapshotId,
          path: picked.id,
          side,
          startLine: Math.min(range.start, range.end),
          endLine: Math.max(range.start, range.end),
        },
      },
      undefined,
    );
  };
  /** A reply in a thread, or to a note, which starts its only thread; a kept draft is resumed. */
  const replyTo = (target: { thread: string } | { note: string }) => {
    const thread =
      "thread" in target
        ? conversationOf(target.thread)
        : conversations.threads.find(
            (candidate) => liveNote(candidate, allNotes)?.id === target.note,
          );
    if (thread?.resolved) return setNotice("This thread is resolved; reopen it (x) to reply.");
    const noteId = thread
      ? liveNote(thread, allNotes)?.id
      : "note" in target
        ? target.note
        : undefined;
    const kept = conversations.drafts.find((draft) =>
      thread
        ? draft.thread === thread.id
        : draft.thread === undefined &&
          draft.note !== undefined &&
          draft.note.id === noteId &&
          !draft.note.removed,
    );
    if (kept) {
      setActiveDraft(kept.id);
      return setExpandedThread(thread?.id);
    }
    const wording = noteId === undefined ? undefined : allNotes.get(noteId)?.markdown;
    void startDraft(
      thread ? { kind: "thread", thread: thread.id } : { kind: "note", note: noteId! },
      wording,
    );
  };
  const reply = () => {
    const at = threadAt(here);
    if (at) return replyTo({ thread: at.thread.id });
    const note = vim ? noteAt(here) : undefined;
    if (note) return replyTo({ note: note.note.id });
    setNotice("Put the cursor on a note or a thread to reply.");
  };
  /** Resolves an open thread or reopens a resolved one; only the human does either. */
  const setResolved = async (threadId: string, resolved: boolean) => {
    try {
      await conversations.act({
        command: "resolve",
        requestId: newRequestId(),
        thread: threadId,
        resolved,
      });
      if (!mounted.current) return;
      if (resolved && activeDraft !== undefined) setActiveDraft(undefined);
      setNotice(resolved ? "Thread resolved; it stays in Comments (C)." : "Thread reopened.");
    } catch (error) {
      if (mounted.current) sayFailure(resolved ? "resolve the thread" : "reopen the thread", error);
    }
  };
  // The thread `]t`/`[t` last went to in Mouse mode, which its scrolled-to place no longer names.
  const lastThread = useRef<number>(undefined);
  /** Goes to the next or previous open thread shown, as `]n` goes to notes. */
  const stepThread = (direction: 1 | -1) => {
    if (vim) {
      if (here === undefined || selecting) return;
      const on = threadAt(here);
      const index = noteStep(
        threadsShown,
        noteFrom(here),
        direction,
        on && threadsShown.indexOf(on),
      );
      const at = index === undefined ? undefined : threadsShown[index]!;
      if (at === undefined) return;
      if (folded.has(at.file)) setFolds([at.file], false);
      if (at.note !== undefined) cursorNote.current = at.note;
      return go({ file: at.file, kind: "line", side: at.side, line: at.line });
    }
    const top = viewer.current?.visibleAt("top");
    const index = noteStep(threadsShown, top && noteFrom(top), direction, lastThread.current);
    const at = index === undefined ? undefined : threadsShown[index]!;
    if (at === undefined) return;
    lastThread.current = index;
    if (folded.has(at.file)) setFolds([at.file], false);
    viewer.current?.reveal(
      { file: at.file, side: at.side, line: at.line, full: layout !== "split" },
      "top",
    );
  };
  /** A thread where it is read, in the panel or in Comments, with its reply composer if open here. */
  const threadCard = (thread: Thread, located: boolean, composer: boolean, onShow?: () => void) => {
    const draft = composer && draftNow?.thread === thread.id ? draftNow : undefined;
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        snapshotId={snapshotId}
        notes={allNotes}
        located={located}
        expanded={expandedThread === thread.id || draft !== undefined}
        onToggle={() => {
          if (expandedThread === thread.id) return setExpandedThread(undefined);
          setExpandedThread(thread.id);
          if (draftNow && draftNow.thread !== thread.id) setActiveDraft(undefined);
        }}
        onReply={() => replyTo({ thread: thread.id })}
        onResolve={() => void setResolved(thread.id, !thread.resolved)}
        act={conversations.act}
        onReference={expand}
        composer={draft && composerOf(draft)}
        onShow={located && placedThreads.has(thread.id) ? onShow : undefined}
      />
    );
  };
  /** Opens a thread the panel shows and brings it into view, at the cursor in Vim mode. */
  const showThread = (threadId: string) => {
    const at = threadsShown.find(({ thread }) => thread.id === threadId);
    if (at === undefined) return;
    setExpandedThread(threadId);
    if (folded.has(at.file)) setFolds([at.file], false);
    if (vim) return go({ file: at.file, kind: "line", side: at.side, line: at.line }, "top");
    viewer.current?.reveal(
      { file: at.file, side: at.side, line: at.line, full: layout !== "split" },
      "top",
    );
  };
  const composerOf = (draft: Draft) => (
    <Composer
      key={draft.id}
      sessionId={session.id}
      draft={draft}
      change={draftChange(draft, conversations.threads, allNotes, snapshotId)}
      offline={live.state.phase === "live" ? undefined : "Can't reach gyst; your draft is kept."}
      act={conversations.act}
      onClose={() => setActiveDraft(undefined)}
    />
  );
  const openThreads = conversations.threads.filter(({ resolved }) => !resolved).length;
  // Drafts and threads the panel places; Comments shows the others' composers itself.
  const placedThreads = new Set(threadsShown.map(({ thread }) => thread.id));
  const draftPlaced = (draft: Draft) =>
    draftPlace(draft, shownPaths, codeSnapshot) !== undefined ||
    (draft.thread !== undefined && placedThreads.has(draft.thread)) ||
    (draft.thread === undefined &&
      liveNote(draft, allNotes) !== undefined &&
      notes.some(({ note }) => note.id === draft.note!.id));

  /** A note, a foreign hunk's label or a peek's reserved row, as the panel draws it. */
  const noteRow = (annotation: Exclude<DiffAnnotation, { kind: "thread" | "draft" }>) =>
    annotation.kind === "peek" ? (
      <PeekSpacer ref={setSpacer} />
    ) : annotation.kind === "foreign" ? (
      <ForeignHunkLabel owner={annotation.owner} />
    ) : (
      <NoteCard
        note={annotation.note}
        collapsed={collapsedNotes.has(annotation.note.id)}
        onToggle={() =>
          setCollapsedNotes((before) => {
            const after = new Set(before);
            if (!after.delete(annotation.note.id)) after.add(annotation.note.id);
            return after;
          })
        }
        onHighlight={(range) => viewer.current?.highlight(range)}
        onReference={(target) => follow(target, { kind: "note", noteId: annotation.note.id })}
        refocus={
          refocus?.origin.kind === "note" && refocus.origin.noteId === annotation.note.id
            ? refocus.target
            : undefined
        }
        onReply={() => replyTo({ note: annotation.note.id })}
      />
    );

  const run = (id: CommandId) => {
    const view = viewer.current;
    if (id !== "nextNote" && id !== "previousNote") lastNote.current = undefined;
    setRefocus(undefined);
    setNotice(undefined);
    if (id === "menu" || id === "help" || id === "comments") return setDialog(id);
    if (id !== "nextThread" && id !== "previousThread") lastThread.current = undefined;
    if (id === "comment") return comment();
    if (id === "reply") return reply();
    if (id === "resolve") {
      const at = threadAt(here);
      if (!at)
        return setNotice(
          vim ? "Put the cursor on an open thread to resolve it." : "Open a thread to resolve it.",
        );
      return void setResolved(at.thread.id, true);
    }
    if (id === "nextThread" || id === "previousThread")
      return stepThread(id === "nextThread" ? 1 : -1);
    if (id === "refresh") return void refresh();
    if (id === "check") return void checkSource();
    if (id === "search") {
      setSearchShown(true);
      return setSearchFocus((count) => count + 1);
    }
    if (id === "nextMatch" || id === "previousMatch")
      return stepSearch(id === "nextMatch" ? 1 : -1);
    if (id === "back") return goBack();
    if (id === "viewed" && captured)
      return setNotice("Viewed doesn't change while a captured file is expanded.");
    if (id === "nextNote" || id === "previousNote") return stepNote(id === "nextNote" ? 1 : -1);
    if (id === "nextGroup" || id === "previousGroup") {
      const { groups } = status;
      const at = inView.group ? groups.indexOf(inView.group) : -1;
      const next = groups[id === "nextGroup" ? at + 1 : at === -1 ? groups.length - 1 : at - 1];
      return next && chooseView({ kind: "group", id: next.id });
    }
    if (id === "toggleNotes") {
      const ids = notes.map(({ note }) => note.id);
      const collapse = ids.some((note) => !collapsedNotes.has(note));
      return setCollapsedNotes((before) => {
        const after = new Set(before);
        for (const note of ids) {
          if (collapse) after.add(note);
          else after.delete(note);
        }
        return after;
      });
    }
    if (id === "mode") {
      setLines(null);
      return setInputMode(vim ? "mouse" : "vim");
    }
    if (id === "split" || id === "stacked" || id === "auto") return setMode(id);
    if (id === "unfoldAll" || id === "foldAll") {
      const fold = id === "foldAll";
      return setFolds(model.files, fold, fold && here ? { ...here, kind: "header" } : undefined);
    }
    // Esc closes the composer first, keeping its draft, then ends a selection, then clears the
    // search highlight, then closes the peek.
    if (id === "cancel") {
      if (activeDraft !== undefined) return setActiveDraft(undefined);
      if (lines !== null) return setLines(null);
      return searchShown ? closeSearch() : closePeek();
    }
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
    const noteHere = noteAt(here);
    const threadHere = here.kind === "line" ? threadAt(here) : undefined;
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
        // A file shown whole has one column.
        if (layout !== "split" || selecting || !diffs.has(here.file)) return;
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
      case "unfold":
        if (here.kind === "range") return openRange(here);
        if (here.kind === "header" && diffs.has(here.file))
          return id === "open"
            ? setFolds([here.file], !folded.has(here.file))
            : folded.has(here.file) && setFolds([here.file], false);
        // One level at a time: a collapsed note opens before its thread.
        if (noteHere && collapsedNotes.has(noteHere.note.id))
          return setNoteCollapsed(noteHere.note.id, false);
        if (threadHere) return setExpandedThread(threadHere.thread.id);
        return noteHere && setNoteCollapsed(noteHere.note.id, false);
      case "fold":
        // One level at a time: an open thread, then an open note, closes before its file folds.
        if (threadHere && expandedThread === threadHere.thread.id)
          return setExpandedThread(undefined);
        if (noteHere && !collapsedNotes.has(noteHere.note.id))
          return setNoteCollapsed(noteHere.note.id, true);
        if (!diffs.has(here.file) || folded.has(here.file)) return;
        return setFolds([here.file], true, { ...here, kind: "header" });
      case "toggleFold":
        if (here.kind === "range") return openRange(here);
        if (noteHere)
          return setNoteCollapsed(noteHere.note.id, !collapsedNotes.has(noteHere.note.id));
        if (!diffs.has(here.file)) return;
        if (folded.has(here.file)) return setFolds([here.file], false);
        return setFolds([here.file], true, { ...here, kind: "header" });
      case "viewed":
        return toggleViewed(here.file);
      case "definition":
      case "references":
        if (here.kind !== "line")
          return setNotice("Put the cursor on a code line to look up its symbols.");
        return lookUp(here, { kind: "identifiers", query: id });
      default:
        return;
    }
  };

  // Review keys, from anywhere but text entry and the dialogs, which own their own keys. The
  // library's input filter also skips checkboxes and radios, where these keys must still work, so
  // every binding leaves the event alone and this guard decides. It reads the live DOM and `runRef`,
  // not render state: a dialog closes before React renders it closed, and the library syncs
  // callbacks after the render.
  // The two most recent key presses, recorded before any binding sees them, so a key that ends a
  // sequence (`z` then `R`) is left to that sequence rather than run as its own command.
  const keysSeen = useRef<{
    previous: { key: string; at: number } | undefined;
    current: { key: string; at: number } | undefined;
  }>({ previous: undefined, current: undefined });
  useEffect(() => {
    const record = (event: KeyboardEvent) => {
      if (event.repeat || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      keysSeen.current = {
        previous: keysSeen.current.current,
        current: { key: event.key, at: event.timeStamp },
      };
    };
    document.addEventListener("keydown", record, { capture: true });
    return () => document.removeEventListener("keydown", record, { capture: true });
  }, []);
  const runRef = useRef(run);
  runRef.current = run;
  const reviewKey =
    (id: CommandId, step: Hotkey, single: boolean): HotkeyCallback =>
    (event) => {
      if (event.defaultPrevented || event.isComposing || !typed(step, event)) return;
      if (single && completesSequence(event, keysSeen.current.previous, event.timeStamp)) return;
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
      .map(({ id, keys }) => ({ hotkey: keys[0]!, callback: reviewKey(id, keys[0]!, true) })),
    bindingOptions,
  );
  // Disabled while a dialog is open, so keys typed in it can't start a sequence. `dialog` lags the
  // DOM by a render, so a sequence's first key just after a dialog closes may be lost.
  useHotkeySequences(
    bindings
      .filter(({ keys }) => keys.length > 1)
      .map(({ id, keys }) => ({
        sequence: [...keys],
        callback: reviewKey(id, keys.at(-1)!, false),
      })),
    { ...bindingOptions, enabled: dialog === undefined },
  );

  /** Scrolling by hand pulls a cursor that left the panel back onto its first or last line. */
  const pullBack = () => {
    lastNote.current = undefined;
    setRefocus(undefined);
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

  const { scope } = session;
  const pullRequest = scope.kind === "pr" ? progress.pullRequest?.pullRequest : undefined;
  const authorCard = !authorShown ? undefined : scope.kind === "pr" ? (
    pullRequest && (
      <DescriptionCard id={authorId} pullRequest={pullRequest} href={pullRequestUrlOf(scope)} />
    )
  ) : scope.kind === "range" ? (
    <CommitsCard id={authorId} range={scope.range} commits={rangeCommits} />
  ) : undefined;

  return (
    <Frame
      fill
      top={
        <>
          <Crumb session={session} />
          {progress.pullRequest && (
            <StackSwitcher
              sessionId={session.id}
              pullRequest={progress.pullRequest}
              viewedCount={progress.state.viewed.size}
            />
          )}
          <span {...stylex.props(styles.grow)} />
          <PillButton onClick={() => setDialog("menu")}>
            Commands <kbd {...stylex.props(styles.kbd)}>⌘K</kbd>
          </PillButton>
          <PillButton onClick={() => setDialog("comments")}>
            Comments
            {openThreads > 0 && <span {...stylex.props(styles.count)}>{openThreads} open</span>}
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
          {scope.kind === "pr" && pullRequest ? (
            <AuthorEntry
              label="Description"
              pullRequest={{ href: pullRequestUrlOf(scope), number: scope.number }}
              open={authorShown}
              controls={authorId}
              onToggle={toggleAuthor}
            />
          ) : (
            scope.kind === "range" && (
              <AuthorEntry
                label="Commits"
                count={rangeCommits.read?.total}
                open={authorShown}
                controls={authorId}
                onToggle={toggleAuthor}
              />
            )
          )}
          <WalkthroughNav
            status={status}
            viewed={progress.state.viewed}
            view={review}
            onView={chooseView}
          />
          <p {...stylex.props(styles.sideHead, styles.filesHead)}>
            Files <span {...stylex.props(styles.muted)}>{files.length} changed</span>
          </p>
          <FileTree
            nodes={tree}
            files={byPath}
            selection={review.kind === "files" ? review.path : undefined}
            onSelect={(path) => chooseView({ kind: "files", path })}
          />
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
          {lines !== null && <PillButton onClick={() => run("comment")}>Comment</PillButton>}
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
          {captured ? (
            <span>Captured file</span>
          ) : (
            <span>
              {viewedCount}/{hunkCount} {hunkCount === 1 ? "hunk" : "hunks"} viewed in{" "}
              {shown.length} {shown.length === 1 ? "file" : "files"}
            </span>
          )}
          {notice && (
            <span role="status" {...stylex.props(styles.ink)}>
              {notice}
            </span>
          )}
          <LiveStatus
            live={live.state}
            replaced={behind(live.state, progress.state) === "replaced"}
            catchingUp={synchronizing(live.state, progress.state)}
          />
          <span {...stylex.props(styles.grow)} />
          {searchShown && (
            <SearchField
              ref={searchInput}
              query={query}
              status={searchStatus}
              onQuery={setQuery}
              onEnter={enterSearch}
              onStep={stepSearch}
              onClose={closeSearch}
            />
          )}
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
        <div ref={alone} {...stylex.props(styles.alone)}>
          {authorCard && <div {...stylex.props(styles.emptyHeader)}>{authorCard}</div>}
          {inView.group && <div {...stylex.props(styles.emptyHeader)}>{overviewHeader}</div>}
          <p {...stylex.props(styles.empty)}>
            {files.length === 0 ? (
              "This session's snapshot has no changes."
            ) : review.kind === "files" ? (
              <>
                No captured changes under <code>{review.path}</code>.
              </>
            ) : (
              "This group has no changes in this snapshot."
            )}
          </p>
        </div>
      ) : (
        <ContinuousDiff
          // Expand and Back start the panel again, at their own place.
          key={panel.key}
          ref={viewer}
          files={shown}
          diffs={diffs}
          layout={layout}
          inputMode={inputMode}
          folded={folded}
          opened={openedNow}
          mark={vim && here ? markOf(here) : undefined}
          search={
            searchShown && searchResult ? { result: searchResult, current: matchHere } : undefined
          }
          lines={lines}
          header={
            <>
              {authorCard}
              {captured ? (
                <CapturedHeader
                  target={captured}
                  current={captured.snapshotId === snapshotId}
                  load={whole}
                  onBack={goBack}
                  onRetry={() => wholeSides.load(captured)}
                />
              ) : (
                overviewHeader
              )}
              {peekPlace &&
                peekOf({ spacer, extent: () => viewer.current?.extentOf(peekPlace.file) })}
            </>
          }
          annotations={annotations}
          wholeFiles={wholeFiles}
          expandUnchanged={captured !== undefined}
          target={captured}
          restore={panel.restore}
          onPaint={() => peekHandle.current?.place()}
          renderAnnotation={(annotation) => {
            if (annotation.kind === "thread") {
              const thread = conversationOf(annotation.threadId);
              return thread && threadCard(thread, false, true);
            }
            if (annotation.kind === "draft")
              return draftNow?.id === annotation.draftId && composerOf(draftNow);
            if (annotation.kind !== "note") return noteRow(annotation);
            const noteThread = threadsShown.find(({ note }) => note === annotation.note.id)?.thread;
            const noteDraft =
              draftNow &&
              draftNow.thread === undefined &&
              liveNote(draftNow, allNotes)?.id === annotation.note.id
                ? draftNow
                : undefined;
            return (
              <>
                {noteRow(annotation)}
                {noteThread && threadCard(noteThread, false, true)}
                {noteDraft && composerOf(noteDraft)}
              </>
            );
          }}
          loadDiffFiles={loadDiffFiles}
          onWindow={onWindow}
          onWidth={setWidth}
          onOpened={() => setOpenedVersion((version) => version + 1)}
          onSymbol={
            withoutNavigation
              ? undefined
              : (at) => {
                  // A file shown whole has one column, on the expanded reference's side.
                  const side: Side =
                    at.side ??
                    (captured && !diffs.has(at.file) && captured.side === "old"
                      ? "deletions"
                      : "additions");
                  if (vim) setCursor({ file: at.file, kind: "line", side, line: at.line });
                  lookUp(
                    { file: at.file, side, line: at.line },
                    { kind: "identifiers", character: at.character },
                  );
                }
          }
          onLineClick={(target) =>
            vim &&
            setCursor(
              // A file shown whole has one column, on the expanded reference's side.
              captured && !diffs.has(target.file)
                ? { ...target, side: captured.side === "old" ? "deletions" : "additions" }
                : target,
            )
          }
          onLines={(picked) => {
            // A file shown whole has one column, on the expanded reference's side.
            const wholeSide: Side | undefined =
              picked && captured && !diffs.has(picked.id)
                ? captured.side === "old"
                  ? "deletions"
                  : "additions"
                : undefined;
            const next =
              picked && wholeSide
                ? { ...picked, range: { ...picked.range, side: wholeSide, endSide: wholeSide } }
                : picked;
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
          onManualScroll={() => {
            returning.current = false;
            pullBack();
          }}
          onPosition={onPosition}
          renderHeader={(path) => {
            const file = shownByPath.get(path) ?? byPath.get(path)!;
            const hunkIds = hunkIdsOf(path);
            const box = checkboxOf(progress.state, path, hunkIds);
            return (
              <FileHeader
                file={file}
                // A file a late files page found whole-side empty needs no captured contents, so a
                // read that failed after it was rebuilt no longer applies.
                load={wholeFileType(file.manifest) === undefined ? loads.get(path) : undefined}
                cursor={vim && here?.kind === "header" && here.file === path}
                generated={file.manifest?.generated === true || generated.has(path)}
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
      {dialog === "comments" && (
        <CommentsList
          threads={conversations.threads}
          drafts={conversations.drafts}
          snapshotId={snapshotId}
          renderThread={(thread) =>
            threadCard(thread, true, !placedThreads.has(thread.id), () => {
              setDialog(undefined);
              showThread(thread.id);
            })
          }
          renderDraft={(draft) =>
            draft.id === activeDraft && draft.thread === undefined && !draftPlaced(draft)
              ? composerOf(draft)
              : undefined
          }
          onResume={(draft) => {
            setActiveDraft(draft.id);
            setExpandedThread(draft.thread);
            if (draftPlaced(draft)) setDialog(undefined);
          }}
          onDiscard={(draft) =>
            void conversations
              .act({ command: "discard", requestId: newRequestId(), draft: draft.id })
              .then(() => forgetDraftText(session.id, draft.id))
              .catch((error: unknown) => sayFailure("discard the draft", error))
          }
          onClose={() => setDialog((open) => (open === "comments" ? undefined : open))}
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
  empty: { padding: { default: "24px 32px", [media.narrow]: "16px 12px" }, color: theme.muted },
  emptyHeader: { paddingInline: { default: "32px", [media.narrow]: "12px" } },
  earlierNotes: { display: "grid", gap: "8px", marginTop: "10px" },
  alone: { height: "100%", overflow: "auto" },
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
  count: { marginLeft: "6px", color: theme.ink },
});

/**
 * Whether the reader follows the session's committed state, and what to do when it can't. Said in
 * the status line, so a change never shifts the diff being read.
 */
function LiveStatus({
  live,
  replaced,
  catchingUp,
}: {
  live: LiveState;
  replaced: boolean;
  catchingUp: boolean;
}) {
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
      <span {...stylex.props(live.phase === "live" && !catchingUp && styles.ink)}>
        {catchingUp
          ? "Synchronizing…"
          : live.phase === "live"
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
      {catchingUp && (
        <span {...stylex.props(liveStyles.alert)}>
          Reading what changed meanwhile. Viewed changes are paused.
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

/** A rendered box in the panel's scroll coordinates. */
type Box = { top: number; height: number; left: number; width: number };

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
  /** Whether a rendered file shows this new-side line rather than keeping it in a hidden range. */
  renders(file: string, line: number): boolean;
  height(): number;
  scrollBy(pixels: number): void;
  /** Scrolls to a pixel offset, as an overview's place is kept. */
  scrollTo(top: number): void;
  scrollToEdge(end: "top" | "bottom"): void;
  /** Opens `count` hidden lines of a rendered file's range from both ends. */
  expand(file: string, range: number, count: number): void;
  /** Highlights a captured range of a shown file, as a note's hover does, or clears it. */
  highlight(range: CapturedRange | undefined): void;
  /** The reading position at the panel's top and its pixel offset, for Back to return to. */
  position(): { position: ReadingPosition | undefined; scrollTop: number };
  /** A rendered file's horizontal extent, across both split columns. */
  extentOf(file: string): Extent | undefined;
};

/**
 * A right-clicked spot in code: its file, the split column it is on (none in a file shown whole),
 * its line and the UTF-16 offset in that line of the clicked character, unknown where the browser
 * can't place the click.
 */
type SymbolAt = {
  file: string;
  side: Side | undefined;
  line: number;
  character: number | undefined;
};

/**
 * The UTF-16 offset in a code token's text of the character a pointer event is on. A highlighting
 * token can hold several identifiers (past the renderer's highlighting limit a whole line is one),
 * so the token alone never names the symbol clicked.
 */
function offsetIn(token: HTMLElement, event: MouseEvent): number | undefined {
  const root = token.getRootNode();
  const caret = document.caretPositionFromPoint(event.clientX, event.clientY, {
    shadowRoots: root instanceof ShadowRoot ? [root] : [],
  });
  if (!caret || !token.contains(caret.offsetNode)) return undefined;
  const { offsetNode } = caret;
  let { offset } = caret;
  // The caret falls on the boundary nearest the pointer: after the character on its right half.
  if (offsetNode instanceof Text && offset > 0) {
    const previous = document.createRange();
    previous.setStart(offsetNode, offset - 1);
    previous.setEnd(offsetNode, offset);
    if (event.clientX < previous.getBoundingClientRect().right) offset -= 1;
  }
  const before = document.createRange();
  before.setStart(token, 0);
  before.setEnd(offsetNode, offset);
  return before.toString().length;
}

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
  /** The search's matches to highlight, and the one gone to. */
  search: { result: SearchResult; current: MatchAt | undefined } | undefined;
  lines: CodeViewLineSelection | null;
  /** Above the first file: the view's overview. */
  header: ReactNode;
  /** Each file's notes and labels; a file without any has no entry. */
  annotations: ReadonlyMap<string, DiffLineAnnotation<DiffAnnotation>[]>;
  renderAnnotation: (annotation: DiffAnnotation) => ReactNode;
  /** Whole captured sides shown as files without a diff, by path. */
  wholeFiles: ReadonlyMap<string, string>;
  /** Shows every file's unchanged lines, as an expanded captured file reads. */
  expandUnchanged: boolean;
  /** A range kept highlighted, the expanded reference's; a note's hover shows over it. */
  target: CapturedRange | undefined;
  /** Where the panel starts, read once when it mounts. */
  restore: Restore | undefined;
  /** After each repaint of the overlays: the diff may have moved under them. */
  onPaint: () => void;
  loadDiffFiles: FileDiffContentsLoader;
  /** The files the panel shows now, after each render and scroll. */
  onWindow: (visible: readonly string[]) => void;
  /**
   * What is at the panel's top after each render and scroll that read it: a reading position, or
   * above the first file (an overview) the panel's offset.
   */
  onPosition: (top: Restore) => void;
  onWidth: (width: number) => void;
  onOpened: () => void;
  onLineClick: (cursor: Cursor) => void;
  /** A right-click on a code token, which then shows no browser menu; absent, it always does. */
  onSymbol: ((at: SymbolAt) => void) | undefined;
  onLines: (selection: CodeViewLineSelection | null) => void;
  onManualScroll: () => void;
  renderHeader: (path: string) => ReactNode;
}) {
  const { diffs, layout, onWidth } = props;
  const view = useRef<CodeViewHandle<DiffAnnotation, undefined>>(null);
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition | undefined>(
    props.restore && "position" in props.restore ? props.restore.position : undefined,
  );
  const restoreTop = useRef(
    props.restore && "scrollTop" in props.restore ? props.restore.scrollTop : undefined,
  );
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
    const first = latest.current.files[0];
    const firstTop = first && viewer.getTopForItem(first.path);
    if (firstTop !== undefined && seen < firstTop) {
      // Above every file: no code position is the reader's any more, so none is restored.
      position.current = undefined;
      latest.current.onPosition({ scrollTop });
      return;
    }
    for (const { id, instance } of viewer.getRenderedItems()) {
      const top = viewer.getTopForItem(id);
      if (top === undefined || seen < top || seen >= top + instance.height) continue;
      const anchor = instance.getNumericScrollAnchor(seen - top);
      position.current = { file: id, side: anchor?.side, line: anchor?.lineNumber };
      latest.current.onPosition({ position: position.current });
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

  /** A rendered file's marks' boxes in the panel's scroll coordinates: its header's or a line's. */
  const itemBoxes = useCallback((file: string) => {
    const viewer = view.current?.getInstance();
    const node = root.current;
    const rendered = viewer?.getRenderedItems().find((item) => item.id === file);
    // Rows come from the item's top; its element holds only the rendered window of rows, so it
    // gives the horizontal extent alone.
    const top = viewer?.getTopForItem(file);
    if (node === null || rendered === undefined || top === undefined) return undefined;
    const outer = node.getBoundingClientRect();
    const rect = rendered.element.getBoundingClientRect();
    const left = rect.left - outer.left + node.scrollLeft;
    let annotations: number[] | undefined;
    return (mark: Omit<Mark, "file">): Box | undefined => {
      if (mark.line === undefined) return { top, height: headerHeight, left, width: rect.width };
      // A file shown whole has one column.
      const whole = rendered.type === "file";
      const at = whole
        ? rendered.instance.getLinePosition(mark.line)
        : rendered.instance.getLinePosition(mark.line, mark.side);
      if (at === undefined) return undefined;
      // A line's position includes the annotations under it; its own rows end where one begins.
      annotations ??= [...rendered.element.querySelectorAll("[data-annotation]")].map(
        (annotation) => annotation.getBoundingClientRect().top - outer.top + node.scrollTop,
      );
      let height = at.height;
      for (const annotationTop of annotations) {
        const below = annotationTop - (top + at.top);
        if (below > 0 && below < height) height = below;
      }
      const half = rect.width / 2;
      // Split view lays an added or deleted file out in its one side's column, full width.
      const full =
        mark.full ||
        whole ||
        rendered.item.fileDiff.type === "new" ||
        rendered.item.fileDiff.type === "deleted";
      return {
        top: top + at.top,
        height,
        left: full || mark.side === "deletions" ? left : left + half,
        width: full ? rect.width : half,
      };
    };
  }, []);
  /** A mark's box in the panel's scroll coordinates, while its file is rendered. */
  const boxOf = useCallback((mark: Mark) => itemBoxes(mark.file)?.(mark), [itemBoxes]);

  // ─── search matches ───
  const hitLayer = useRef<HTMLDivElement>(null);
  const hitFiles = useRef<{ result: SearchResult; index: Map<string, number> }>(undefined);
  /**
   * Highlights the matched lines in the panel's viewport, the one gone to apart: one box per line,
   * as the renderer offers no public decoration of a line's text.
   */
  const paintHits = useCallback(() => {
    const layer = hitLayer.current;
    const node = root.current;
    const viewer = view.current?.getInstance();
    if (layer === null || node === null) return;
    const { search, layout: shape, folded } = latest.current;
    const boxes: { box: Box; current: boolean }[] = [];
    if (search && viewer) {
      const { result, current } = search;
      if (hitFiles.current?.result !== result)
        hitFiles.current = { result, index: new Map(result.files.map((file, at) => [file, at])) };
      const { index } = hitFiles.current;
      const top = node.scrollTop;
      const bottom = top + node.clientHeight;
      for (const { id } of viewer.getRenderedItems()) {
        const fileIndex = index.get(id);
        const hits = fileIndex === undefined ? undefined : result.hits[fileIndex];
        const boxIn = itemBoxes(id);
        if (hits === undefined || hits.length === 0 || folded.has(id) || boxIn === undefined)
          continue;
        const boxAt = (at: number) => {
          const { old, new: added } = hits[at]!;
          return boxIn({
            side: added === undefined ? "deletions" : "additions",
            line: (added ?? old)!,
            full: shape !== "split" || (old !== undefined && added !== undefined),
          });
        };
        // Hits run down the file in reading order: the first one reaching into the viewport, then
        // each until one starts below it.
        let low = 0;
        let high = hits.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          const box = boxAt(middle);
          if (box !== undefined && box.top + box.height > top) high = middle;
          else low = middle + 1;
        }
        for (let at = low; at < hits.length; at++) {
          const box = boxAt(at);
          if (box === undefined) continue;
          if (box.top >= bottom || box.height === 0) break;
          boxes.push({
            box,
            current: current !== undefined && current.fileIndex === fileIndex && current.hit === at,
          });
        }
      }
    }
    const shown = [...layer.children] as HTMLElement[];
    for (const [at, { box, current }] of boxes.entries()) {
      let element = shown[at];
      if (element === undefined) {
        element = document.createElement("div");
        element.dataset.searchHit = "";
        layer.append(element);
      }
      element.hidden = false;
      element.className = stylex.props(
        cursorStyles.hit,
        current && cursorStyles.currentHit,
      ).className!;
      element.toggleAttribute("data-current", current);
      element.style.top = `${box.top}px`;
      element.style.left = `${box.left}px`;
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
    }
    for (const element of shown.slice(boxes.length)) element.hidden = true;
  }, [itemBoxes]);

  // ─── the Vim cursor bar and the highlighted range ───
  const bar = useRef<HTMLDivElement>(null);
  const rangeBox = useRef<HTMLDivElement>(null);
  const highlighted = useRef<CapturedRange>(undefined);
  const paint = useCallback(() => {
    const show = (element: HTMLElement | null, box: Box | undefined) => {
      if (element === null) return;
      element.hidden = box === undefined;
      if (box === undefined) return;
      element.style.top = `${box.top}px`;
      element.style.left = `${box.left}px`;
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
    };
    const { mark, layout: shape } = latest.current;
    show(bar.current, mark?.line === undefined ? undefined : boxOf(mark));
    // The range's rendered lines; its hidden ones have no box.
    const range = highlighted.current ?? latest.current.target;
    let union: Box | undefined;
    if (range)
      for (let line = range.startLine; line <= range.endLine; line++) {
        const box = boxOf({
          file: range.path,
          side: range.side === "old" ? "deletions" : "additions",
          line,
          full: shape !== "split",
        });
        if (box === undefined) continue;
        const bottom = Math.max(box.top + box.height, union ? union.top + union.height : 0);
        const top = Math.min(box.top, union?.top ?? box.top);
        union = { ...box, top, height: bottom - top };
      }
    show(rangeBox.current, union);
    paintHits();
    latest.current.onPaint();
  }, [boxOf, paintHits]);

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
        for (const { id, instance } of viewer.getRenderedItems()) {
          const itemTop = viewer.getTopForItem(id);
          if (itemTop === undefined || y < itemTop || y >= itemTop + instance.height) continue;
          const anchor =
            y >= itemTop + headerHeight ? instance.getNumericScrollAnchor(y - itemTop) : undefined;
          return anchor
            ? { file: id, kind: "line", side: anchor.side ?? "additions", line: anchor.lineNumber }
            : { file: id, kind: "header", side: "additions" };
        }
        return undefined;
      },
      fileInView: () => position.current?.file ?? props.files[0]?.path,
      renders(file, line) {
        const rendered = view.current
          ?.getInstance()
          ?.getRenderedItems()
          .find((item) => item.id === file);
        return rendered?.type === "diff" && rendered.instance.isLineRenderable(line);
      },
      height: () => node().clientHeight,
      scrollBy(pixels) {
        scrollTop((pendingTop.current ?? node().scrollTop) + pixels);
      },
      scrollTo: scrollTop,
      scrollToEdge(end) {
        // The renderer drives it: its layout corrections over files it has not measured yet would
        // stop a native smooth scroll partway (Chrome 154).
        pendingTop.current = undefined;
        manualAt.current = -Infinity;
        view.current?.scrollTo({
          type: "position",
          position: end === "top" ? 0 : Infinity,
          behavior: "smooth-auto",
        });
      },
      expand(file, range, count) {
        const rendered = view.current
          ?.getInstance()
          ?.getRenderedItems()
          .find((item) => item.id === file);
        if (rendered?.type === "diff") rendered.instance.expandHunk(range, "both", count);
      },
      highlight(range) {
        highlighted.current = range;
        paint();
      },
      position: () => ({ position: position.current, scrollTop: node().scrollTop }),
      extentOf(file) {
        const rendered = view.current
          ?.getInstance()
          ?.getRenderedItems()
          .find((item) => item.id === file);
        if (rendered === undefined) return undefined;
        const outer = node().getBoundingClientRect();
        const rect = rendered.element.getBoundingClientRect();
        return { left: rect.left - outer.left + node().scrollLeft, width: rect.width };
      },
    };
  });

  /**
   * Keeps the hidden lines the reader opened and the renderer's own in step after a render: lines
   * the renderer opened (a click) are recorded, and lines it forgot (it dropped and rebuilt the
   * item) are opened again. Loaded sides only: a partial diff opens nothing yet.
   */
  const syncOpened = useCallback((file: string, instance: FileDiff<DiffAnnotation>) => {
    const diff = instance.fileDiff;
    if (diff === undefined || diff.isPartial) return;
    const { opened, onOpened } = latest.current;
    const byRange = opened.get(file) ?? new Map<number, Opened>();
    let changed = false;
    let reopened = false;
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
        reopened = true;
        continue;
      }
      let { fromStart, fromEnd } = mine;
      while (fromStart + fromEnd < range.size && shows(fromStart)) fromStart++;
      while (fromStart + fromEnd < range.size && shows(range.size - 1 - fromEnd)) fromEnd++;
      if (fromStart === mine.fromStart && fromEnd === mine.fromEnd) continue;
      byRange.set(range.index, { fromStart, fromEnd });
      changed = true;
    }
    if (changed) opened.set(file, byRange);
    // Opened again too: a return to a reading place inside these lines waits for them.
    if (changed || reopened) onOpened();
  }, []);

  // One item per file, reused while its fold and metadata are unchanged so the renderer keeps its
  // state. A replaced item carries a new version: the renderer reads an item again only then. Only
  // the shown files' items stay cached, so an unselected file's contents are not kept here.
  const itemCache = useRef(new Map<string, CodeViewItem<DiffAnnotation>>());
  const itemVersion = useRef(0);
  const items = useMemo(() => {
    const cache = itemCache.current;
    itemCache.current = new Map();
    return props.files.map((file): CodeViewItem<DiffAnnotation> => {
      const fileDiff = diffs.get(file.path);
      const whole = fileDiff ? undefined : props.wholeFiles.get(file.path);
      const collapsed =
        (fileDiff === undefined && whole === undefined) || props.folded.has(file.path);
      const annotations = props.annotations.get(file.path);
      const cached = cache.get(file.path);
      if (
        cached &&
        cached.collapsed === collapsed &&
        cached.annotations === annotations &&
        (cached.type === "diff"
          ? cached.fileDiff === fileDiff
          : fileDiff === undefined && cached.file.contents === (whole ?? ""))
      ) {
        itemCache.current.set(file.path, cached);
        return cached;
      }
      const version = ++itemVersion.current;
      const item: CodeViewItem<DiffAnnotation> = fileDiff
        ? {
            id: file.path,
            type: "diff",
            fileDiff,
            collapsed,
            version,
            ...(annotations && { annotations }),
          }
        : // A captured side shown whole, or no captured text to show: the header alone says why.
          // Its one column takes each annotation by line alone.
          {
            id: file.path,
            type: "file",
            file: { name: file.path, contents: whole ?? "" },
            collapsed,
            version,
            ...(annotations && { annotations }),
          };
      itemCache.current.set(file.path, item);
      return item;
    });
  }, [props.files, diffs, props.folded, props.annotations, props.wholeFiles]);

  const hovered = useRef<{ element: HTMLElement; start: number; at: Omit<SymbolAt, "character"> }>(
    undefined,
  );
  const options = useMemo(
    (): CodeViewReactOptions<DiffAnnotation, undefined> => ({
      theme: "catppuccin-mocha",
      themeType: "dark",
      diffStyle: layout === "split" ? "split" : "unified",
      overflow: "wrap",
      diffIndicators: "bars",
      lineDiffType: "word",
      expandUnchanged: props.expandUnchanged,
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
      // The token under the pointer, within which a right-click asks about the clicked character.
      // The renderer reports tokens only to these callbacks; a right-click alone reports nothing.
      onTokenEnter: (token, _event, context) => {
        hovered.current = {
          element: token.tokenElement,
          start: token.lineCharStart,
          at: {
            file: context.item.id,
            side: "side" in token ? token.side : undefined,
            line: token.lineNumber,
          },
        };
      },
      onTokenLeave: () => {
        hovered.current = undefined;
      },
      onLineClick: (line, context) => {
        latest.current.onLineClick({
          file: context.item.id,
          kind: "line",
          // A file shown whole has one column; the reader keeps its cursor's side there.
          side: "annotationSide" in line ? line.annotationSide : "additions",
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
    [
      layout,
      props.loadDiffFiles,
      props.inputMode,
      props.expandUnchanged,
      capture,
      paint,
      syncOpened,
      reportWindow,
    ],
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
      // Shift keeps the browser's own menu, as does any spot but the hovered token.
      const onMenu = (event: MouseEvent) => {
        const token = hovered.current;
        const onSymbol = latest.current.onSymbol;
        if (!token || !onSymbol || event.shiftKey || !event.composedPath().includes(token.element))
          return;
        event.preventDefault();
        const offset = offsetIn(token.element, event);
        onSymbol({
          ...token.at,
          character: offset === undefined ? undefined : token.start + offset,
        });
      };
      node.addEventListener("contextmenu", onMenu);
      node.addEventListener("wheel", manual, { passive: true });
      node.addEventListener("touchmove", manual, { passive: true });
      node.addEventListener("pointerdown", onPointer);
      node.addEventListener("scrollend", settled);
      window.addEventListener("keydown", onKey);
      detach.current = () => {
        node.removeEventListener("contextmenu", onMenu);
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
    const top = restoreTop.current;
    restoreTop.current = undefined;
    if (top !== undefined) {
      view.current?.scrollTo({ type: "position", position: top });
      return;
    }
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
  // A note that leaves with its view never reports the pointer leaving it.
  useLayoutEffect(() => {
    highlighted.current = undefined;
  }, [props.files]);
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
      renderCodeViewHeader={() => (
        <>
          {props.header}
          <div ref={hitLayer} data-search-hits aria-hidden />
          <CursorOverlay ref={bar} />
          <RangeOverlay ref={rangeBox} />
        </>
      )}
      renderCustomHeader={(item) => props.renderHeader(item.id)}
      renderAnnotation={(annotation) => props.renderAnnotation(annotation.metadata)}
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

/**
 * A highlighted note range over its rendered lines, placed like the cursor overlay from the
 * renderer's public geometry.
 */
function RangeOverlay(props: { ref: Ref<HTMLDivElement> }) {
  return (
    <div ref={props.ref} hidden data-range aria-hidden {...stylex.props(cursorStyles.range)} />
  );
}

const cursorStyles = stylex.create({
  bar: {
    position: "absolute",
    zIndex: 1,
    pointerEvents: "none",
    backgroundColor: `color-mix(in srgb, ${theme["--accent"]} 14%, transparent)`,
    boxShadow: `inset 2px 0 0 ${theme["--accent"]}`,
  },
  range: {
    position: "absolute",
    zIndex: 1,
    pointerEvents: "none",
    backgroundColor: `color-mix(in srgb, ${theme["--accent"]} 8%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${theme["--accent"]} 60%, transparent)`,
  },
  // A search match: tinted apart from the cursor; the one gone to is outlined as well, so it shows
  // without colour.
  hit: {
    position: "absolute",
    zIndex: 1,
    pointerEvents: "none",
    backgroundColor: `color-mix(in srgb, ${theme.match} 16%, transparent)`,
  },
  currentHit: {
    backgroundColor: `color-mix(in srgb, ${theme.match} 30%, transparent)`,
    boxShadow: `inset 0 0 0 1px ${theme.match}`,
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
    overscrollBehavior: "none",
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
  /** The snapshot records the file as Generated. */
  generated: boolean;
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
      {props.generated && (
        <span
          {...stylex.props(headerStyles.generated)}
          title="Marked linguist-generated or linguist-vendored by Git attributes"
        >
          Generated
        </span>
      )}
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
  generated: {
    flexShrink: 0,
    padding: "0 6px",
    borderRadius: "4px",
    backgroundColor: theme.line,
    color: theme.muted,
    fontSize: "11.5px",
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
  /** The selected path; undefined while a walkthrough group is shown. */
  selection: string | undefined;
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
