import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { operation } from "../api.ts";
import { DeleteSession, Frame, repoName, ScopeLabel } from "../components.tsx";

export const Route = createFileRoute("/")({
  loader: () => operation({ command: "list" }),
  component: SessionsPage,
});

function SessionsPage() {
  const { sessions } = Route.useLoaderData();
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
