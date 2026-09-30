import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import "../styles.css";

export const Route = createRootRouteWithContext<{ signIn: () => Promise<unknown> }>()({
  // Runs before every child route loads, so no daemon operation precedes this launch's sign-in.
  beforeLoad: async ({ context }) => {
    await context.signIn();
  },
  component: Outlet,
});
