import { walkthroughPlaceholder, walkthroughSlotId } from "@gyst/core/web";
import { defineConfig, type Plugin } from "vite-plus";
import { viewerPlugins } from "./vite.config.ts";

// A standalone walkthrough runs only its own inline code over its own data: it may load nothing
// and contact nothing, the daemon included. Shiki compiles its inlined WebAssembly grammar engine;
// Mermaid's SVG and the diff renderer style themselves with <style>.
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
].join("; ");

/** Adds the embedded faces' stylesheet before Vite bundles the page, so the live viewer lacks it. */
const standaloneFonts = (): Plugin => ({
  name: "gyst:standalone-fonts",
  transformIndexHtml: {
    order: "pre",
    handler: () => [
      { tag: "link", attrs: { rel: "stylesheet", href: "/src/fonts.css" }, injectTo: "head" },
    ],
  },
});

/**
 * Makes the build one self-contained document: the policy and the data slot go first in <head>,
 * and the bundle's one script and its stylesheets are inlined, their files dropped.
 */
const standaloneHtml = (): Plugin => ({
  name: "gyst:standalone-html",
  enforce: "post",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy },
      injectTo: "head-prepend",
    },
    {
      tag: "script",
      attrs: { type: "application/json", id: walkthroughSlotId },
      children: walkthroughPlaceholder,
      injectTo: "head",
    },
  ],
  generateBundle(_, bundle) {
    const page = bundle["index.html"];
    if (page?.type !== "asset") throw new Error("the export build has no index.html");
    let html = String(page.source);
    for (const [name, output] of Object.entries(bundle)) {
      if (name === "index.html") continue;
      const tag =
        output.type === "chunk"
          ? new RegExp(`<script type="module" crossorigin src="[^"]*${name}"></script>`)
          : name.endsWith(".css")
            ? new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${name}">`)
            : undefined;
      if (tag === undefined || !tag.test(html))
        throw new Error(`the export build emitted ${name}, which its index.html does not load`);
      // Inside an inline script, `<!--` would start HTML's escaped script state, in which a later
      // `<script` in a string keeps the element's own end tag from closing it. The minifier
      // already writes `</script` as `<\/script`.
      // Vite fills each dynamic import's preload list where it rewrites the import; the inlined
      // ones are no longer imports, so their lists are left empty here (`void 0`, as Vite writes).
      const text =
        output.type === "chunk"
          ? output.code.replaceAll("<!--", "\\x3C!--").replaceAll("__VITE_PRELOAD__", "void 0")
          : String(output.source);
      if ((output.type === "chunk" ? /<\/script/i : /<\/style/i).test(text))
        throw new Error(`${name} would close its inline element early`);
      html = html.replace(tag, () =>
        output.type === "chunk"
          ? `<script type="module">${text}</script>`
          : `<style>${text}</style>`,
      );
      delete bundle[name];
    }
    page.source = html;
  },
});

// `vp build --config vite.export.config.ts` emits dist-export/index.html, the template the daemon
// fills with an export's data and @gyst/cli ships as dist/export/.
export default defineConfig({
  base: "./",
  mode: "export",
  plugins: [...viewerPlugins, standaloneFonts(), standaloneHtml()],
  build: {
    outDir: "dist-export",
    assetsInlineLimit: () => true,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
