import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// `vp build` emits dist/, which @gyst/cli copies into its package as dist/web-ui/. Assets stay
// root-relative so deep links such as /session/<id> load them.
export default defineConfig({
  base: "/",
  run: { tasks: { "build:task": "vp build" } },
  plugins: [
    // The quote and semicolon options make the generated routeTree.gen.ts match the repo format.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      quoteStyle: "double",
      semicolons: true,
    }),
    viteReact(),
  ],
});
