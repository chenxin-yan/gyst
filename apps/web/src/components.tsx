import type { Scope, SessionSummary } from "@gyst/core/wire";
import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isExpectedFailure, newRequestId, operation, TransportError } from "./api.ts";

// ─── layout ──────────────────────────────────────────────────────────────

export function Frame(props: {
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

export const repoName = (repoRoot: string) => repoRoot.split("/").findLast(Boolean) ?? repoRoot;

export function ScopeLabel({ scope }: { scope: Scope }) {
  return scope.kind === "range" ? <code>{scope.range}</code> : <span>uncommitted changes</span>;
}

export function Crumb({ session }: { session: SessionSummary }) {
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

// ─── deletion ────────────────────────────────────────────────────────────

/**
 * Deletes exactly this session after an explicit confirmation. The request id is minted when the
 * human confirms and kept for every retry of that intent, so a lost reply never deletes twice.
 * Callers key it by session id; a reply that settles after it unmounted (another session or page
 * is shown) changes nothing.
 */
export function DeleteSession(props: { session: SessionSummary; onDeleted: () => unknown }) {
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

export function RouteError({ error }: { error: unknown }) {
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

export function PageNotFound() {
  return (
    <Frame top={<h1 className="crumb">Page not found</h1>}>
      <p>gyst has no page at this address.</p>
      <Link to="/">All saved sessions</Link>
    </Frame>
  );
}
