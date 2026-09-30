import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { operation } from "../api.ts";
import { DeleteSession, Frame, repoName, ScopeLabel, Title } from "../components.tsx";
import { theme } from "../tokens.stylex.ts";

export const Route = createFileRoute("/")({
  loader: () => operation({ command: "list" }),
  component: SessionsPage,
});

function SessionsPage() {
  const { sessions } = Route.useLoaderData();
  const router = useRouter();
  return (
    <Frame
      top={<Title>Saved sessions</Title>}
      status={`${sessions.length} saved ${sessions.length === 1 ? "session" : "sessions"}`}
    >
      {sessions.length === 0 ? (
        <p {...stylex.props(styles.muted)}>
          No saved sessions. Run <code>gyst</code> in a repository to review its changes.
        </p>
      ) : (
        <ul {...stylex.props(styles.sessions)} aria-label="Saved sessions">
          {sessions.map((session) => (
            <li key={session.id} {...stylex.props(styles.row)}>
              <Link
                to="/session/$sessionId"
                params={{ sessionId: session.id }}
                {...stylex.props(styles.link, stylex.defaultMarker())}
              >
                <span {...stylex.props(styles.name)}>
                  {repoName(session.repoRoot)} <span {...stylex.props(styles.faint)}>/</span>{" "}
                  <ScopeLabel scope={session.scope} />
                </span>
                <span {...stylex.props(styles.meta)}>{session.repoRoot}</span>
                <span {...stylex.props(styles.meta)}>
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

const styles = stylex.create({
  muted: { color: theme.muted },
  faint: { color: theme.faint },
  sessions: { display: "grid", gap: "8px", maxWidth: "960px" },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    padding: "8px 8px 8px 14px",
    borderRadius: "6px",
    boxShadow: `0 0 0 1px ${theme.line}`,
  },
  link: {
    flex: "1",
    display: "grid",
    minWidth: 0,
    color: theme.ink,
    textDecoration: "none",
  },
  name: {
    fontWeight: 500,
    color: { default: null, [stylex.when.ancestor(":hover")]: theme["--accent"] },
  },
  meta: {
    color: theme.faint,
    fontSize: "12px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
