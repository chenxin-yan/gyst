import stylex from "@stylexjs/unplugin/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/** The viewer's plugins, which the standalone export build (vite.export.config.ts) shares. */
export const viewerPlugins = [
  // The quote and semicolon options make the generated routeTree.gen.ts match the repo format.
  tanstackRouter({
    target: "react",
    autoCodeSplitting: true,
    quoteStyle: "double",
    semicolons: true,
  }),
  // Before the React plugin, which keeps Fast Refresh. The build appends StyleX's CSS to the
  // stylesheet routes/__root.tsx imports, after Vite minified it, so lightningcss minifies it.
  stylex({
    useCSSLayers: true,
    runtimeInjection: false,
    lightningcssOptions: { minify: true },
    // Hashed defineVars names derive from file paths relative to this root.
    unstable_moduleResolution: { type: "commonJS", rootDir: import.meta.dirname },
  }),
  viteReact(),
];

// `vp build` emits dist/, which @gyst/cli copies into its package as dist/web-ui/. Assets stay
// root-relative so deep links such as /session/<id> load them.
export default defineConfig({
  base: "/",
  run: { tasks: { "build:task": "vp build && vp build --config vite.export.config.ts" } },
  plugins: viewerPlugins,
});
