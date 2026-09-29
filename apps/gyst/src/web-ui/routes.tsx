import type { DaemonError, Hunk, Scope, SessionSummary } from "@gyst/core/wire";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  notFound,
  Outlet,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isExpectedFailure, newRequestId, operation, TransportError } from "./api.ts";

const rootRoute = createRootRoute({ component: Outlet });

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: () => operation({ command: "list" }),
  component: SessionsPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session/$sessionId",
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

export const createAppRouter = () =>
  createRouter({
    routeTree: rootRoute.addChildren([sessionsRoute, sessionRoute]),
    // Every visit reads the daemon again, so a list never shows a session deleted meanwhile.
    defaultGcTime: 0,
    defaultPendingComponent: () => (
      <Frame top={<span className="muted">Loading…</span>}>
        <p role="status" className="muted">
          Loading…
        </p>
      </Frame>
    ),
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: PageNotFound,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

const isDaemonError = (error: unknown, tag: DaemonError["_tag"]) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;

// ─── layout ──────────────────────────────────────────────────────────────

function Frame(props: {
  top: ReactNode;
  side?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app f-mocha">
      <nav className="side" aria-label="gyst">
        <div className="brand">
          <Link to="/" className="brand-name">
            gyst
          </Link>
        </div>
        {props.side}
      </nav>
      <main className="panel">
        <header className="top">{props.top}</header>
        <div className="pane">{props.children}</div>
        <footer className="status">{props.status}</footer>
      </main>
    </div>
  );
}

const repoName = (repoRoot: string) => repoRoot.split("/").findLast(Boolean) ?? repoRoot;

function ScopeLabel({ scope }: { scope: Scope }) {
  return scope.kind === "range" ? <code>{scope.range}</code> : <span>uncommitted changes</span>;
}

function Crumb({ session }: { session: SessionSummary }) {
  return (
    <h1 className="crumb" title={session.repoRoot}>
      <span className="muted">{repoName(session.repoRoot)}</span>
      <span className="slash" aria-hidden="true">
        /
      </span>
      <ScopeLabel scope={session.scope} />
    </h1>
  );
}

// ─── saved sessions ──────────────────────────────────────────────────────

function SessionsPage() {
  const { sessions } = sessionsRoute.useLoaderData();
  const router = useRouter();
  return (
    <Frame
      top={<h1 className="crumb">Saved sessions</h1>}
      status={`${sessions.length} saved ${sessions.length === 1 ? "session" : "sessions"}`}
    >
      {sessions.length === 0 ? (
        <p className="muted">
          No saved sessions. Run <code>gyst</code> in a repository to review its changes.
        </p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => (
            <li key={session.id} className="session-row">
              <Link
                to="/session/$sessionId"
                params={{ sessionId: session.id }}
                className="session-link"
              >
                <span className="session-name">
                  {repoName(session.repoRoot)} <span className="slash">/</span>{" "}
                  <ScopeLabel scope={session.scope} />
                </span>
                <span className="session-meta">{session.repoRoot}</span>
                <span className="session-meta">
                  Updated {new Date(session.updatedAt).toLocaleString()}
                </span>
              </Link>
              <DeleteSession session={session} onDeleted={() => router.invalidate()} />
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ─── one session ─────────────────────────────────────────────────────────

function SessionPage() {
  const { session, hunks } = sessionRoute.useLoaderData();
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

// ─── deletion ────────────────────────────────────────────────────────────

/**
 * Deletes exactly this session after an explicit confirmation. The request id is minted when the
 * human confirms and kept for every retry of that intent, so a lost reply never deletes twice.
 * Callers key it by session id; a reply that settles after it unmounted (another session or page
 * is shown) changes nothing.
 */
function DeleteSession(props: { session: SessionSummary; onDeleted: () => unknown }) {
  const [requestId, setRequestId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const cancel = () => {
    setConfirming(false);
    setRequestId(undefined);
    setFailure(undefined);
  };
  const submit = async (id: string) => {
    setRequestId(id);
    setPending(true);
    setFailure(undefined);
    try {
      await operation({ command: "delete", session: props.session.id, requestId: id });
      if (mounted.current) await props.onDeleted();
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (!confirming)
    return (
      <button type="button" className="pill danger" onClick={() => setConfirming(true)}>
        Delete…
      </button>
    );
  return (
    <div
      className="confirm"
      role="group"
      aria-label="Confirm session deletion"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) cancel();
      }}
    >
      <p>
        Delete saved session <code>{props.session.id}</code> (
        <ScopeLabel scope={props.session.scope} />
        )? Other sessions are kept.
      </p>
      {failure !== undefined && <FailureNotice error={failure} />}
      <div className="confirm-actions">
        <button
          type="button"
          className="pill danger strong"
          disabled={pending}
          onClick={() => void submit(requestId ?? newRequestId())}
        >
          {pending ? "Deleting…" : requestId ? "Retry delete" : "Delete session"}
        </button>
        <button type="button" className="pill" disabled={pending} onClick={cancel} autoFocus>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── failures ────────────────────────────────────────────────────────────

/** Explains a failed request without echoing credentials; 401 gets relaunch guidance. */
export function FailureNotice({ error }: { error: unknown }) {
  if (error instanceof TransportError && error.reason === "unauthorized")
    return (
      <div role="alert" className="notice">
        <p>{error.message}</p>
        <p className="muted">
          Run <code>gyst</code> (or <code>gyst --session &lt;id&gt;</code>) in the repository again
          and open the new link it prints. A link signs a browser in within 10 minutes of launch;
          that browser then stays signed in until its gyst stops.
        </p>
      </div>
    );
  return (
    <p role="alert" className="notice">
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}

function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  const retryable = !(error instanceof TransportError && error.reason === "unauthorized");
  return (
    <Frame top={<h1 className="crumb">Couldn't load this page</h1>}>
      <FailureNotice error={error} />
      {retryable && (
        <button type="button" className="pill" onClick={() => void router.invalidate()}>
          Try again
        </button>
      )}
    </Frame>
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

function PageNotFound() {
  return (
    <Frame top={<h1 className="crumb">Page not found</h1>}>
      <p>gyst has no page at this address.</p>
      <Link to="/">All saved sessions</Link>
    </Frame>
  );
}
