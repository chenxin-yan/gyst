import type { Scope, SessionSummary } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { isExpectedFailure, newRequestId, operation, TransportError } from "./api.ts";
import { media, theme } from "./tokens.stylex.ts";

// ─── layout ──────────────────────────────────────────────────────────────

export function Frame(props: {
  top: ReactNode;
  side?: ReactNode;
  status?: ReactNode;
  /** The child fills the reading pane and scrolls itself, like the session reader. */
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(frame.app)}>
      <nav {...stylex.props(frame.side)} aria-label="gyst">
        <div {...stylex.props(frame.brand)}>
          <Link to="/" {...stylex.props(frame.brandName)}>
            gyst
          </Link>
        </div>
        {props.side}
      </nav>
      <div {...stylex.props(frame.panel)}>
        <header {...stylex.props(frame.top)}>{props.top}</header>
        <main {...stylex.props(frame.pane, props.fill && frame.fill)}>{props.children}</main>
        <footer {...stylex.props(frame.status)}>{props.status}</footer>
      </div>
    </div>
  );
}

// Narrow: the sidebar stacks above the panel and the reading pane keeps the width.
const frame = stylex.create({
  app: {
    height: "100%",
    display: "grid",
    gridTemplateColumns: { default: "264px minmax(0, 1fr)", [media.narrow]: "minmax(0, 1fr)" },
    gridTemplateRows: { default: null, [media.narrow]: "auto minmax(0, 1fr)" },
    backgroundColor: theme.frame,
    color: theme.ink,
    colorScheme: "dark",
    fontFamily: theme.sans,
    fontSize: "13px",
    fontWeight: 400,
    lineHeight: 1.5,
    WebkitFontSmoothing: "antialiased",
  },
  side: {
    minHeight: 0,
    maxHeight: { default: null, [media.narrow]: "30vh" },
    display: "flex",
    flexDirection: "column",
    padding: "8px 8px 12px",
    overflow: "auto",
    overscrollBehavior: "none",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    height: "44px",
    marginBottom: "6px",
    padding: "0 4px 0 10px",
  },
  brandName: {
    fontFamily: theme["--mono"],
    fontSize: "15px",
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: "-0.01em",
    color: theme.ink,
    textDecoration: "none",
  },
  panel: {
    position: "relative",
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "44px minmax(0, 1fr) minmax(30px, auto)",
    margin: { default: "8px 8px 8px 0", [media.narrow]: "0 8px 8px" },
    borderRadius: "10px",
    backgroundColor: theme.panelBg,
    boxShadow: `0 0 0 1px ${theme.line}`,
    overflow: "hidden",
  },
  top: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "0 12px 0 20px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: theme.line,
    minWidth: 0,
  },
  pane: {
    minHeight: 0,
    overflow: "auto",
    overscrollBehavior: "none",
    padding: { default: "24px 32px 120px", [media.narrow]: "16px 12px 80px" },
  },
  fill: { padding: 0, overflow: "hidden" },
  // Wraps rather than clips: a narrow panel puts the footer's controls on more rows.
  status: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 14px",
    padding: "5px 14px 5px 12px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: theme.line,
    fontFamily: theme["--mono"],
    fontSize: "11.5px",
    lineHeight: "normal",
    color: theme.muted,
    overflowWrap: "anywhere",
    overflow: "hidden",
  },
});

/** The page title in the top bar. */
export function Title(props: { title?: string; children: ReactNode }) {
  return (
    <h1 {...stylex.props(ui.title)} title={props.title}>
      {props.children}
    </h1>
  );
}

export function AllSessionsLink() {
  return (
    <Link to="/" {...stylex.props(ui.pill)}>
      All sessions
    </Link>
  );
}

export function PillButton(props: Omit<ComponentProps<"button">, "className" | "style">) {
  return <button type="button" {...props} {...stylex.props(ui.pill)} />;
}

const ui = stylex.create({
  muted: { color: theme.muted },
  faint: { color: theme.faint },
  title: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    fontSize: "13px",
    fontWeight: 500,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    height: "28px",
    padding: "0 10px",
    borderRadius: "7px",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
    fontSize: "12.5px",
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  smallCode: { fontSize: "12px" },
});

export const repoName = (repoRoot: string) => repoRoot.split("/").findLast(Boolean) ?? repoRoot;

