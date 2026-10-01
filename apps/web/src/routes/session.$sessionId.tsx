import type { DaemonError, Hunk } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, notFound, useNavigate, useParams } from "@tanstack/react-router";
import { operation } from "../api.ts";
import { AllSessionsLink, Crumb, DeleteSession, Frame, Title } from "../components.tsx";
import { media, theme } from "../tokens.stylex.ts";

export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params: { sessionId } }) => {
    try {
      const [opened, diff] = await Promise.all([
        operation({ command: "open", session: sessionId }),
        operation({ command: "diff", session: sessionId }),
      ]);
      return { session: opened.session, hunks: diff.hunks };
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
  const { session, hunks } = Route.useLoaderData();
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
    // Spaces files apart; the pane holds only these sections.
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
