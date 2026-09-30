import type { DaemonError, Hunk } from "@gyst/core/wire";
import { createFileRoute, Link, notFound, useNavigate, useParams } from "@tanstack/react-router";
import { operation } from "../api.ts";
import { Crumb, DeleteSession, Frame } from "../components.tsx";

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
          <span className="grow" />
          <Link to="/" className="pill">
            All sessions
          </Link>
          {/* Keyed: switching sessions on this route starts a new deletion intent, never B's retry. */}
          <DeleteSession
            key={session.id}
            session={session}
            onDeleted={() => navigate({ to: "/" })}
          />
        </>
      }
      side={
        <>
          <p className="side-head">
            Changed files <span className="muted">{files.length}</span>
          </p>
          <ul className="file-list">
            {files.map(([file], index) => (
              <li key={file}>
                <button type="button" className="file-link" onClick={() => jump(index)}>
                  {file}
                </button>
              </li>
            ))}
          </ul>
        </>
      }
      status={
        <>
          <span className="mode">Plain diff</span>
          <span>
            {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"} in {files.length}{" "}
            {files.length === 1 ? "file" : "files"}
          </span>
          <span className="grow" />
          <span>
            session <code>{session.id}</code>
          </span>
        </>
      }
    >
      {files.length === 0 ? (
        <p className="muted">This session's snapshot has no changes.</p>
      ) : (
        // ponytail: renders every hunk at once; window/virtualize with the richer reader.
        files.map(([file, fileHunks], index) => (
          <FileDiff key={file} id={`file-${index}`} file={file} hunks={fileHunks} />
        ))
      )}
    </Frame>
  );
}

function FileDiff(props: { id: string; file: string; hunks: readonly Hunk[] }) {
  const slash = props.file.lastIndexOf("/");
  const lines = props.hunks.flatMap((hunk) => hunk.patch.split("\n").slice(1));
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  return (
    <section className="file" aria-labelledby={props.id}>
      <h2 className="file-head" id={props.id} tabIndex={-1}>
        <span className="name">{props.file.slice(slash + 1)}</span>
        {slash >= 0 && <span className="dir">{props.file.slice(0, slash + 1)}</span>}
        <span className="grow" />
        <span className="stat">
          <span className="add">+{added}</span> <span className="del">−{removed}</span>
        </span>
      </h2>
      {props.hunks.map((hunk) => (
        <HunkDiff key={hunk.id} hunk={hunk} />
      ))}
    </section>
  );
}

const lineKind = (line: string) =>
  line.startsWith("+")
    ? "add"
    : line.startsWith("-")
      ? "del"
      : line.startsWith("\\")
        ? "meta"
        : "context";

/** The captured `Hunk.patch`, rendered as text (React escapes it) with old/new line numbers. */
function HunkDiff({ hunk }: { hunk: Hunk }) {
  const [header = "", ...body] = hunk.patch.split("\n");
  const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(header);
  let oldLine = Number(start?.[1] ?? 0);
  let newLine = Number(start?.[2] ?? 0);
  return (
    <div className="hunk">
      <div className="hunk-line hunk-header">
        <span className="num" />
        <span className="num" />
        <span className="code">{header}</span>
      </div>
      {body.map((line, index) => {
        const kind = lineKind(line);
        const oldNumber = kind === "context" || kind === "del" ? oldLine++ : undefined;
        const newNumber = kind === "context" || kind === "add" ? newLine++ : undefined;
        return (
          // Index keys: the lines of one frozen patch never reorder.
          <div key={index} className={`hunk-line ${kind}`}>
            <span className="num">{oldNumber}</span>
            <span className="num">{newNumber}</span>
            <span className="code">{line}</span>
          </div>
        );
      })}
    </div>
  );
}

function SessionNotFound() {
  const { sessionId } = useParams({ strict: false });
  return (
    <Frame top={<h1 className="crumb">Session not found</h1>}>
      <p>
        No saved session has id <code>{sessionId}</code>. It may have been deleted.
      </p>
      <Link to="/">All saved sessions</Link>
    </Frame>
  );
}
