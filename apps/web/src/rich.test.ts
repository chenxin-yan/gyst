import type { CapturedRange } from "@gyst/core/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createDiagramQueue,
  type DiagramColors,
  type DiagramEngine,
  type DiagramOutcome,
  linkOf,
  mermaidConfig,
  mermaidSource,
  referenceLabel,
  safeUrl,
} from "./rich.ts";
import { highlightedCode, RichText } from "./rich.tsx";

// StyleX compiles away in the app build; Node renders the same markup without its classes.
vi.mock("@stylexjs/stylex", () => ({
  create: (styles: object) => styles,
  defineVars: (vars: object) => vars,
  defineConsts: (consts: object) => consts,
  props: () => ({}),
}));

const pinned: CapturedRange = {
  snapshotId: "s".repeat(64),
  path: "src/a b.ts",
  side: "new",
  startLine: 40,
  endLine: 52,
};
const html = (markdown: string, references: readonly CapturedRange[] = [pinned]) =>
  renderToStaticMarkup(createElement(RichText, { markdown, references, onReference: () => {} }));

describe("RichText", () => {
  it("prints raw HTML as text, never as elements", () => {
    const out = html(
      [
        '<img src=x onerror="alert(1)">',
        "",
        "<script>alert(1)</script>",
        "",
        'Inline <a href="javascript:alert(1)">x</a> and <b onclick="x()">bold</b>.',
        "",
        '<iframe src="https://example.com"></iframe>',
      ].join("\n"),
    );
    expect(out).not.toMatch(/<(img|script|a|b|iframe)[\s>]/);
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Each HTML block reads as its own paragraph; inline HTML stays in its paragraph.
    expect(out).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(out).toContain("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
    expect(out).toContain("<p>Inline &lt;a href=");
    expect(out).toContain("&lt;a href=&quot;javascript:alert(1)&quot;&gt;");
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/);
  });

  it("drops every URL that is not http(s) or gyst, so its link is inert", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "mailto:a@example.com",
      "//example.com",
      "/abs",
      "relative",
      "#fragment",
      "https:example.com",
    ]) {
      const out = html(`[x](<${url}>) [y][r]\n\n[r]: <${url}>`);
      expect(out, url).not.toContain("href");
      expect(out, url).not.toContain("<a");
      expect(out, url).not.toContain("<button");
    }
    expect(html("<javascript:alert(1)>")).not.toContain("href");
  });

  it("renders images as their alt text without fetching them", () => {
    const out = html(
      "![a cat](https://example.com/cat.png) ![](data:image/png;base64,AA==) ![ref][i]\n\n[i]: https://example.com/i.png",
    );
    expect(out).not.toMatch(/<img|src=|example\.com|data:/);
    expect(out).toContain("a cat");
    expect(out).toContain("ref");
  });

  it("opens external links in a new tab without opener or referrer", () => {
    const out = html("[docs](https://example.com/a?b=1) and https://example.org/x");
    expect(out).toContain(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
    );
    expect(out).toContain(
      '<a href="https://example.org/x" target="_blank" rel="noopener noreferrer nofollow">https://example.org/x</a>',
    );
  });

  it("follows only pinned references; other gyst links are unavailable, never links", () => {
    const out = html(
      [
        "[pinned](gyst:new/src/a%20b.ts#L40-L52)",
        "[other range](gyst:new/src/a%20b.ts#L40-L53)",
        "[other side](gyst:old/src/a%20b.ts#L40-L52)",
        "[malformed](gyst:new/../x#L1)",
      ].join(" "),
    );
    expect(out).toContain('<button type="button" title="src/a b.ts:L40–52 · new">pinned</button>');
    for (const text of ["other range", "other side", "malformed"])
      expect(out).toContain(`<span title="Unavailable: not a validated reference">${text}</span>`);
    expect(out).not.toContain("href");
    expect(html("[pinned](gyst:new/src/a%20b.ts#L40-L52)", [])).not.toContain("<button");
  });

  it("renders GFM tables, task lists, strikethrough and autolinks", () => {
    const out = html(
      [
        "| a | b |",
        "| :- | -: |",
        "| 1 | 2 |",
        "",
        "- [x] done",
        "- [ ] open",
        "",
        "~~gone~~ www.example.com",
      ].join("\n"),
    );
    expect(out).toMatch(/<table>.*<th style="text-align:left">a<\/th>/s);
    expect(out).toContain('<td style="text-align:right">2</td>');
    expect(out).toMatch(/<input type="checkbox" disabled="" checked=""\/> ?done/);
    expect(out).toContain("<del>gone</del>");
    expect(out).toContain('href="http://www.example.com"');
  });

  it("shows fenced code as plain, escaped text until it is highlighted", () => {
    const out = html(
      "```ts\nconst a = '<b>';\n```\n\n```nosuchlanguage\nx < y\n```\n\n    indented",
    );
    expect(out).toContain("<pre><code>const a = &#x27;&lt;b&gt;&#x27;;</code></pre>");
    expect(out).toContain("<pre><code>x &lt; y</code></pre>");
    expect(out).toContain("<pre><code>indented</code></pre>");
  });

  it("shows a Mermaid diagram's source while it loads", () => {
    const out = html("Before\n\n```mermaid\ngraph TD\n  a --> b\n```\n\nAfter");
    expect(out).toContain("<pre><code>graph TD\n  a --&gt; b</code></pre>");
    expect(out).toContain("<p>Before</p>");
    expect(out).toContain("<p>After</p>");
  });
});

