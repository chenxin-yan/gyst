// PROTOTYPE, throwaway. Agent notes as Markdown with Mermaid diagrams. The production recommendation
// (react-markdown + official Mermaid, docs/research/markdown-mermaid.md) is unchanged; this DOM-only
// prototype uses Marked + DOMPurify for the same policy: no raw HTML, no remote media, no author
// diagram config, and a visible source fallback when a diagram can't render.
import DOMPurify from "dompurify";
import { marked } from "marked";

export const escapeHTML = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

type InlineParser = { parser: { parseInline(tokens: unknown[]): string } };
marked.use({
  renderer: {
    html: ({ text }) => escapeHTML(text),
    image: ({ text }) => escapeHTML(text),
    // `gyst:` links are agent-authored snapshot references; other links stay text until the
    // external-link policy is decided.
    link(this: InlineParser, { href, tokens }: { href: string; tokens: unknown[] }) {
      const inner = this.parser.parseInline(tokens);
      return href.startsWith("gyst:")
        ? `<button type="button" class="ref" data-ref="${escapeHTML(href)}">${inner}</button>`
        : inner;
    },
  } as never,
});

export function markdownHTML(source: string) {
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string, {
    ALLOWED_TAGS: ["p", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "button"],
    ALLOWED_ATTR: ["class", "type", "data-ref", "start"],
  });
}

// Mermaid is large, so it loads only when a note contains a diagram.
let mermaidModule: Promise<typeof import("mermaid")> | undefined;
let configuredFor = "";
let queue: Promise<unknown> = Promise.resolve();
let nextId = 1;
const diagrams = new Map<string, string | Promise<string>>();

// Diagram colours come from the app's Catppuccin roles, read off a probe so they follow the flavor.
function palette(flavor: string) {
  const probe = document.createElement("div");
  probe.className = `app f-${flavor}`;
  probe.hidden = true;
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const color = (name: string) => style.getPropertyValue(`--ctp-${name}`).trim();
  const colors = {
    darkMode: flavor !== "latte",
    background: color("base"),
    primaryColor: color("mantle"),
    primaryTextColor: color("text"),
    primaryBorderColor: color("lavender"),
    lineColor: color("lavender"),
    secondaryColor: color("base"),
    tertiaryColor: color("mantle"),
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "13px",
  };
  probe.remove();
  return colors;
}

async function renderDiagram(source: string, flavor: string): Promise<string> {
  try {
    if (/^\s*---(?:\s|$)/.test(source) || /%%\s*\{/.test(source))
      throw new Error("Diagram configuration belongs to the app. Remove frontmatter or directives.");
    const { default: mermaid } = await (mermaidModule ??= import("mermaid"));
    if (configuredFor !== flavor) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        suppressErrorRendering: true,
        maxTextSize: 5000,
        maxEdges: 100,
        secure: ["securityLevel", "htmlLabels", "maxTextSize", "maxEdges", "suppressErrorRendering", "theme", "themeVariables", "fontFamily", "dompurifyConfig"],
        theme: "base",
        themeVariables: palette(flavor),
      });
      configuredFor = flavor;
    }
    await mermaid.parse(source);
    const { svg } = await mermaid.render(`note-diagram-${nextId++}`, source);
    const safe = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "image", "a"],
    });
    // Mermaid sizes the SVG to 100% of its container; pin it to its natural size so a small
    // diagram isn't blown up to the note's width (CSS still shrinks it to fit).
    const svgElement = new DOMParser().parseFromString(safe, "image/svg+xml").documentElement;
    const [, , width, height] = (svgElement.getAttribute("viewBox") ?? "").split(/\s+/);
    if (width && height) {
      svgElement.setAttribute("width", width);
      svgElement.setAttribute("height", height);
      svgElement.removeAttribute("style");
    }
    return `<div class="note-diagram">${svgElement.outerHTML}</div>`;
  } catch (error) {
    return `<details class="diagram-error" open><summary>Diagram could not render</summary><p>${escapeHTML((error as Error).message)}</p><pre>${escapeHTML(source)}</pre></details>`;
  }
}

// Replaces each ```mermaid block under `root`. Renders run one at a time (Mermaid shares global
// state) and are cached, so repainting a note never re-renders an unchanged diagram.
export function hydrateDiagrams(root: HTMLElement, flavor: string) {
  for (const code of root.querySelectorAll("pre > code.language-mermaid")) {
    const block = code.parentElement!;
    const source = code.textContent ?? "";
    const key = `${flavor}\n${source}`;
    let result = diagrams.get(key);
    if (result === undefined) {
      const pending: Promise<string> = queue.then(() => renderDiagram(source, flavor));
      queue = pending;
      diagrams.set(key, pending);
      pending.then((html) => diagrams.set(key, html));
      result = pending;
    }
    if (typeof result === "string") block.outerHTML = result;
    // A newer paint of the note replaces `block`; only a block still in place takes the result.
    else result.then((html) => root.contains(block) && (block.outerHTML = html));
  }
}
