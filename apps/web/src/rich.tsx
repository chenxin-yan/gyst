import type { CapturedRange } from "@gyst/core/wire";
import { getSharedHighlighter } from "@pierre/diffs";
import * as stylex from "@stylexjs/stylex";
import DOMPurify from "dompurify";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createDiagramQueue,
  type DiagramColors,
  linkOf,
  mermaidSource,
  referenceLabel,
  safeUrl,
} from "./rich.ts";
import { theme } from "./tokens.stylex.ts";

type MarkdownNode = { type: string; children?: MarkdownNode[] };

// react-markdown already prints raw HTML as text; doing it in the Markdown tree keeps that true
// whatever later plugins see.
const htmlAsText = () => (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(visit);
  };
  visit(tree);
};
const remarkPlugins = [remarkGfm, htmlAsText];

type HastElement = NonNullable<ExtraProps["node"]>;

/** A `pre > code` block's text, without the LF Markdown-to-HTML appends, and fence language. */
function fenceOf(node: HastElement | undefined): { code: string; lang: string | undefined } {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return { code: "", lang: undefined };
  const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  const classes = code.properties["className"];
  const lang = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith("language-"))
    : undefined;
  return { code: text.replace(/\n$/, ""), lang: lang?.slice("language-".length).toLowerCase() };
}

/**
 * Authored Markdown under the shared rich-content policy: GFM, no raw HTML or images, `http(s)`
 * links opened only by a click, and `gyst:` links that follow only this text's pinned references.
 */
export function RichText(props: {
  markdown: string;
  references: readonly CapturedRange[];
  onReference: (target: CapturedRange) => void;
}) {
  const { references, onReference } = props;
  const components = useMemo(
    (): Components => ({
      a: ({ href, children }) => {
        const link = linkOf(href, references);
        switch (link.kind) {
          case "external":
            return (
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                {...stylex.props(rich.link)}
              >
                {children}
              </a>
            );
          case "reference":
            return (
              <button
                type="button"
                title={referenceLabel(link.target)}
                onClick={() => onReference(link.target)}
                {...stylex.props(rich.link)}
              >
                {children}
              </button>
            );
          case "unavailable":
            return (
              <span title={`Unavailable: ${link.reason}`} {...stylex.props(rich.unavailable)}>
                {children}
              </span>
            );
          case "inert":
            return <span>{children}</span>;
        }
      },
      img: ({ alt }) => (alt ? <span>{alt}</span> : null),
      pre: ({ node }) => {
        const { code, lang } = fenceOf(node);
        return lang === "mermaid" ? (
          <MermaidDiagram source={code} />
        ) : (
          <HighlightedCode code={code} lang={lang} />
        );
      },
      p: ({ children }) => <p {...stylex.props(rich.block)}>{children}</p>,
      ul: ({ children, className }) => (
        <ul
          {...stylex.props(
            rich.block,
            rich.list,
            className?.includes("contains-task-list") ? rich.tasks : rich.bullets,
          )}
        >
          {children}
        </ul>
      ),
      ol: ({ children, start }) => (
        <ol start={start} {...stylex.props(rich.block, rich.list, rich.numbers)}>
          {children}
        </ol>
      ),
      blockquote: ({ children }) => (
        <blockquote {...stylex.props(rich.block, rich.quote)}>{children}</blockquote>
      ),
      table: ({ children }) => (
        <div {...stylex.props(rich.block, rich.tableBox)}>
          <table {...stylex.props(rich.table)}>{children}</table>
        </div>
      ),
      th: ({ children, style }) => (
        <th style={style} {...stylex.props(rich.cell, rich.head)}>
          {children}
        </th>
      ),
      td: ({ children, style }) => (
        <td style={style} {...stylex.props(rich.cell)}>
          {children}
        </td>
      ),
      code: ({ children }) => <code {...stylex.props(rich.inlineCode)}>{children}</code>,
    }),
    [references, onReference],
  );
  return (
    <div {...stylex.props(rich.body)}>
      <Markdown remarkPlugins={remarkPlugins} urlTransform={safeUrl} components={components}>
        {props.markdown}
      </Markdown>
    </div>
  );
}

// The theme the diff renderer highlights with, so fenced code matches the diff.
export const codeTheme = "catppuccin-mocha";

/**
 * Shiki tokens for `code` as React nodes, through the diff renderer's public shared highlighter;
 * rejects for a language Shiki does not bundle. Only Shiki's <code> is kept, inside the app's <pre>.
 */
export async function highlightedCode(code: string, lang: string): Promise<ReactNode> {
  const highlighter = await getSharedHighlighter({ themes: [codeTheme], langs: [lang] });
  const tree = highlighter.codeToHast(code, { lang, theme: codeTheme });
  return toJsxRuntime(tree, {
    Fragment,
    jsx,
    jsxs,
    components: { pre: ({ children }) => children },
  });
}