describe("linkOf", () => {
  it("classifies hrefs", () => {
    expect(linkOf(undefined, [pinned])).toEqual({ kind: "inert" });
    expect(linkOf("", [pinned])).toEqual({ kind: "inert" });
    expect(linkOf("https://example.com", [])).toEqual({
      kind: "external",
      href: "https://example.com",
    });
    expect(linkOf("ftp://example.com", [])).toEqual({ kind: "inert" });
    expect(linkOf("gyst:new/src/a%20b.ts#L40-L52", [pinned])).toEqual({
      kind: "reference",
      target: pinned,
    });
    expect(linkOf("gyst:new/src/a%20b.ts#L40", [pinned])).toEqual({
      kind: "unavailable",
      reason: "not a validated reference",
    });
  });

  it("keeps only http(s) and gyst URLs", () => {
    expect(safeUrl("https://a.example")).toBe("https://a.example");
    expect(safeUrl("gyst:new/a#L1")).toBe("gyst:new/a#L1");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:,x")).toBe("");
  });

  it("labels a range with its path, lines and side", () => {
    expect(referenceLabel(pinned)).toBe("src/a b.ts:L40–52 · new");
    expect(referenceLabel({ ...pinned, side: "old", endLine: 40 })).toBe("src/a b.ts:L40 · old");
  });
});

