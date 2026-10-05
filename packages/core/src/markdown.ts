import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { type CodeRange, parseReferenceHref } from "./guidance.ts";

/** What authored Markdown links to and what the shared rich-content policy refuses in it. */
export type MarkdownInspection = {
  /** Every distinct `gyst:` reference, in document order of first appearance. */
  readonly references: CodeRange[];
  readonly problems: string[];
};

// The URL is already entity-decoded by the parser, so `&#106;avascript:` arrives as `javascript:`.
const isWebUrl = (url: string) => {
  if (!/^https?:\/\/[^/\s]/i.test(url) || !URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
};

// Mermaid reads its configuration from `%%{…}%%` directives and from leading `---` frontmatter.
const mermaidDirective = /%%\s*\{/;
const mermaidFrontmatter = /^\s*---/;

/**
 * Parses `text` as the renderer does (CommonMark plus GFM), so both agree on what is a link.
 * Links and definitions must be absolute `http(s)` URLs or valid `gyst:` references; images and
 * configured Mermaid diagrams are refused. Raw HTML is allowed because it renders as text, and
 * code is never searched for links.
 */
export function inspectMarkdown(text: string): MarkdownInspection {
  const references = new Map<string, CodeRange>();
  const problems: string[] = [];
  const visit = (node: Nodes) => {
    const at = `line ${node.position?.start.line ?? 1}`;
    if (node.type === "image" || node.type === "imageReference")
      problems.push(`${at}: images are not allowed`);
    else if (node.type === "link" || node.type === "definition") {
      const reference = node.url.startsWith("gyst:") ? parseReferenceHref(node.url) : undefined;
      if (reference)
        references.set(
          `${reference.side}\0${reference.path}\0${reference.startLine}\0${reference.endLine}`,
          reference,
        );
      else if (node.url.startsWith("gyst:"))
        problems.push(
          `${at}: reference ${JSON.stringify(node.url)} must be gyst:<old|new>/<path>#L<start>[-L<end>]`,
        );
      else if (!isWebUrl(node.url))
        problems.push(
          `${at}: link ${JSON.stringify(node.url)} must be an absolute http(s) URL or a gyst: reference`,
        );
    } else if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
      if (mermaidDirective.test(node.value))
        problems.push(`${at}: Mermaid diagrams may not carry %%{ }%% directives`);
      if (mermaidFrontmatter.test(node.value))
        problems.push(`${at}: Mermaid diagrams may not carry --- frontmatter`);
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return { references: [...references.values()], problems };
}
