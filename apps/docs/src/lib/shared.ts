import { createGetUrl } from "fumadocs-core/source";

export const appName = "Tanstack Start";
export const docsRoute = "/docs";

export const gitConfig = {
  user: "chenxin-yan",
  repo: "gyst",
  branch: "main",
};

const getDocsUrl = createGetUrl(docsRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string | undefined }) {
  const segments = [...page.slugs];
  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  return { segments, url: getDocsUrl(segments, page.locale) };
}

/** @returns page slugs */
export function decodeMarkdownUrl(segments: string[]) {
  if (segments.length === 0) return [];

  const out = segments.map((segment, i) =>
    i === segments.length - 1 ? segment.replace(/\.md$/, "") : segment,
  );
  if (out.length === 1 && out[0] === "index") out.pop();
  return out;
}
