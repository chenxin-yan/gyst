import type { PullRequestStatus } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { isExpectedFailure, operation } from "./api.ts";
import { FailureNotice, PillButton, useMounted } from "./components.tsx";
import { type StackRow, stackRows, triggerLabel, verificationText } from "./stack.ts";
import { media, theme } from "./tokens.stylex.ts";

const moves = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * The header's native stack switcher: a compact trigger and a non-modal dialog listing the stack's
 * PRs in layer order. An opened layer links to its saved session; an unopened one says so and
 * opens it from this session's stack. The review keys ignore keydowns while a dialog is open, so
 * ↑/↓/Home/End here move between the rows and Escape closes it, giving focus back to the trigger.
 */
export function StackSwitcher(props: {
  sessionId: string;
  pullRequest: PullRequestStatus;
  /** The selected session's settled Viewed hunk count, newer than `pullRequest` after its writes. */
  viewedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogId = useId();

  // Non-modal: a press outside closes it without taking focus anywhere.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!dialog.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!moves.includes(event.key)) return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>("[data-stack-item]") ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? Math.min(at + 1, last)
            : Math.max(at - 1, 0);
    items[next]?.focus();
  };

  return (
    <span {...stylex.props(styles.anchor)} onKeyDown={onKeyDown}>
      <PillButton
        ref={trigger}
        title="Native GitHub PR stack"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((before) => !before)}
      >
        {triggerLabel(props.pullRequest)}
      </PillButton>
      {open && (
        <StackDialog
          id={dialogId}
          dialog={dialog}
          sessionId={props.sessionId}
          pullRequest={props.pullRequest}
          viewedCount={props.viewedCount}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function StackDialog(props: {
  id: string;
  dialog: RefObject<HTMLDialogElement | null>;
  sessionId: string;
  pullRequest: PullRequestStatus;
  viewedCount: number;
  onClose: () => void;
}) {
  const { dialog, sessionId, pullRequest } = props;
  const navigate = useNavigate();
  const mounted = useMounted();
  const [opening, setOpening] = useState<number>();
  const [rechecking, setRechecking] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const rows = stackRows(pullRequest, props.viewedCount);

  useEffect(() => {
    const node = dialog.current!;
    node.show();
    (
      node.querySelector<HTMLElement>("[aria-current] [data-stack-item]") ??
      node.querySelector<HTMLElement>("[data-stack-item]")
    )?.focus();
    return () => node.close();
  }, [dialog]);

  // Captures the layer's current PR range as a plain session, or resumes its saved one as it is.
  const openLayer = async (number: number) => {
    setOpening(number);
    setFailure(undefined);
    try {
      const opened = await operation({ command: "layer", session: sessionId, number });
      if (mounted.current)
        await navigate({ to: "/session/$sessionId", params: { sessionId: opened.session.id } });
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setOpening(undefined);
    }
  };

  // Metadata only: the new context is announced, and the page's live read shows it.
  const recheck = async () => {
    setRechecking(true);
    setFailure(undefined);
    try {
      await operation({ command: "stack", session: sessionId });
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (mounted.current) setFailure(error);
    } finally {
      if (mounted.current) setRechecking(false);
    }
  };

  const busy = opening !== undefined || rechecking;
  const label = (row: StackRow) => (
    <>
      <span {...stylex.props(styles.number)}>#{row.number}</span>{" "}
      <span {...stylex.props(styles.title)}>{row.title}</span>
    </>
  );
  return (
    <dialog
      ref={dialog}
      id={props.id}
      aria-label="Native PR stack"
      {...stylex.props(styles.dialog)}
    >
      <ol {...stylex.props(styles.rows)}>
        {rows.map((row) => (
          <li
            key={row.number}
            aria-current={row.current ? "page" : undefined}
            {...stylex.props(styles.row, row.current && styles.current)}
          >
            <span {...stylex.props(styles.position)}>{row.position ?? ""}</span>
            {row.session ? (
              <Link
                to="/session/$sessionId"
                params={{ sessionId: row.session.id }}
                data-stack-item=""
                onClick={props.onClose}
                {...stylex.props(styles.name, styles.link)}
              >
                {label(row)}
              </Link>
            ) : (
              <span {...stylex.props(styles.name)}>{label(row)}</span>
            )}
            <span {...stylex.props(styles.badge, styles[row.state])}>{row.state}</span>
            {row.session ? (
              <span {...stylex.props(styles.count)}>
                Viewed {row.session.viewed}/{row.session.total}{" "}
                {row.session.total === 1 ? "hunk" : "hunks"}
              </span>
            ) : (
              <span {...stylex.props(styles.count)}>
                Not opened
                <PillButton
                  data-stack-item=""
                  disabled={busy}
                  onClick={() => void openLayer(row.number)}
                >
                  {opening === row.number ? `Opening #${row.number}…` : `Open #${row.number}`}
                </PillButton>
              </span>
            )}
          </li>
        ))}
      </ol>
      {failure !== undefined && <FailureNotice error={failure} />}
      <div {...stylex.props(styles.verification)}>
        <p role="status" {...stylex.props(styles.verified)}>
          {verificationText(pullRequest, new Date())}
        </p>
        <PillButton disabled={busy} onClick={() => void recheck()}>
          {rechecking ? "Rechecking…" : "Recheck stack"}
        </PillButton>
      </div>
    </dialog>
  );
}

const styles = stylex.create({
  // On a narrow screen the trigger sits too far right for the dialog to fit beside it, so the
  // dialog spans the clipping panel under its header instead.
  anchor: {
    position: { default: "relative", [media.narrow]: "static" },
    display: "inline-flex",
    flexShrink: 0,
  },
  dialog: {
    position: "absolute",
    zIndex: 5,
    top: { default: "calc(100% + 8px)", [media.narrow]: "52px" },
    left: { default: 0, [media.narrow]: "8px" },
    right: { default: "auto", [media.narrow]: "8px" },
    margin: 0,
    width: { default: "max-content", [media.narrow]: "auto" },
    minWidth: { default: "320px", [media.narrow]: 0 },
    maxWidth: { default: "min(560px, calc(100vw - 32px))", [media.narrow]: "none" },
    maxHeight: "60vh",
    overflow: "auto",
    padding: "6px",
    borderWidth: 0,
    borderRadius: "8px",
    backgroundColor: theme.surface,
    color: theme.ink,
    boxShadow: `0 0 0 1px ${theme.line}, 0 12px 32px rgba(0, 0, 0, 0.45)`,
    whiteSpace: "normal",
  },
  rows: { display: "grid", gap: "2px", margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr) auto auto",
    alignItems: "center",
    gap: "10px",
    minHeight: "32px",
    padding: "0 4px 0 8px",
    borderRadius: "6px",
  },
  current: { backgroundColor: theme.select, boxShadow: `inset 2px 0 0 ${theme["--accent"]}` },
  position: { color: theme.faint, fontFamily: theme["--mono"], fontSize: "11.5px" },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.ink,
  },
  link: { textDecoration: { default: "none", ":hover": "underline" } },
  number: { color: theme.muted, fontFamily: theme["--mono"], fontSize: "12px" },
  title: { fontWeight: 500 },
  badge: {
    padding: "1px 6px",
    borderRadius: "4px",
    boxShadow: "inset 0 0 0 1px currentColor",
    fontSize: "11px",
  },
  open: { color: theme.add },
  merged: { color: theme["--accent"] },
  closed: { color: theme.del },
  count: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: theme.muted,
    fontSize: "12px",
    whiteSpace: "nowrap",
  },
  verification: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginTop: "6px",
    padding: "6px 4px 2px 8px",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: theme.line,
  },
  verified: { flex: "1", color: theme.muted, fontSize: "12px" },
});
