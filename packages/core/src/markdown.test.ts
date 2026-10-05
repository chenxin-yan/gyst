import { describe, expect, it } from "vite-plus/test";
import { inspectMarkdown } from "./markdown.ts";

const range = (path: string, side: "old" | "new", startLine: number, endLine = startLine) => ({
  path,
  side,
  startLine,
  endLine,
});

describe("inspectMarkdown", () => {
  it("extracts inline, reference-style and angle-bracket gyst: references once each", () => {
    expect(
      inspectMarkdown(
        [
          "See [the helper](gyst:new/src/helper.ts#L40-L52) and [again](gyst:new/src/helper.ts#L40-L52).",
          "",
          "The [old loop][loop] and <gyst:old/a%20b.ts#L3> and [spaced](<gyst:new/dir/with space.ts#L1>).",
          "",
          "[loop]: gyst:old/src/loop.ts#L7",
        ].join("\n"),
      ),
    ).toEqual({
      references: [
        range("src/helper.ts", "new", 40, 52),
        range("a b.ts", "old", 3),
        range("dir/with space.ts", "new", 1),
        range("src/loop.ts", "old", 7),
      ],
      problems: [],
    });
  });

  it("allows absolute http(s) links, GFM autolinks, raw HTML as text and plain Mermaid", () => {
    expect(
      inspectMarkdown(
        [
          "[docs](https://example.com/a?b=c#d) and [plain](HTTP://example.com) and <https://x.dev>.",
          "",
          "Bare www.example.com and https://example.org/path autolink.",
          "",
          '<a href="javascript:alert(1)">raw</a> <img src="https://x/y.png"> <script>alert(1)</script>',
          "",
          "| a | b |",
          "| - | - |",
          "| [x](https://example.com) | ~~y~~ |",
          "",
          "- [x] done",
          "",
          "```mermaid",
          "flowchart LR",
          "  A --- B",
          "```",
        ].join("\n"),
      ),
    ).toEqual({ references: [], problems: [] });
  });

  it("never extracts links from code spans or fenced code", () => {
    expect(
      inspectMarkdown(
        [
          "Inline `[x](javascript:alert(1))` and `![i](data:x)` and `gyst:new/a.ts#L1`.",
          "",
          "```md",
          "[x](javascript:alert(1)) ![i](https://x/y.png) [r](gyst:new/a.ts#L1)",
          "```",
          "",
          "    [indented](file:///etc/passwd)",
        ].join("\n"),
      ),
    ).toEqual({ references: [], problems: [] });
  });

  it("rejects every link that is not absolute http(s) or a valid gyst: reference", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;avascript&colon;alert(1)",
      "java&#x09;script:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "//evil.example/x",
      "https:/evil.example",
      "https:evil.example",
      "https://",
      "relative/path.md",
      "/absolute/path",
      "../up",
      "#fragment",
      "ftp://example.com",
      "gyst:new/a.ts",
      "gyst:new/../a.ts#L1",
      "gyst:mid/a.ts#L1",
      "gyst:new/a.ts#L0",
      "gyst:new/a.ts#L5-L2",
      "GYST:new/a.ts#L1",
    ]) {
      const { problems, references } = inspectMarkdown(`[x](<${url}>)`);
      expect(problems, url).toHaveLength(1);
      expect(problems[0], url).toMatch(/^line 1: (link|reference) /);
      expect(references, url).toEqual([]);
    }
    // Definitions are links whether or not anything uses them.
    expect(inspectMarkdown("Text.\n\n[unused]: javascript:alert(1)").problems).toEqual([
      'line 3: link "javascript:alert(1)" must be an absolute http(s) URL or a gyst: reference',
    ]);
    expect(inspectMarkdown("[x][r]\n\n[r]: data:text/html,x").problems).toHaveLength(1);
    // GFM's literal email and protocol autolinks are mailto:/xmpp: links too.
    expect(inspectMarkdown("Mail someone@example.com.").problems).toEqual([
      'line 1: link "mailto:someone@example.com" must be an absolute http(s) URL or a gyst: reference',
    ]);
  });

  it("rejects images however they are written", () => {
    for (const markdown of [
      "![alt](https://example.com/x.png)",
      "![alt](data:image/png;base64,AAAA)",
      "![alt][img]\n\n[img]: https://example.com/x.png",
      "[![alt](https://example.com/x.png)](https://example.com)",
      "- item ![alt](https://example.com/x.png)",
    ])
      expect(inspectMarkdown(markdown).problems, markdown).toContain(
        "line 1: images are not allowed",
      );
  });

  it("rejects Mermaid diagrams that carry their own configuration", () => {
    const fence = (body: string, info = "mermaid") => `Intro.\n\n\`\`\`${info}\n${body}\n\`\`\``;
    for (const markdown of [
      fence("%%{init: {'theme':'dark'}}%%\nflowchart LR\n  A --> B"),
      fence("flowchart LR\n  %%{ init: { 'securityLevel': 'loose' } }%%\n  A --> B"),
      fence("   %% {init: {}}%%\ngraph TD"),
      fence("%%{init: {}}%%\ngraph TD", "Mermaid"),
      fence("%%{wrap}%%\nsequenceDiagram", "mermaid title"),
      "~~~mermaid\n%%{init:{}}%%\ngraph TD\n~~~",
      "> ```mermaid\n> %%{init:{}}%%\n> graph TD\n> ```",
      "- item\n\n  ```mermaid\n  %%{init:{}}%%\n  graph TD\n  ```",
    ])
      expect(inspectMarkdown(markdown).problems, markdown).toEqual([
        expect.stringMatching(/^line \d+: Mermaid diagrams may not carry %%\{ \}%% directives$/),
      ]);
    for (const body of [
      "---\nconfig:\n  theme: dark\n---\nflowchart LR",
      "\n\n---\ntitle: x\n---\ngraph TD",
      "  ---\nconfig: {}\n---\ngraph TD",
    ])
      expect(inspectMarkdown(fence(body)).problems, body).toEqual([
        "line 3: Mermaid diagrams may not carry --- frontmatter",
      ]);
    // Other languages may show Mermaid syntax as code.
    expect(inspectMarkdown(fence("%%{init:{}}%%\n---", "text")).problems).toEqual([]);
  });

  it("rejects Mermaid shape data, which can load images, and author styling", () => {
    const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;
    for (const body of [
      'flowchart LR\n  A@{ img: "https://example.com/probe.png", label: "Probe" }',
      'flowchart LR\n  A@{ "\\u0069mg": "https://example.com/probe.png" }',
      "flowchart LR\n  A@{ icon: 'fa:user' } --> B",
    ])
      expect(inspectMarkdown(fence(body)).problems, body).toEqual([
        "line 1: Mermaid diagrams may not carry @{ } shape data, which can load images",
      ]);
    for (const [body, keyword] of [
      ["flowchart LR\n  A --> B\n  style A fill:#ff0000", "style"],
      ["flowchart LR\n  A --> B; classDef default fill:#f00", "classDef"],
      ["flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00", "linkStyle"],
      ["classDiagram\n  class A\n  cssClass A red", "cssClass"],
      ["C4Context\n  Person(a, A)\n  UpdateElementStyle(a, $bgColor=red)", "UpdateElementStyle"],
      ["sequenceDiagram\n  rect rgb(255, 0, 0)\n  A->>B: hi\n  end", "rect"],
      ["sequenceDiagram\n  box Aqua Team\n  participant A\n  end", "box"],
    ])
      expect(inspectMarkdown(fence(body!)).problems, body).toEqual([
        `line 1: Mermaid diagrams may not carry author styling: ${JSON.stringify(keyword)}`,
      ]);
    // Words that only start like a styling statement, and `rect` outside a sequence diagram.
    expect(
      inspectMarkdown(fence("flowchart LR\n  styles --> rect\n  rect --> boxes")).problems,
    ).toEqual([]);
  });
});
