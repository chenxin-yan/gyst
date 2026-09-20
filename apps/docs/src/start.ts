import { createMiddleware, createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { redirect } from "@tanstack/react-router";
import { docsRoute, getPageMarkdownUrl } from "@/lib/shared";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const llmMiddleware = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  const isDocsUrl = url.pathname === docsRoute || url.pathname.startsWith(docsRoute + "/");

  if (!isDocsUrl || url.pathname.endsWith(".md")) return next();

  if (isMarkdownPreferred(request)) {
    const slugs = url.pathname
      .slice(docsRoute.length)
      .split("/")
      .filter((v) => v.length > 0);
    url.pathname = getPageMarkdownUrl({ slugs }).url;

    // this URL has two representations, selected by `Accept`
    throw redirect({ href: url.href, headers: { Vary: "Accept" } });
  }

  const result = await next();
  // the HTML representation is also `Accept`-selected; caches must not serve it to Markdown clients
  result.response.headers.append("Vary", "Accept");
  return result;
});

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [csrfMiddleware, llmMiddleware],
  };
});
