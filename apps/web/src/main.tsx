import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { bootstrap, isExpectedFailure } from "./api.ts";
import { Frame, PageNotFound, RouteError } from "./components.tsx";
import { routeTree } from "./routeTree.gen.ts";

// The launch URL's fragment is this launch's bootstrap secret. Take it out of the address bar and
// history before any request is sent or the router reads the location.
const secret = location.hash.slice(1);
if (location.href.includes("#"))
  history.replaceState(history.state, "", location.pathname + location.search);

// A reload or a second tab carries no secret; the launch cookie set earlier authorizes it. A failed
// exchange is retried by the next load, since the secret stays valid for its ten minutes.
let signedIn: Promise<unknown> | undefined;
const signIn = () =>
  (signedIn ??= secret
    ? bootstrap(secret).catch((error: unknown) => {
        signedIn = undefined;
        throw error;
      })
    : Promise.resolve());

const router = createRouter({
  routeTree,
  context: { signIn },
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

const rootElement = document.getElementById("app")!;

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement, {
    // Route error views explain expected failures; everything else keeps its console diagnostic.
    onCaughtError: (error) => {
      if (!isExpectedFailure(error)) console.error(error);
    },
  });
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
