// Exporting the walkthrough from the live viewer, and the standalone file's own stamp. The dialog
// shows exactly what the file would disclose and generates it only for that approved state.
import {
  type ExportPreviewPayload,
  type PinnedSide,
  provenanceLines,
  readinessProblems,
} from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import { isExpectedFailure, operation } from "./api.ts";
import { Dialog } from "./commands.tsx";
import { FailureNotice, PillButton, ScopeLabel, Title, useMounted } from "./components.tsx";
import { embeddedExport } from "./standalone.ts";
import { theme } from "./tokens.stylex.ts";

const isStale = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "stale_revision";

/** A side as the manifest lists it: its content identity and size, or why it has no bytes. */
const sideIdentity = ({ content }: PinnedSide) =>
  content.kind === "text"
    ? `sha256 ${content.blob.slice(0, 12)} · ${content.size} bytes`
    : content.kind === "absent"
      ? "absent"
      : `not captured: ${content.reason}`;

const rangeLabel = (target: ExportPreviewPayload["unavailable"][number]["target"]) =>
  `${target.path}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} (${target.side})`;

/** Hands `html` to the browser as a download named `name`; the browser decides where it lands. */
function download(html: string, name: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Previews what an export of the session would share, then generates it for exactly that state
 * once the human approves. A change meanwhile refuses the approval and shows the new preview,
 * which needs approving again.
 */
export function ExportDialog(props: { sessionId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<ExportPreviewPayload>();
  const [failure, setFailure] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  const [reads, setReads] = useState(0);
  const mounted = useMounted();
  useEffect(() => {
    let current = true;
    setPreview(undefined);
    operation({ command: "preview", session: props.sessionId }).then(
      (shown) => current && setPreview(shown),
      (error: unknown) => {
        if (!isExpectedFailure(error)) console.error(error);
        if (current) setFailure(error);
      },
    );
    return () => {
      current = false;
    };
  }, [props.sessionId, reads]);

  const approve = async (approval: string) => {
    setPending(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const file = await operation({ command: "export", session: props.sessionId, approval });
      if (!mounted.current) return;
      download(file.html, file.name);
      setNotice(`Your browser is saving ${file.name}. Check its downloads for the file.`);
    } catch (error) {
      if (!isExpectedFailure(error)) console.error(error);
      if (!mounted.current) return;
      if (isStale(error)) {
        setNotice(
          "The walkthrough changed since this preview, so nothing was exported. Review what it would share now and approve again.",
        );
        setReads((n) => n + 1);
      } else setFailure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const problems = preview && readinessProblems(preview.preparation);
  const earlier = preview?.included.filter(({ snapshotId }) => snapshotId !== preview.snapshotId);
  return (
    <Dialog label="Export the walkthrough" onClose={props.onClose}>
      <div {...stylex.props(styles.box)}>
        <h2 {...stylex.props(styles.title)}>Export the walkthrough</h2>
        {notice && (
          <p role="status" {...stylex.props(styles.notice)}>
            {notice}
          </p>
        )}
        {failure !== undefined && <FailureNotice error={failure} />}
        {preview === undefined && failure === undefined && (
          <p role="status">Reading what it would share…</p>
        )}
        {preview && preview.approval === null && (
          <section aria-label="Not ready to export">
            <p>This walkthrough can't be exported until the agent finishes it:</p>
            <ul {...stylex.props(styles.list)}>
              {problems!.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </section>
        )}
        {preview && preview.approval !== null && (
          <>
            <p role="alert" {...stylex.props(styles.warning)}>
              The file contains every listed file in full and all of the walkthrough's guidance.
              Full files and guidance may disclose secrets or confidential content. Check them
              before you share the file; gyst does not scan or redact anything.
            </p>
            <section aria-label="Provenance">
              <ul {...stylex.props(styles.list)}>
                {provenanceLines(preview.scope, preview.provenance).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                <li>
                  Snapshot <code>{preview.snapshotId}</code>
                </li>
              </ul>
            </section>
            <section aria-label="Included files">
              <h3 {...stylex.props(styles.heading)}>
                Included: {preview.included.length} file{" "}
                {preview.included.length === 1 ? "side" : "sides"}
              </h3>
              <ul {...stylex.props(styles.manifest)}>
                {preview.included.map((side) => (
                  <li key={`${side.snapshotId}:${side.path}:${side.side}`}>
                    <code>{side.path}</code> {side.side}
                    {side.snapshotId !== preview.snapshotId && (
                      <>
                        {" "}
                        · earlier snapshot <code>{side.snapshotId.slice(0, 12)}</code>
                      </>
                    )}{" "}
                    <span {...stylex.props(styles.muted)}>· {sideIdentity(side)}</span>
                  </li>
                ))}
              </ul>
              {earlier !== undefined && earlier.length > 0 && (
                <p {...stylex.props(styles.muted)}>
                  Earlier-snapshot sides are included only because guidance references them.
                </p>
              )}
            </section>
            {preview.unavailable.length > 0 && (
              <section aria-label="Unavailable references">
                <h3 {...stylex.props(styles.heading)}>
                  Unavailable references: shown in the export with their reason
                </h3>
                <ul {...stylex.props(styles.manifest)}>
                  {preview.unavailable.map(({ target, reason }) => (
                    <li key={JSON.stringify(target)}>
                      <code>{rangeLabel(target)}</code>{" "}
                      <span {...stylex.props(styles.muted)}>· {reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <div {...stylex.props(styles.actions)}>
          {preview?.approval && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void approve(preview.approval!)}
              {...stylex.props(styles.approve)}
            >
              {pending ? "Exporting…" : "Approve and download"}
            </button>
          )}
          <PillButton autoFocus onClick={props.onClose}>
            {notice?.startsWith("Your browser") ? "Close" : "Cancel"}
          </PillButton>
        </div>
      </div>
    </Dialog>
  );
}

/** A standalone file's title: its scope, and when it was exported, with its full provenance. */
export function StandaloneTitle() {
  const { walkthrough, exportedAt, gyst } = embeddedExport();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Title>
        <span {...stylex.props(styles.muted)}>Walkthrough</span>
        <span {...stylex.props(styles.faint)} aria-hidden="true">
          /
        </span>
        <ScopeLabel scope={walkthrough.scope} small />
      </Title>
      <PillButton onClick={() => setOpen(true)}>
        Exported {new Date(exportedAt).toLocaleString()}
      </PillButton>
      {open && (
        <Dialog label="About this export" onClose={() => setOpen(false)}>
          <div {...stylex.props(styles.box)}>
            <h2 {...stylex.props(styles.title)}>About this export</h2>
            <ul {...stylex.props(styles.list)}>
              {provenanceLines(walkthrough.scope, walkthrough.provenance).map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li>
                Snapshot <code>{walkthrough.snapshotId}</code>
              </li>
              <li>
                Exported <time dateTime={exportedAt}>{exportedAt}</time> by gyst {gyst}
              </li>
            </ul>
            <p {...stylex.props(styles.muted)}>
              A read-only copy: it has no conversations or reading progress, and it changes nothing.
            </p>
            <div {...stylex.props(styles.actions)}>
              <PillButton autoFocus onClick={() => setOpen(false)}>
                Close
              </PillButton>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

const styles = stylex.create({
  box: { display: "grid", gap: "12px", padding: "20px 22px", overflowWrap: "anywhere" },
  title: { fontSize: "14px", fontWeight: 500 },
  heading: { fontSize: "13px", fontWeight: 500, marginBottom: "6px" },
  list: { display: "grid", gap: "4px", margin: 0, paddingLeft: "18px" },
  manifest: {
    display: "grid",
    gap: "2px",
    maxHeight: "30vh",
    overflow: "auto",
    margin: 0,
    paddingLeft: "18px",
    fontSize: "12px",
  },
  muted: { color: theme.muted },
  faint: { color: theme.faint },
  notice: { color: theme.ink },
  warning: {
    padding: "8px 10px",
    borderRadius: "6px",
    boxShadow: `inset 0 0 0 1px ${theme.del}`,
    color: theme.ink,
  },
  actions: { display: "flex", gap: "8px", justifyContent: "flex-end" },
  approve: {
    height: "28px",
    padding: "0 12px",
    borderRadius: "7px",
    color: theme.ink,
    boxShadow: `inset 0 0 0 1px ${theme["--accent"]}`,
  },
});
