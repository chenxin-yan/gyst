import { defineConfig } from "vite-plus";

// The browser viewer: `vp build src/web-ui` emits dist/web-ui/, which crust.include ships as the
// installed package's dist/web-ui/. Assets stay root-relative so deep links such as /session/<id>
// load them.
export default defineConfig({
  base: "/",
  build: { outDir: "../../dist/web-ui", emptyOutDir: true },
});
