import type { PullRequest } from "@gyst/core/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { commitParts } from "./author.ts";
import { CommitsCard, DescriptionCard, type RangeCommits } from "./author.tsx";

// StyleX compiles away in the app build; Node renders the same markup without its classes.
vi.mock("@stylexjs/stylex", () => ({
  create: (styles: object) => styles,
  defineVars: (vars: object) => vars,
  defineConsts: (consts: object) => consts,
  props: () => ({}),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ invalidate: async () => {} }),
}));

const pullRequest: PullRequest = {
  number: 12,
  title: "Add widgets",
  description: "",
  state: "open",
  url: "javascript:alert(1)",
  baseRefName: "main",
  headRefName: "widgets",
};
const description = (text: string) =>
  renderToStaticMarkup(
    createElement(DescriptionCard, {
      id: "author",
      pullRequest: { ...pullRequest, description: text },
      href: "https://github.com/acme/widgets/pull/12",
    }),
  );
const commit = (char: string, message: string) => ({ id: char.repeat(40), message });
const commits = (read: RangeCommits["read"]) =>
  renderToStaticMarkup(
    createElement(CommitsCard, {
      id: "author",
      range: "main..feature",
      commits: { read, loading: false, failure: undefined, load: () => {} },
    }),
  );

describe("author helpers", () => {
  it("splits a commit message into its subject and body", () => {
    expect(commitParts(commit("a", "Subject"))).toEqual({ subject: "Subject", body: "" });
    expect(commitParts(commit("a", "Subject\n\n\nBody\n\n- one"))).toEqual({
      subject: "Subject",
      body: "Body\n\n- one",
    });
  });
});

describe("DescriptionCard", () => {
  it("renders a hostile description as untrusted rich text that fetches nothing", () => {
    const out = description(
      [
        '<img src="https://tracker.invalid/pixel.png" onerror="alert(1)">',
        "",
        "![remote](https://tracker.invalid/image.png)",
        "",
        "[run](javascript:alert(1)) [data](data:text/html,x) [code](gyst:new/a.ts#L1)",
        "",
        "[docs](https://example.com/docs)",
      ].join("\n"),
    );
    expect(out).not.toMatch(/<(img|script|iframe)[\s>]/);
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:text");
    expect(out).toContain("&lt;img src=");
    // An image shows its alt text; nothing names its URL as a source.
    expect(out).toContain("<span>remote</span>");
    expect(out).not.toContain("image.png");
    // A description pins no captured references.
    expect(out).toContain('title="Unavailable: not a validated reference"');
    expect(out).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
    );
  });

  it("links to the PR built from the session's scope, never GitHub's reported url", () => {
    const out = description("Why.");
    expect(out).toContain('href="https://github.com/acme/widgets/pull/12"');
    expect(out).toContain(">#12 on GitHub</a>");
    expect(out).not.toContain("javascript:alert");
    expect(out).toContain("Add widgets");
  });

  it("says so when the PR has no description", () => {
    for (const blank of ["", "  \n\t"])
      expect(description(blank)).toContain("This pull request has no description.");
  });
});

describe("CommitsCard", () => {
  it("shows commit messages oldest first as plain text", () => {
    const out = commits({
      commits: [
        commit("a", "Add <b>bold</b> **widgets**\n\nWhy:\n  - callers repeat it"),
        commit("b", "Second"),
      ],
      total: 2,
      next: null,
    });
    expect(out).toMatch(/>aaaaaaa<\/code>[^]*>bbbbbbb<\/code>/);
    expect(out).toContain("Add &lt;b&gt;bold&lt;/b&gt; **widgets**");
    expect(out).toContain("Why:\n  - callers repeat it");
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("Show more commits");
  });

  it("offers the next page and says so when the range has no commits", () => {
    expect(commits({ commits: [commit("a", "One")], total: 3, next: "a".repeat(40) })).toContain(
      "Show more commits (2 more)",
    );
    expect(commits({ commits: [], total: 0, next: null })).toContain("This range has no commits.");
  });
});