/** Fenced code, highlighted once Shiki is ready; plain for an unknown language or a failed load. */
export function HighlightedCode(props: { code: string; lang: string | undefined }) {
  const { code, lang } = props;
  const [highlighted, setHighlighted] = useState<{ code: string; lang: string; node: ReactNode }>();
  useEffect(() => {
    if (!lang || lang === "text") return;
    let current = true;
    highlightedCode(code, lang)
      .then((node) => {
        if (current) setHighlighted({ code, lang, node });
      })
      .catch(() => {
        // The plain block stays.
      });
    return () => {
      current = false;
    };
  }, [code, lang]);
  return (
    <pre {...stylex.props(rich.code)}>
      {highlighted?.code === code && highlighted.lang === lang ? (
        highlighted.node
      ) : (
        <code>{code}</code>
      )}
    </pre>
  );
}

const diagrams = createDiagramQueue(async () => (await import("mermaid")).default);

// StyleX tokens are `var(--name)` at runtime; Mermaid computes shades, so it needs real colours.
const resolved = (element: Element, token: string) => {
  const name = /^var\((--[\w-]+)\)$/.exec(token)?.[1];
  return name ? getComputedStyle(element).getPropertyValue(name).trim() : token;
};
const diagramColors = (element: Element): DiagramColors => ({
  background: resolved(element, theme.panelBg),
  surface: resolved(element, theme.surface),
  line: resolved(element, theme.line),
  ink: resolved(element, theme.ink),
  muted: resolved(element, theme.muted),
  accent: resolved(element, theme["--accent"]),
  font: resolved(element, theme.sans),
});

// Anything that would make the browser fetch: an external `url(…)` or a stylesheet import.
const fetches = /url\(\s*['"]?\s*(?!#)|@import/i;

/**
 * Mermaid's strict mode already sanitizes its SVG; this boundary is ours, because the app inserts
 * the markup itself. No links, embedded documents, images, references or scripts, and nothing
 * that loads a resource.
 */
function sanitizedDiagram(svg: string): DocumentFragment | undefined {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "image", "a", "use", "script"],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll("*")) {
    if (element.localName === "style" && fetches.test(element.textContent ?? "")) element.remove();
    else
      for (const name of element.getAttributeNames())
        if (fetches.test(element.getAttribute(name) ?? "")) element.removeAttribute(name);
  }
  return fragment.querySelector("svg") ? fragment : undefined;
}

type DiagramState = { readonly rendered: true } | { readonly error: string } | undefined;

/** A fenced `mermaid` block: its source while it renders, then the diagram or the error and source. */
function MermaidDiagram(props: { source: string }) {
  const { source } = props;
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DiagramState>();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    element.replaceChildren();
    setState(undefined);
    const stripped = mermaidSource(source);
    if ("error" in stripped) {
      setState({ error: stripped.error });
      return;
    }
    const slot = {};
    diagrams.request(slot, stripped.source, diagramColors(element), (outcome) => {
      const fragment = "svg" in outcome ? sanitizedDiagram(outcome.svg) : undefined;
      if (fragment) {
        element.replaceChildren(fragment);
        setState({ rendered: true });
      } else setState({ error: "error" in outcome ? outcome.error : "The diagram is not SVG." });
    });
    return () => diagrams.release(slot);
  }, [source]);
  return (
    <div {...stylex.props(rich.block)}>
      <div
        ref={host}
        role="img"
        aria-label="Diagram"
        hidden={state === undefined || !("rendered" in state)}
        {...stylex.props(rich.diagram)}
      />
      {state === undefined ? (
        <pre {...stylex.props(rich.code)}>
          <code>{source}</code>
        </pre>
      ) : "error" in state ? (
        <details open>
          <summary {...stylex.props(rich.failure)}>Diagram failed: {state.error}</summary>
          <pre {...stylex.props(rich.code)}>
            <code>{source}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}

const rich = stylex.create({
  body: {
    color: theme.ink,
    fontSize: "13px",
    lineHeight: 1.55,
    overflowWrap: "anywhere",
  },
  block: {
    marginBlock: { default: "0 8px", ":last-child": 0 },
  },
  list: { paddingInlineStart: "20px" },
  bullets: { listStyleType: "disc" },
  numbers: { listStyleType: "decimal" },
  tasks: { listStyleType: "none", paddingInlineStart: "4px" },
  quote: {
    marginInline: 0,
    paddingInlineStart: "10px",
    borderInlineStartWidth: "2px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: theme.line,
    color: theme.muted,
  },
  tableBox: { overflowX: "auto" },
  table: { borderCollapse: "collapse", fontSize: "12.5px" },
  cell: {
    paddingBlock: "3px",
    paddingInline: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: theme.line,
    textAlign: "start",
  },
  head: { fontWeight: 600, backgroundColor: theme.surface },
  inlineCode: {
    fontFamily: theme["--mono"],
    fontSize: "0.92em",
    paddingInline: "4px",
    borderRadius: "4px",
    backgroundColor: theme.surface,
  },
  code: {
    marginBlock: { default: "0 8px", ":last-child": 0 },
    marginInline: 0,
    paddingBlock: "8px",
    paddingInline: "10px",
    overflowX: "auto",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: theme.line,
    fontFamily: theme["--mono"],
    fontSize: "12px",
    lineHeight: 1.5,
    color: theme.ink,
    backgroundColor: theme.surface,
  },
  link: {
    color: theme["--accent"],
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  unavailable: {
    color: theme.faint,
    textDecoration: "line-through",
  },
  diagram: { overflowX: "auto" },
  failure: { color: theme.del },
});
