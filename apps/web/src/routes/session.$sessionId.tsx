import type {
  CodePayload,
  ContentSide,
  DaemonError,
  FilesPayload,
  Hunk,
  ManifestFile,
} from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link,
  notFound,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
  const { session, hunks, snapshotId, files: captured } = Route.useLoaderData();
  const navigate = useNavigate();
  const files = [...Map.groupBy(hunks, (hunk) => hunk.file)];
  const jump = (index: number) => {
    const heading = document.getElementById(`file-${index}`);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  };
  return (
    <Frame
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
          <p {...stylex.props(styles.sideHead)}>
            Changed files <span {...stylex.props(styles.muted)}>{files.length}</span>
          </p>
          <ul>
            {files.map(([file], index) => (
              <li key={file}>
                <button
                  type="button"
                  {...stylex.props(styles.fileLink)}
                  onClick={() => jump(index)}
                >
                  {file}
                </button>
              </li>
            ))}
          </ul>
        </>
      }
      status={
        <>
          <span {...stylex.props(styles.mode)}>Plain diff</span>
          <span>
            {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"} in {files.length}{" "}
            {files.length === 1 ? "file" : "files"}
          </span>
          <span {...stylex.props(styles.grow)} />
          <span>
            session <code>{session.id}</code>
          </span>
        </>
      }
    >
      {files.length === 0 ? (
        <p {...stylex.props(styles.muted)}>This session's snapshot has no changes.</p>
      ) : (
        // ponytail: renders every hunk at once; window/virtualize with the richer reader.
        files.map(([file, fileHunks], index) => (
          <FileDiff key={file} id={`file-${index}`} file={file} hunks={fileHunks} />
        ))
      )}
      {/* Keyed: another snapshot starts its own listing and code views. */}
      <CapturedFiles
        key={snapshotId}
        sessionId={session.id}
        snapshotId={snapshotId}
        first={captured}
      />
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
  fileLink: {
    display: "block",
    width: "100%",
    padding: "4px 10px",
    borderRadius: "6px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    direction: "rtl",
    textAlign: "left",
  },
  mode: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: theme.ink,
    fontWeight: 500,
    "::before": {
      content: '""',
      width: "7px",
      height: "7px",
      borderRadius: "50%",
      backgroundColor: theme["--accent"],
    },
  },
});

function FileDiff(props: { id: string; file: string; hunks: readonly Hunk[] }) {
  const slash = props.file.lastIndexOf("/");
  const lines = props.hunks.flatMap((hunk) => hunk.patch.split("\n").slice(1));
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  return (
    <section {...stylex.props(fileStyles.box)} aria-labelledby={props.id}>
      <h2 {...stylex.props(fileStyles.head)} id={props.id} tabIndex={-1}>
        <span {...stylex.props(fileStyles.name)}>{props.file.slice(slash + 1)}</span>
        {slash >= 0 && (
          <span {...stylex.props(fileStyles.dir)}>{props.file.slice(0, slash + 1)}</span>
        )}
        <span {...stylex.props(styles.grow)} />
        <span {...stylex.props(fileStyles.stat)}>
          <span {...stylex.props(fileStyles.add)}>+{added}</span>{" "}
          <span {...stylex.props(fileStyles.del)}>−{removed}</span>
        </span>
      </h2>
      {props.hunks.map((hunk) => (
        <HunkDiff key={hunk.id} hunk={hunk} />
      ))}
    </section>
  );
}

const fileStyles = stylex.create({
  box: {
    borderRadius: "6px",
    boxShadow: `0 0 0 1px ${theme.line}`,
    // Spaces files apart; they are the pane's first sections.
    marginTop: { default: "10px", ":first-of-type": 0 },
  },
  head: {
    position: "sticky",
    top: { default: "-24px", [media.narrow]: "-16px" },
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "34px",
    padding: "0 10px",
    backgroundColor: theme.surface,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
    borderRadius: "6px 6px 0 0",
    fontSize: "13px",
    fontWeight: 400,
    scrollMarginTop: "24px",
  },
  name: { fontWeight: 500, whiteSpace: "nowrap" },
  dir: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.faint,
    fontSize: "12px",
  },
  stat: {
    fontFamily: theme["--mono"],
    fontSize: "11.5px",
    lineHeight: "normal",
    whiteSpace: "nowrap",
  },
  add: { color: theme.add },
  del: { color: theme.del },
});