describe("mermaidSource", () => {
  const diagram = "graph TD\n  a --> b";

  it("strips frontmatter and directives in every spelling", () => {
    for (const text of [
      `---\nconfig:\n  theme: forest\n---\n${diagram}`,
      `\n\n  ---\nconfig: {securityLevel: loose}\n  ---\n${diagram}`,
      `---\n---\n${diagram}`,
      `---\r\ntitle: x\r\n---\r\n${diagram}`,
      `%%{init: {"securityLevel": "loose"}}%%\n${diagram}`,
      `%% { init: { "theme": "dark" } } %%\n${diagram}`,
      `%%{\n  init: {\n    "themeCSS": "x"\n  }\n}%%\n${diagram}`,
      `%%{wrap}%%\n${diagram}`,
      `graph TD\n%%{init: {"theme": "dark"}}%%\n  a --> b`,
      `%%{init}%%\n---\nconfig: {}\n---\n${diagram}`,
    ])
      expect(mermaidSource(text), text).toEqual({
        source: expect.not.stringMatching(/%%\s*\{|^\s*---|theme|loose|init|config|wrap/),
      });
    expect(mermaidSource(`%%{init: {}}%%\n${diagram}`)).toEqual({ source: diagram });
  });

  it("does not let removing one directive join its neighbours into another", () => {
    const result = mermaidSource(`%%%{a}%%%{init: {"theme": "dark"}}%%\n${diagram}`);
    expect(result).toEqual({ source: diagram });
  });

  it("drops an unclosed directive to the end and refuses unclosed frontmatter or nothing", () => {
    expect(mermaidSource(`${diagram}\n%%{init: {"theme": "dark"}`)).toEqual({
      source: `${diagram}\n`,
    });
    expect(mermaidSource(`---\nconfig: {}\n${diagram}`)).toEqual({
      error: "The diagram starts with unclosed frontmatter.",
    });
    expect(mermaidSource(`%%{init: {}}%%\n  `)).toEqual({ error: "The diagram is empty." });
  });

  it("refuses shape data and author styling instead of handing them to Mermaid", () => {
    expect(mermaidSource('flowchart LR\n  A@{ img: "https://example.com/p.png" }')).toEqual({
      error: "Mermaid diagrams may not carry @{ } shape data, which can load images.",
    });
    expect(mermaidSource(`%%{init: {}}%%\n${diagram}\n  style a fill:#f00`)).toEqual({
      error: 'Mermaid diagrams may not carry author styling: "style".',
    });
  });

  it("refuses math and participant data, which load images before any SVG exists to sanitize", () => {
    expect(
      mermaidSource(
        'sequenceDiagram\n  participant A as <img src="http://127.0.0.1:9/m.png"> $$x$$',
      ),
    ).toEqual({ error: "Mermaid diagrams may not carry $$ math, which can load images." });
    expect(
      mermaidSource(
        'sequenceDiagram\n  participant A\n  properties A: {"icon":"http://127.0.0.1:9/i.svg"}',
      ),
    ).toEqual({
      error:
        'Mermaid diagrams may not carry participant links or properties, which can load images: "properties".',
    });
  });

  it("keeps ordinary comments and source", () => {
    expect(mermaidSource(`${diagram}\n%% a comment`)).toEqual({
      source: `${diagram}\n%% a comment`,
    });
  });
});

const colors: DiagramColors = {
  background: "#1e1e2e",
  surface: "#181825",
  line: "#313244",
  ink: "#cdd6f4",
  muted: "#a6adc8",
  accent: "#b4befe",
  font: "Inter",
};

describe("mermaidConfig", () => {
  it("is strict, label-safe, bounded and themed from app colours only", () => {
    const config = mermaidConfig(colors);
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "Inter",
    });
    expect(config.maxTextSize).toBeGreaterThan(0);
    expect(config.maxEdges).toBeGreaterThan(0);
    expect(config.secure).toEqual(
      expect.arrayContaining([
        "secure",
        "securityLevel",
        "htmlLabels",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "dompurifyConfig",
        "theme",
        "themeVariables",
        "themeCSS",
      ]),
    );
    expect(config).not.toHaveProperty("themeCSS");
    const used = new Set(Object.values(colors));
    for (const [name, value] of Object.entries(config.themeVariables as Record<string, unknown>))
      if (name !== "darkMode") expect(used.has(value as string), name).toBe(true);
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake Mermaid whose renders finish only when the test says so. */
function fakeEngine() {
  const calls: { id: string; text: string; done: PromiseWithResolvers<{ svg: string }> }[] = [];
  const configs: unknown[] = [];
  const engine: DiagramEngine = {
    initialize: (config) => configs.push(config),
    render: (id, text) => {
      const done = Promise.withResolvers<{ svg: string }>();
      calls.push({ id, text, done });
      return done.promise;
    },
  };
  return { engine, calls, configs };
}

describe("createDiagramQueue", () => {
  it("loads Mermaid once, lazily, and renders one diagram at a time", async () => {
    const { engine, calls, configs } = fakeEngine();
    const load = vi.fn(() => Promise.resolve(engine));
    const queue = createDiagramQueue(load);
    expect(load).not.toHaveBeenCalled();
    const got: DiagramOutcome[] = [];
    void queue.render("graph A", colors).then((outcome) => got.push(outcome));
    void queue.render("graph B", colors).then((outcome) => got.push(outcome));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls.map(({ text }) => text)).toEqual(["graph A"]);
    calls[0]!.done.resolve({ svg: "<svg>A</svg>" });
    await settle();
    expect(calls.map(({ text }) => text)).toEqual(["graph A", "graph B"]);
    expect(calls[0]!.id).not.toBe(calls[1]!.id);
    calls[1]!.done.resolve({ svg: "<svg>B</svg>" });
    await settle();
    expect(got).toEqual([{ svg: "<svg>A</svg>" }, { svg: "<svg>B</svg>" }]);
    expect(configs).toEqual([mermaidConfig(colors)]);
  });

  it("caches outcomes per palette and source", async () => {
    const { engine, calls, configs } = fakeEngine();
    const queue = createDiagramQueue(() => Promise.resolve(engine));
    const got: DiagramOutcome[] = [];
    void queue.render("graph A", colors).then((outcome) => got.push(outcome));
    await settle();
    calls[0]!.done.resolve({ svg: "<svg>A</svg>" });
    await settle();
    void queue.render("graph A", colors).then((outcome) => got.push(outcome));
    await settle();
    expect(calls).toHaveLength(1);
    expect(got).toEqual([{ svg: "<svg>A</svg>" }, { svg: "<svg>A</svg>" }]);

    const light = { ...colors, background: "#eff1f5" };
    void queue.render("graph A", light).then((outcome) => got.push(outcome));
    await settle();
    expect(calls).toHaveLength(2);
    expect(configs).toEqual([mermaidConfig(colors), mermaidConfig(light)]);
  });

  it("keeps a failed render's error and goes on to the next diagram", async () => {
    const { engine, calls } = fakeEngine();
    const queue = createDiagramQueue(() => Promise.resolve(engine));
    const got: DiagramOutcome[] = [];
    void queue.render("graph bad", colors).then((outcome) => got.push(outcome));
    void queue.render("graph good", colors).then((outcome) => got.push(outcome));
    await settle();
    calls[0]!.done.reject(new Error("Parse error on line 1"));
    await settle();
    calls[1]!.done.resolve({ svg: "<svg>good</svg>" });
    await settle();
    expect(got).toEqual([{ error: "Parse error on line 1" }, { svg: "<svg>good</svg>" }]);
  });

  it("gives every waiting request the load failure, then loads again on the next one", async () => {
    const { engine, calls } = fakeEngine();
    const load = vi
      .fn<() => Promise<DiagramEngine>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValue(engine);
    const queue = createDiagramQueue(load);
    const got: DiagramOutcome[] = [];
    void queue.render("graph A", colors).then((outcome) => got.push(outcome));
    void queue.render("graph B", colors).then((outcome) => got.push(outcome));
    await settle();
    expect(got).toEqual([
      { error: "Mermaid could not load: chunk failed" },
      { error: "Mermaid could not load: chunk failed" },
    ]);
    expect(load).toHaveBeenCalledTimes(1);

    void queue.render("graph A", colors).then((outcome) => got.push(outcome));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    calls[0]!.done.resolve({ svg: "<svg>A</svg>" });
    await settle();
    expect(got.at(-1)).toEqual({ svg: "<svg>A</svg>" });
  });
});

describe("highlightedCode", () => {
  it("highlights through the diff renderer's shared Shiki, escaping the code", async () => {
    const out = renderToStaticMarkup(
      createElement("pre", null, await highlightedCode("const a = '<b>';", "ts")),
    );
    expect(out).toMatch(
      /^<pre><code><span class="line"><span style="color:#[0-9A-Fa-f]{6}">const<\/span>/,
    );
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
  });

  it("rejects a language Shiki does not bundle, so the block stays plain", async () => {
    await expect(highlightedCode("x", "nosuchlanguage")).rejects.toThrow();
    await expect(highlightedCode("x", "__proto__")).rejects.toThrow();
  });
});
