// The sidebar entry and main-panel card for the change author's own explanation: a PR session's
// description, or a recorded range session's captured commit messages. Derivations live in
// author.ts.
import type { CommitsPayload, DaemonError, PullRequest } from "@gyst/core/wire";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { isExpectedFailure, operation } from "./api.ts";
import { commitParts } from "./author.ts";
import { FailureNotice, PillButton, useMounted } from "./components.tsx";
import { RichText } from "./rich.tsx";
import { theme } from "./tokens.stylex.ts";

/** A link to the PR on GitHub, opened only by a click, in a new tab that cannot reach back. */
function GitHubLink(props: { href: string; number: number }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      {...stylex.props(styles.link)}
    >
      #{props.number} on GitHub
    </a>
  );
}

/**
 * The sidebar's entry above the walkthrough: it shows or hides the author's explanation above the
 * main panel's diff, and a PR's also links to the PR on GitHub.
 */
export function AuthorEntry(props: {
  label: "Description" | "Commits";
  /** How many commits the range has, once read. */
  count?: number | undefined;
  pullRequest?: { href: string; number: number } | undefined;
  open: boolean;
  /** The card's id, which the entry controls while it is shown. */
  controls: string;
  onToggle: () => void;
}) {
  return (
    <div {...stylex.props(styles.entry)}>
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls={props.open ? props.controls : undefined}
        onClick={props.onToggle}
        {...stylex.props(styles.row, props.open && styles.selected)}
      >
        <span {...stylex.props(styles.label)}>{props.label}</span>
        {props.count !== undefined && <span {...stylex.props(styles.count)}>{props.count}</span>}
      </button>
      {props.pullRequest && (
        <span {...stylex.props(styles.entryLink)}>
          <GitHubLink {...props.pullRequest} />
        </span>
      )}
    </div>
  );
}

const noReference = () => {};

/**
 * A PR's description as GitHub last reported it, under the shared rich-content policy as untrusted
 * text: raw HTML prints as text, images show only their alt text, only `http(s)` links open, and
 * only on a click. It pins no captured references, so a `gyst:` link in it is unavailable.
 */
export function DescriptionCard(props: { id: string; pullRequest: PullRequest; href: string }) {
  const { pullRequest } = props;
  return (
    <section id={props.id} aria-label="Pull request description" {...stylex.props(styles.card)}>
      <p {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.title)}>{pullRequest.title}</span>
        <GitHubLink href={props.href} number={pullRequest.number} />
      </p>
      {pullRequest.description.trim() !== "" ? (
        <RichText markdown={pullRequest.description} references={[]} onReference={noReference} />
      ) : (
        <p {...stylex.props(styles.missing)}>This pull request has no description.</p>
      )}
    </section>
  );
}

/** The commits read so far, oldest first, and where the next page starts. */
export type RangeCommits = {
  read: Pick<CommitsPayload, "commits" | "total" | "next"> | undefined;
  loading: boolean;
  failure: unknown;
  /** Reads the next page, or again the page that failed. */
  load: () => void;
};

/**
 * A range session's captured commits, read page by page from its snapshot once `wanted`: the first
 * page when the reader first shows them, later ones on request. Kept for the reader's life: they
 * are the snapshot's own, and a refresh starts another reader.
 */
export function useRangeCommits(sessionId: string, snapshotId: string, wanted: boolean) {
  const [read, setRead] = useState<RangeCommits["read"]>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const mounted = useMounted();
  const asking = useRef(false);
  const load = useCallback(
    (after: string | undefined) => {
      if (asking.current) return;
      asking.current = true;
      setLoading(true);
      setFailure(undefined);
      operation({
        command: "commits",
        session: sessionId,
        snapshotId,
        ...(after !== undefined && { after }),
      })
        .then(
          (page) =>
            mounted.current &&
            setRead((before) => ({
              commits: after === undefined ? page.commits : [...before!.commits, ...page.commits],
              total: page.total,
              next: page.next,
            })),
          (error: unknown) => {
            if (!isExpectedFailure(error)) console.error(error);
            if (mounted.current) setFailure(error);
          },
        )
        .finally(() => {
          asking.current = false;
          if (mounted.current) setLoading(false);
        });
    },
    [sessionId, snapshotId, mounted],
  );
  useEffect(() => {
    if (wanted && read === undefined && failure === undefined) load(undefined);
  }, [wanted, read, failure, load]);
  return {
    read,
    loading,
    failure,
    load: () => {
      if (read === undefined) load(undefined);
      else if (read.next !== null) load(read.next);
    },
  } satisfies RangeCommits;
}

