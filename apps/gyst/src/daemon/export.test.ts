import { type Walkthrough, type WalkthroughExport, WalkthroughExportSchema } from "@gyst/core";
import { walkthroughSlot } from "@gyst/core/web";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ExportTemplate, exportFile, walkthroughHtml } from "./export.ts";

const template = `<!doctype html><html><head><script type="application/json" id="${walkthroughSlot.id}">${walkthroughSlot.placeholder}</script></head><body><script type="module">start()</script></body></html>`;

const hostile = "</script><script>alert(1)</script><!-- &amp; \u2028\u2029 </SCRIPT>";
const blob = "a".repeat(64);
const walkthrough: Walkthrough = {
  scope: { kind: "uncommitted" },
  provenance: { kind: "uncommitted", head: null },
  snapshotId: "b".repeat(64),
  overview: { markdown: "Overview </script><!-- &amp;", references: [] },
  groups: [],
  hunks: [],
  files: [
    { path: "x.ts", old: { kind: "absent" }, new: { kind: "text", blob, size: hostile.length } },
  ],
  pinned: [],
};
const data: WalkthroughExport = {
  gyst: "0.0.0",
  exportedAt: "2026-03-01T00:00:00.000Z",
  walkthrough,
  contents: { [blob]: hostile },
};

/** The text of the page's data element, as an HTML parser reads it. */
const slotText = (html: string) => {
  const open = `<script type="application/json" id="${walkthroughSlot.id}">`;
  const start = html.indexOf(open) + open.length;
  return html.slice(start, html.indexOf("</script>", start));
};

describe("walkthroughHtml", () => {
  it("embeds the export as inert JSON data that no captured text or guidance can close", () => {
    const html = walkthroughHtml(template, data);
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain("<!--");
    expect(html).not.toContain(walkthroughSlot.placeholder);
    expect(slotText(html)).not.toMatch(/[<>&\u2028\u2029]/);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(WalkthroughExportSchema))(slotText(html)),
    ).toEqual(data);
    expect(html.endsWith(`<body><script type="module">start()</script></body></html>`)).toBe(true);
  });

  it("needs a template with exactly one data slot", () => {
    expect(() => walkthroughHtml("<!doctype html>", data)).toThrow(/exactly one data slot/);
    expect(() => walkthroughHtml(`${template}${walkthroughSlot.placeholder}`, data)).toThrow(
      /exactly one data slot/,
    );
  });
});

describe("exportFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gyst-export-"));
    await writeFile(join(dir, "index.html"), template);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const approved = {
    sessionId: "s1",
    approval: "c".repeat(64),
    walkthrough,
    contents: data.contents,
  };

  it("stamps the export time and names the file after its snapshot", async () => {
    const before = Date.now();
    const file = await Effect.runPromise(
      exportFile(approved).pipe(Effect.provideService(ExportTemplate, join(dir, "index.html"))),
    );
    expect(file).toMatchObject({
      sessionId: "s1",
      snapshotId: walkthrough.snapshotId,
      approval: approved.approval,
      name: `gyst-walkthrough-${"b".repeat(12)}.html`,
    });
    expect(Date.parse(file.exportedAt)).toBeGreaterThanOrEqual(before - 1000);
    const embedded = JSON.parse(slotText(file.html));
    expect(embedded).toMatchObject({
      exportedAt: file.exportedAt,
      walkthrough,
      contents: data.contents,
    });
  });

  it("fails as not installed when the reader template is missing, writing nothing", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        exportFile(approved).pipe(Effect.provideService(ExportTemplate, join(dir, "missing.html"))),
      ),
    );
    expect(error).toMatchObject({
      _tag: "internal_error",
      message: "the standalone walkthrough reader is not installed; reinstall @gyst/cli",
    });
  });
});