/** `small` shrinks a range below the surrounding text, as in the top bar. */
export function ScopeLabel(props: { scope: Scope; small?: boolean }) {
  return props.scope.kind === "range" ? (
    <code {...stylex.props(props.small && ui.smallCode)}>{props.scope.range}</code>
  ) : props.scope.kind === "pr" ? (
    <code {...stylex.props(props.small && ui.smallCode)}>
      {props.scope.repository}#{props.scope.number}
    </code>
  ) : (
    <span>uncommitted changes</span>
  );
}

export function Crumb({ session }: { session: SessionSummary }) {
  return (
    <Title title={session.repoRoot}>
      <span {...stylex.props(ui.muted)}>{repoName(session.repoRoot)}</span>
      <span {...stylex.props(ui.faint)} aria-hidden="true">
        /
      </span>
      <ScopeLabel scope={session.scope} small />
    </Title>
  );
}

/** False once the component unmounted, so a late reply changes nothing. */
export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

// ─── deletion ────────────────────────────────────────────────────────────

/**
 * Deletes exactly this session after an explicit confirmation. The request id is minted when the
 * human confirms and kept for every retry of that intent, so a lost reply never deletes twice.
 * Callers key it by session id; a reply that settles after it unmounted (another session or page
 * is shown) changes nothing.
 */
export function DeleteSession(props: {
  session: SessionSummary;
  onDeleted: () => unknown;
  /** Opens the confirmation over the reading pane instead of in a row of its own. */
  popover?: boolean;
}) {
  const [requestId, setRequestId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const mounted = useMounted();
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
      <button
        type="button"
        {...stylex.props(ui.pill, deletion.danger)}
        onClick={() => setConfirming(true)}
      >
        Delete…
      </button>
    );
  return (
    <div
      {...stylex.props(deletion.confirm, props.popover && deletion.popover)}
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
      <div {...stylex.props(deletion.actions)}>
        <button
          type="button"
          {...stylex.props(ui.pill, deletion.strong)}
          disabled={pending}
          onClick={() => void submit(requestId ?? newRequestId())}
        >
          {pending ? "Deleting…" : requestId ? "Retry delete" : "Delete session"}
        </button>
        <button
          type="button"
          {...stylex.props(ui.pill)}
          disabled={pending}
          onClick={cancel}
          autoFocus
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const deletion = stylex.create({
  danger: { color: { default: theme.muted, ":hover": theme.del } },
  strong: { color: theme.del, boxShadow: `inset 0 0 0 1px ${theme.del}` },
  confirm: {
    flexBasis: "100%",
    display: "grid",
    gap: "8px",
    padding: "10px 12px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    whiteSpace: "normal",
  },
  popover: {
    position: "absolute",
    zIndex: 5,
    top: "52px",
    right: "16px",
    maxWidth: "min(480px, calc(100vw - 32px))",
    boxShadow: `0 0 0 1px ${theme.line}`,
  },
  actions: { display: "flex", gap: "8px" },
});

// ─── failures ────────────────────────────────────────────────────────────

/** Explains a failed request without echoing credentials; 401 gets relaunch guidance. */
export function FailureNotice({ error }: { error: unknown }) {
  if (error instanceof TransportError && error.reason === "unauthorized")
    return (
      <div role="alert" {...stylex.props(notice.box)}>
        <p>{error.message}</p>
        <p {...stylex.props(ui.muted, notice.next)}>
          Run <code>gyst</code> (or <code>gyst --session &lt;id&gt;</code>) in the repository again
          and open the new link it prints. A link signs a browser in within 10 minutes of launch;
          that browser then stays signed in until its gyst stops.
        </p>
      </div>
    );
  return (
    <p role="alert" {...stylex.props(notice.box)}>
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}

const notice = stylex.create({
  box: { maxWidth: "80ch", marginBottom: "14px" },
  next: { marginTop: "6px" },
});

export function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  const retryable = !(error instanceof TransportError && error.reason === "unauthorized");
  return (
    <Frame top={<Title>Couldn't load this page</Title>}>
      <FailureNotice error={error} />
      {retryable && (
        <button type="button" {...stylex.props(ui.pill)} onClick={() => void router.invalidate()}>
          Try again
        </button>
      )}
    </Frame>
  );
}

export function PageNotFound() {
  return (
    <Frame top={<Title>Page not found</Title>}>
      <p>gyst has no page at this address.</p>
      <Link to="/">All saved sessions</Link>
    </Frame>
  );
}
