import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrap, isExpectedFailure } from "./api.ts";
import { createAppRouter, FailureNotice } from "./routes.tsx";

// The launch URL's fragment is this launch's bootstrap secret. Take it out of the address bar and
// history before any request is sent or the router reads the location.
const secret = location.hash.slice(1);
if (location.href.includes("#"))
  history.replaceState(history.state, "", location.pathname + location.search);

const root = createRoot(document.getElementById("root")!, {
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
      <RouterProvider router={createAppRouter()} />
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