const isStale = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === ("stale_revision" satisfies DaemonError["_tag"]);

/**
 * The commit messages a recorded range captured with its snapshot, oldest first, as plain text:
 * Git messages are not Markdown, so nothing in them is interpreted.
 */
export function CommitsCard(props: { id: string; range: string; commits: RangeCommits }) {
  const router = useRouter();
  const { read, loading, failure, load } = props.commits;
  return (
    <section id={props.id} aria-label="Commits" {...stylex.props(styles.card)}>
      <p {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.title)}>
          Commits in <code {...stylex.props(styles.mono)}>{props.range}</code>
        </span>
      </p>
      {read?.total === 0 ? (
        <p {...stylex.props(styles.missing)}>This range has no commits.</p>
      ) : (
        read && (
          <ol {...stylex.props(styles.commits)}>
            {read.commits.map((commit) => {
              const { subject, body } = commitParts(commit);
              return (
                <li key={commit.id} {...stylex.props(styles.commit)}>
                  <p>
                    <code title={commit.id} {...stylex.props(styles.mono, styles.id)}>
                      {commit.id.slice(0, 7)}
                    </code>{" "}
                    <span {...stylex.props(styles.subject)}>{subject}</span>
                  </p>
                  {body !== "" && <p {...stylex.props(styles.body)}>{body}</p>}
                </li>
              );
            })}
          </ol>
        )
      )}
      {loading && <p {...stylex.props(styles.missing)}>Loading commits…</p>}
      {failure !== undefined && (
        <>
          <FailureNotice error={failure} />
          {isStale(failure) ? (
            <PillButton onClick={() => void router.invalidate()}>Reload session</PillButton>
          ) : (
            <PillButton onClick={load}>Retry loading commits</PillButton>
          )}
        </>
      )}
      {!loading && failure === undefined && read !== undefined && read.next !== null && (
        <PillButton onClick={load}>
          Show more commits ({read.total - read.commits.length} more)
        </PillButton>
      )}
    </section>
  );
}

const styles = stylex.create({
  entry: { marginBottom: "10px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    minHeight: "26px",
    paddingInline: "10px",
    borderRadius: "6px",
    textAlign: "left",
    color: { default: theme.muted, ":hover": theme.ink },
    backgroundColor: { default: null, ":hover": theme.select },
  },
  selected: { color: theme.ink, backgroundColor: theme.select },
  label: { flex: "1", fontWeight: 500 },
  count: { fontFamily: theme["--mono"], fontSize: "11px", color: theme.faint },
  entryLink: { display: "block", paddingInline: "10px", fontSize: "12px" },
  link: {
    color: { default: theme["--accent"], ":hover": theme.ink },
    textDecoration: "underline",
  },
  card: {
    marginTop: "24px",
    padding: "12px 14px",
    borderRadius: "6px",
    backgroundColor: theme.surface,
    boxShadow: `0 0 0 1px ${theme.line}`,
    fontFamily: theme.sans,
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    marginBottom: "6px",
    fontSize: "12px",
  },
  title: { flex: "1", minWidth: 0, fontSize: "14px", fontWeight: 600, color: theme.ink },
  missing: { fontSize: "12px", color: theme.faint },
  mono: { fontFamily: theme["--mono"], fontSize: "12px" },
  commits: { display: "grid", gap: "10px", marginBlock: "8px" },
  commit: { minWidth: 0 },
  id: { color: theme.faint },
  subject: { color: theme.ink, fontWeight: 500 },
  body: {
    marginTop: "4px",
    color: theme.muted,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});
