import { describe, expect, it } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { llmMiddleware } from "./start";

const negotiate = llmMiddleware.options.server!;
type NextFn = Parameters<typeof negotiate>[0]["next"];

async function run(pathname: string, accept: string) {
  const request = new Request(`http://docs.test${pathname}`, { headers: { accept } });
  const response = new Response("<html/>", { headers: { Vary: "Accept-Encoding" } });
  try {
    const result = await negotiate({
      request,
      pathname,
      context: undefined,
      handlerType: "router",
      next: (() => ({ request, pathname, context: undefined, response })) as NextFn,
    });
    return { response: (result as { response: Response }).response };
  } catch (thrown) {
    if (isRedirect(thrown)) return { redirect: thrown.options.href };
    throw thrown;
  }
}

describe("llmMiddleware", () => {
  it("redirects Markdown-preferring clients under /docs", async () => {
    expect(await run("/docs/test", "text/markdown")).toEqual({
      redirect: "http://docs.test/docs/test.md",
    });
    expect(await run("/docs", "text/markdown")).toEqual({
      redirect: "http://docs.test/docs/index.md",
    });
  });

  it("does not negotiate paths that merely share the /docs prefix", async () => {
    const { redirect, response } = await run("/docstest", "text/markdown");
    expect(redirect).toBeUndefined();
    expect(response?.headers.get("Vary")).toBe("Accept-Encoding");
  });

  it("appends Vary: Accept to the HTML representation", async () => {
    const { response } = await run("/docs/test", "text/html");
    expect(response?.headers.get("Vary")).toBe("Accept-Encoding, Accept");
  });
});
