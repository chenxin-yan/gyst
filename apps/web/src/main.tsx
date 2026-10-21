import * as stylex from "@stylexjs/stylex";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { isExpectedFailure } from "./api.ts";
import { Frame, PageNotFound, RouteError } from "./components.tsx";
import { routeTree } from "./routeTree.gen.ts";
import { theme } from "./tokens.stylex.ts";

const styles = stylex.create({ muted: { color: theme.muted } });

const router = createRouter({
  routeTree,
  // Every visit reads the daemon again, so a list never shows a session deleted meanwhile.
  defaultGcTime: 0,
  defaultPendingComponent: () => (
    <Frame top={<span {...stylex.props(styles.muted)}>Loading…</span>}>
      <p role="status" {...stylex.props(styles.muted)}>
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