const lineKind = (line: string) =>
  line.startsWith("+")
    ? "add"
    : line.startsWith("-")
      ? "del"
      : line.startsWith("\\")
        ? "meta"
        : "context";

/**
 * The captured `Hunk.patch`, rendered as text (React escapes it): a table whose rows are its lines,
 * each an old number, a new number and a code cell.
 */
function HunkDiff({ hunk }: { hunk: Hunk }) {
  const [header = "", ...body] = hunk.patch.split("\n");
  const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(header);
  let oldLine = Number(start?.[1] ?? 0);
  let newLine = Number(start?.[2] ?? 0);
  return (
    <div role="table" {...stylex.props(hunkStyles.hunk)}>
      <div role="row" {...lineProps.header}>
        <span role="cell" {...stylex.props(hunkStyles.num)} />
        <span role="cell" {...stylex.props(hunkStyles.num)} />
        <span role="cell" {...stylex.props(hunkStyles.code)}>
          {header}
        </span>
      </div>
      {body.map((line, index) => {
        const kind = lineKind(line);
        const oldNumber = kind === "context" || kind === "del" ? oldLine++ : undefined;
        const newNumber = kind === "context" || kind === "add" ? newLine++ : undefined;
        return (
          // Index keys: the lines of one frozen patch never reorder.
          <div key={index} role="row" {...lineProps[kind]}>
            <span role="cell" {...stylex.props(hunkStyles.num)}>
              {oldNumber}
            </span>
            <span role="cell" {...stylex.props(hunkStyles.num)}>
              {newNumber}
            </span>
            <span role="cell" {...stylex.props(hunkStyles.code)}>
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const hunkStyles = stylex.create({
  hunk: {
    overflowX: "auto",
    fontFamily: theme["--mono"],
    fontSize: "12px",
    lineHeight: 1.6,
    // A rule between hunks; the first follows the file header's own rule.
    borderTopWidth: { default: "1px", ":first-of-type": 0 },
    borderTopStyle: "solid",
    borderTopColor: theme.line,
  },
  line: { display: "grid", gridTemplateColumns: "5ch 5ch minmax(max-content, 1fr)" },
  header: {
    color: theme.hunkHeader,
    backgroundColor: `color-mix(in srgb, ${theme.hunkHeader} 6%, transparent)`,
  },
  add: {
    color: theme.add,
    backgroundColor: `color-mix(in srgb, ${theme.add} 12%, transparent)`,
  },
  del: {
    color: theme.del,
    backgroundColor: `color-mix(in srgb, ${theme.del} 12%, transparent)`,
  },
  meta: { color: theme.faint },
  num: { paddingRight: "1ch", textAlign: "right", color: theme.faint, userSelect: "none" },
  code: { padding: "0 12px 0 1ch", whiteSpace: "pre" },
});

// Precomputed so each line kind compiles to a static class name.
const lineProps = {
  header: stylex.props(hunkStyles.line, hunkStyles.header),
  context: stylex.props(hunkStyles.line),
  add: stylex.props(hunkStyles.line, hunkStyles.add),
  del: stylex.props(hunkStyles.line, hunkStyles.del),
  meta: stylex.props(hunkStyles.line, hunkStyles.meta),
};

// ─── captured files ──────────────────────────────────────────────────────

const notCaptured = {
  binary: "binary content is not captured",
  "unsupported-encoding": "content that is not UTF-8 text is not captured",
  symlink: "a symbolic link; its target is not captured",
  submodule: "a submodule; its contents are not captured",
} satisfies Record<Extract<ContentSide, { kind: "unavailable" }>["reason"], string>;

const sideSummary = (side: ContentSide) =>
  side.kind === "text"
    ? `${side.size} ${side.size === 1 ? "byte" : "bytes"}`
    : side.kind === "absent"
      ? "absent"
      : `unavailable (${side.reason})`;

/** The snapshot's captured files, supporting and unavailable ones included, a page at a time. */
function CapturedFiles(props: { sessionId: string; snapshotId: string; first: FilesPayload }) {
  const [pages, setPages] = useState([props.first]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const mounted = useMounted();
  const files = pages.flatMap((page) => page.files);
  const after = pages.at(-1)!.next;
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
      if (mounted.current) setPages((loaded) => [...loaded, page]);
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section {...stylex.props(capturedStyles.box)} aria-labelledby="captured-files">
      <h2 {...stylex.props(capturedStyles.head)} id="captured-files">
        Captured files <span {...stylex.props(styles.muted)}>{props.first.total}</span>
      </h2>
      <p {...stylex.props(styles.muted)}>
        Exact text saved with this snapshot; it is read from gyst, never from the checkout.
      </p>
      <ul {...stylex.props(capturedStyles.list)} aria-label="Captured files">
        {files.map((file) => (
          <CapturedFileRow
            key={file.path}
            file={file}
            sessionId={props.sessionId}
            snapshotId={props.snapshotId}
          />
        ))}
      </ul>
      {failure !== undefined && <FailureNotice error={failure} />}
      {after !== null && (
        <PillButton disabled={pending} onClick={() => void more(after)}>
          {pending
            ? "Loading files…"
            : failure !== undefined
              ? "Retry loading files"
              : `Load more files (${files.length} of ${props.first.total} shown)`}
        </PillButton>
      )}
    </section>
  );
}

function CapturedFileRow(props: { file: ManifestFile; sessionId: string; snapshotId: string }) {
  const { file } = props;
  const [shown, setShown] = useState<"old" | "new">();
  return (
    <li {...stylex.props(capturedStyles.file)}>
      <div {...stylex.props(capturedStyles.row)}>
        <code {...stylex.props(capturedStyles.path)}>{file.path}</code>
        <span {...stylex.props(styles.muted)}>
          old: {sideSummary(file.old)} · new: {sideSummary(file.new)}
        </span>
        {file.renamedFrom !== undefined && (
          <span {...stylex.props(styles.muted)}>
            renamed from <code>{file.renamedFrom}</code> (not reviewed)
          </span>
        )}
        {file.modeChange !== undefined && (
          <span {...stylex.props(styles.muted)}>
            mode {file.modeChange.old} → {file.modeChange.new} (not reviewed)
          </span>
        )}
        <span {...stylex.props(styles.grow)} />
        {(["old", "new"] as const).map((side) => (
          <PillButton
            key={side}
            aria-expanded={shown === side}
            onClick={() => setShown(shown === side ? undefined : side)}
          >
            {shown === side ? `Hide ${side}` : `View ${side}`}
          </PillButton>
        ))}
      </div>
      {shown !== undefined && (
        <CapturedCode
          key={shown}
          sessionId={props.sessionId}
          snapshotId={props.snapshotId}
          file={file.path}
          side={shown}
        />
      )}
    </li>
  );
}

/**
 * One side of a captured file, fetched a page at a time on demand. A failed page keeps what was
 * already loaded and retries from where it stopped; a replaced snapshot asks for a reload.
 */
function CapturedCode(props: {
  sessionId: string;
  snapshotId: string;
  file: string;
  side: "old" | "new";
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [content, setContent] = useState<CodePayload["content"]>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown; offset: number | undefined }>();
  const mounted = useMounted();
  const load = async (offset?: number) => {
    setPending(true);
    setFailure(undefined);
    try {
      const page = await operation({
        command: "code",
        session: props.sessionId,
        snapshotId: props.snapshotId,
        file: props.file,
        side: props.side,
        offset,
      });
      if (!mounted.current) return;
      const loaded = page.content;
      if (loaded.kind === "text")
        setText((before) => (offset === undefined ? loaded.text : before + loaded.text));
      setContent(loaded);
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure({ error, offset });
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  // The first page, once per mount: the caller keys this view by side.
  useEffect(() => {
    void load();
  }, []);
  const next = content?.kind === "text" ? content.next : null;
  const stale = failure !== undefined && isDaemonError(failure.error, "stale_revision");
  return (
    <div
      {...stylex.props(capturedStyles.code)}
      role="region"
      aria-label={`${props.file}, ${props.side} side`}
    >
      {content?.kind === "absent" && (
        <p {...stylex.props(capturedStyles.inset, styles.muted)}>
          This file does not exist on the {props.side} side.
        </p>
      )}
      {content?.kind === "unavailable" && (
        <p {...stylex.props(capturedStyles.inset, capturedStyles.notice)}>
          Not captured: {notCaptured[content.reason]}.
        </p>
      )}
      {content?.kind === "text" &&
        (content.size === 0 ? (
          <p {...stylex.props(capturedStyles.inset, styles.muted)}>Empty file.</p>
        ) : (
          <CodeLines text={text} partial={next !== null && !text.endsWith("\n")} />
        ))}
      {pending && (
        <p role="status" {...stylex.props(capturedStyles.inset, styles.muted)}>
          Loading…
        </p>
      )}
      {failure !== undefined && (
        <>
          <div {...stylex.props(capturedStyles.inset)}>
            <FailureNotice error={failure.error} />
          </div>
          <div {...stylex.props(capturedStyles.buttonInset)}>
            <PillButton onClick={() => void (stale ? router.invalidate() : load(failure.offset))}>
              {stale ? "Reload session" : "Retry"}
            </PillButton>
          </div>
        </>
      )}
      {next !== null && !pending && failure === undefined && content?.kind === "text" && (
        <div {...stylex.props(capturedStyles.buttonInset)}>
          <PillButton onClick={() => void load(next.offset)}>
            Load more ({next.offset} of {content.size} bytes shown)
          </PillButton>
        </div>
      )}
    </div>
  );
}

const capturedStyles = stylex.create({
  box: { marginTop: "24px" },
  head: { fontSize: "14px", fontWeight: 500 },
  list: { margin: "10px 0" },
  file: {
    borderTopWidth: { default: "1px", ":first-of-type": 0 },
    borderTopStyle: "solid",
    borderTopColor: theme.line,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 10px",
    padding: "6px 0",
    fontSize: "12.5px",
  },
  path: { overflowWrap: "anywhere" },
  code: {
    marginBottom: "8px",
    borderRadius: "6px",
    boxShadow: `0 0 0 1px ${theme.line}`,
  },
  inset: { margin: "8px 10px" },
  // Padding, not margin: an inline button's margins never collapsed into the box's edge.
  buttonInset: { padding: "8px 10px" },
  notice: { maxWidth: "80ch" },
});

/**
 * Loaded captured text from line 1 (React escapes it): a table whose rows are its lines, each a
 * line number and a code cell. A cut-off last line says it continues.
 */
function CodeLines({ text, partial }: { text: string; partial: boolean }) {
  const lines = text.split("\n");
  // A final LF ends the last line; it does not start another.
  if (lines.at(-1) === "") lines.pop();
  return (
    // ponytail: renders every loaded line; window/virtualize with the richer reader.
    <div role="table" {...stylex.props(codeStyles.table)}>
      {lines.map((line, index) => (
        // Index keys: loaded lines only ever append.
        <div key={index} role="row" {...stylex.props(codeStyles.line)}>
          <span role="cell" {...stylex.props(hunkStyles.num)}>
            {index + 1}
          </span>
          <span role="cell" {...stylex.props(hunkStyles.code)}>
            {line}
            {partial && index === lines.length - 1 && (
              <span {...stylex.props(styles.muted)}> … continues</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// The hunk look without its rules between hunks, and one number column.
const codeStyles = stylex.create({
  table: { overflowX: "auto", fontFamily: theme["--mono"], fontSize: "12px", lineHeight: 1.6 },
  line: { display: "grid", gridTemplateColumns: "6ch minmax(max-content, 1fr)" },
});

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
