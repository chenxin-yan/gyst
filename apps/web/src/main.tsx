import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { bootstrap, isExpectedFailure } from "./api.ts";
import { FailureNotice, Frame, PageNotFound, RouteError } from "./components.tsx";
import { routeTree } from "./routeTree.gen.ts";

// The launch URL's fragment is this launch's bootstrap secret. Take it out of the address bar and
// history before any request is sent or the router reads the location.
const secret = location.hash.slice(1);
if (location.href.includes("#"))
  history.replaceState(history.state, "", location.pathname + location.search);

const router = createRouter({
  routeTree,
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
    router: typeof router;
  }
}

const root = ReactDOM.createRoot(document.getElementById("app")!, {
  // Route error views explain expected failures; everything else keeps its console diagnostic.
  onCaughtError: (error) => {
    if (!isExpectedFailure(error)) console.error(error);
  },
});

async function start() {
  // A reload or a second tab carries no secret; the launch cookie set earlier authorizes it.
  if (secret) await bootstrap(secret);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

start().catch((error: unknown) => {
  if (!isExpectedFailure(error)) console.error(error);
  root.render(
    <main className="app f-mocha standalone">
      <FailureNotice error={error} />
    </main>,
  );
});
