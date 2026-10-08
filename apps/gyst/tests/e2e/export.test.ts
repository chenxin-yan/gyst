// Walkthrough export through the installed gyst: the CLI's terminal approval and the viewer's
// dialog, each bound to the state it previewed, and the written file opened as file:// in a real
// Chromium with networking off, gyst stopped and the checkout gone.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vite-plus/test";
import {
  failed,
  installed,
  json,
  launchViewer,
  run,
  sandbox,
  stopDaemon,
  succeeded,
  viewerLink,
} from "./installed-gyst.ts";

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

/** A sandbox whose one-shot `gyst` prints its link without opening a desktop browser. */
async function headless() {
  const box = await sandbox();
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY"]) delete box.env[name];
  return box;
}

const hostile = '<img src=x onerror="window.hostileRan=1">';
const numbered = (prefix: string, count: number, edit?: (n: number) => string | undefined) =>
  Array.from(
    { length: count },
    (_, i) => `export const ${prefix}${i + 1} = ${edit?.(i + 1) ?? i + 1};\n`,
  ).join("");

function executable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return undefined;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

async function repository(root: string, name: string) {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@gyst.invalid");
  git(cwd, "config", "user.name", "t");
  return cwd;
}

/** Every write of `files`, then one commit. */
async function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", message);
}

/** The installed CLI, from `cwd`, with a terminal: `script` gives it a pty fed `answer`. */
const atTerminal = (box: Sandbox, cwd: string, args: string[], answer: string) =>
  run("script", ["-qec", [installed.bin, ...args].join(" "), "/dev/null"], {
    cwd,
    env: box.env,
    stdin: answer,
    timeout: 60_000,
  });

/** The one JSON line a terminal export printed on stdout, among its disclosure and prompt. */
const exportedLine = (output: string) =>
  JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('{"path"'))!);

/** The export data embedded in a written file, as the reader parses it. */
function embeddedOf(html: string) {
  const open = '<script type="application/json" id="gyst-walkthrough">';
  const start = html.indexOf(open) + open.length;
  expect(html.indexOf(open, start)).toBe(-1);
  return { text: html.slice(start, html.indexOf("</script>", start)) };
}

const session = async (box: Sandbox, cwd: string, ...scope: string[]) =>
  json(await box.gyst(cwd, ["session", "open", ...scope])).session as {
    id: string;
    snapshotId: string;
  };

/** Publishes `ops` against the session's current state. */
async function publish(box: Sandbox, cwd: string, id: string, key: string, ops: object[]) {
  const status = json(await box.gyst(cwd, ["session", "status", "--session", id]));
  return json(
    await box.gyst(
      cwd,
      ["session", "apply", "--session", id],
      JSON.stringify({
        revision: status.revision,
        snapshotId: status.session.snapshotId,
        idempotencyKey: key,
        ops,
      }),
    ),
  );
}
const hunksOf = async (box: Sandbox, cwd: string, id: string) =>
  json(await box.gyst(cwd, ["session", "diff", "--session", id])).hunks as {
    id: string;
    file: string;
  }[];

describe("walkthrough export", () => {
  let browser: Browser;
  beforeAll(async () => {
    const chromiumPath =
      process.env.CHROMIUM_PATH ??
      ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
        .map(executable)
        .find((file) => file !== undefined);
    browser = await chromium.launch({
      ...(chromiumPath ? { executablePath: chromiumPath } : { channel: "chrome" }),
      chromiumSandbox: true,
      headless: true,
      timeout: 60_000,
    });
  }, 60_000);
  afterAll(() => browser?.close());

  /**
   * A page in a fresh offline profile with `file` open, which must make no request but its own
   * navigation and show no error. Every other request, to the daemon or the network, is
   * intercepted and refused, and fails the test.
   */
  async function offline(file: string) {
    const href = pathToFileURL(file).href;
    const context = await browser.newContext({ offline: true });
    const intercepted: string[] = [];
    await context.route("**/*", (route) => {
      if (route.request().url() === href) return route.continue();
      intercepted.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const requests: string[] = [];
    const problems: string[] = [];
    context.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console ${message.text()}`);
    });
    onTestFinished(async () => {
      await context.close();
      expect({ requests, intercepted, problems }).toEqual({
        requests: [href],
        intercepted: [],
        problems: [],
      });
    });
    const started = performance.now();
    await page.goto(href);
    return { page, started };
  }

  const keys = async (page: Page, ...pressed: string[]) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const key of pressed) await page.keyboard.press(key);
  };
  const headings = (page: Page) =>
    page
      .getByRole("main")
      .getByRole("heading", { level: 2 })
      .evaluateAll((all) => all.map((heading) => heading.getAttribute("aria-label")));

  it("exports from the CLI only once a person approves at a terminal, and reads offline with gyst stopped and the checkout gone", async () => {
    const box = await headless();
    const cwd = await repository(box.root, "repo");
    await commit(
      cwd,
      {
        "src/app.ts": numbered("app", 30),
        "src/other.ts": numbered("other", 30),
        "src/helper.ts": "export function helper() {\n  return 'helped';\n}\n",
        "unrelated.ts": "export const secret = 'UNRELATED-SENTINEL';\n",
      },
      "base",
    );
    git(cwd, "switch", "-qc", "topic");
    await commit(
      cwd,
      {
        "src/app.ts": numbered("app", 30, (n) =>
          n === 10 ? `'</script><script>window.hostileRan=1</script><!--'` : undefined,
        ),
        "src/other.ts": numbered("other", 30, (n) => (n === 20 ? "20 * 2" : undefined)),
      },
      "topic",
    );
    // main moves on, so the range's merge base is not main's head.
    git(cwd, "switch", "-q", "main");
    await commit(cwd, { "later.ts": "export const later = 1;\n" }, "later");
    const base = git(cwd, "rev-parse", "main");
    const head = git(cwd, "rev-parse", "topic");
    const mergeBase = git(cwd, "merge-base", "main", "topic");
    expect(mergeBase).not.toBe(base);

    const { id, snapshotId } = await session(box, cwd, "main...topic");
    const hunks = await hunksOf(box, cwd, id);
    const app = hunks.find(({ file }) => file === "src/app.ts")!;
    const other = hunks.find(({ file }) => file === "src/other.ts")!;
    const helper = "[the helper](gyst:new/src/helper.ts#L1-L3)";
    await publish(box, cwd, id, "publish", [
      {
        type: "walkthrough.update",
        overview: [
          `Two changes. ${hostile} Read ${helper} first; [a page](https://example.com/guide).`,
          "```mermaid\nflowchart LR\n  app --> other\n```",
          "```mermaid\nthis is not a diagram\n```",
        ].join("\n\n"),
      },
      {
        type: "group.create",
        id: "first",
        title: "Quote the app line",
        overview: "The app line becomes a string.",
        memberHunkIds: [app.id],
      },
      {
        type: "group.create",
        id: "second",
        title: "Double other",
        overview: "Doubles other20.",
        memberHunkIds: [other.id],
      },
      {
        type: "note.create",
        id: "app-note",
        group: "first",
        anchor: { path: "src/app.ts", side: "new", startLine: 10, endLine: 10 },
        markdown: `Uses ${helper} and [the doubling](gyst:new/src/other.ts#L20-L20).`,
      },
      {
        type: "note.create",
        id: "other-note",
        group: "second",
        anchor: { path: "src/other.ts", side: "new", startLine: 20, endLine: 20 },
        markdown: `Calls ${helper}.`,
      },
    ]);

    // A human's comment and Viewed progress: neither is ever part of an export.
    const viewer = await launchViewer(["--session", id], { cwd, env: box.env });
    const drafted = await viewer.operation({
      command: "draft",
      session: id,
      requestId: "d1",
      target: {
        kind: "comment",
        anchor: { snapshotId, path: "src/other.ts", side: "new", startLine: 20, endLine: 20 },
      },
    });
    expect(drafted.ok).toBe(true);
    expect(
      (
        await viewer.operation({
          command: "send",
          session: id,
          requestId: "s1",
          draft: drafted.value.draft,
          markdown: "PRIVATE-COMMENT-SENTINEL",
          kind: "question",
        })
      ).ok,
    ).toBe(true);
    const status = json(await box.gyst(cwd, ["session", "status", "--session", id]));
    expect(
      (
        await viewer.operation({
          command: "viewed",
          session: id,
          snapshotId,
          revision: status.revision,
          requestId: "v1",
          hunkIds: [app.id],
          viewed: true,
        })
      ).ok,
    ).toBe(true);

    // No terminal, no export: an agent or a pipe gets a structured refusal and nothing else.
    const piped = await box.gyst(cwd, ["session", "export", "--session", id]);
    expect(failed(piped)).toMatchObject({ code: "bad_args" });
    expect(piped.stdout).toBe("");
    expect(await readdir(cwd)).not.toContain(expect.stringMatching(/\.html$/));
    // Declined at the terminal: nothing is written.
    const out = join(box.root, "walkthrough.html");
    const declined = await atTerminal(
      box,
      cwd,
      ["session", "export", "--session", id, "--output", out],
      "no\n",
    );
    expect(declined.exitCode).toBe(1);
    expect(declined.stdout).toContain("WARNING: the file contains every file above in full");
    await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });

    const approved = succeeded(
      await atTerminal(box, cwd, ["session", "export", "--session", id, "--output", out], "yes\n"),
    );
    const disclosure = approved.stdout;
    for (const line of [
      "Scope: Git range main...topic",
      `Old side: merge base ${mergeBase} of ${base}`,
      `New side: ${head}`,
      `Snapshot: ${snapshotId}`,
      "Included in full (6 file sides):",
      "  src/app.ts (old): sha256 ",
      "  src/helper.ts (new): sha256 ",
      "Full files and guidance may disclose secrets or confidential content.",
    ])
      expect(disclosure).toContain(line);
    expect(disclosure).not.toContain("unrelated.ts");
    const written = exportedLine(disclosure);
    expect(written).toMatchObject({ path: out, sessionId: id, snapshotId });
    const html = await readFile(out, "utf8");
    expect(Buffer.byteLength(html)).toBe(written.bytes);
    // A second export never replaces the first.
    expect(
      (await atTerminal(box, cwd, ["session", "export", "--session", id, "--output", out], "yes\n"))
        .exitCode,
    ).toBe(1);
    expect(await readFile(out, "utf8")).toBe(html);

    // The embedded data: the walkthrough and exactly its files, and nothing private.
    const { text } = embeddedOf(html);
    const data = JSON.parse(text);
    expect(Object.keys(data).sort()).toEqual(["contents", "exportedAt", "gyst", "walkthrough"]);
    expect(data.walkthrough.provenance).toEqual({ kind: "range", base, head, mergeBase });
    expect(data.walkthrough.files.map(({ path }: { path: string }) => path)).toEqual([
      "src/app.ts",
      "src/helper.ts",
      "src/other.ts",
    ]);
    expect(data.walkthrough.pinned).toEqual([]);
    for (const secret of [
      "PRIVATE-COMMENT-SENTINEL",
      "UNRELATED-SENTINEL",
      id,
      cwd,
      box.root,
      box.home,
    ])
      expect(html).not.toContain(secret);
    // The reader's code names session fields; its data carries none of them.
    for (const field of ["viewedHunkIds", "threads", "drafts", "repoRoot", "createdAt", "receipts"])
      expect(text).not.toContain(field);
    expect(text).not.toMatch(/[<>&]/);

    // gyst stopped, the checkout gone, the network off: the file alone reads the walkthrough.
    await stopDaemon(box.data);
    await rm(cwd, { recursive: true, force: true });
    const { page } = await offline(out);
    const pane = page.getByRole("main");
    const side = page.getByRole("navigation", { name: "gyst" });
    const overview = pane.getByRole("region", { name: "Walkthrough overview" });
    await overview.waitFor();
    await overview.getByText(`Two changes. ${hostile} Read`, { exact: false }).waitFor();
    await overview.getByRole("img", { name: "Diagram" }).locator("svg").waitFor();
    await overview.getByText(/^Diagram failed:/).waitFor();
    expect(await overview.getByRole("link", { name: "a page" }).getAttribute("href")).toBe(
      "https://example.com/guide",
    );
    expect(await page.evaluate(() => "hostileRan" in window)).toBe(false);
    // The baseline faces come from the file itself, whatever this machine has installed.
    expect(
      await page.evaluate(() =>
        Promise.all(
          ['16px "Inter Variable"', '16px "JetBrains Mono Variable"'].map(async (font) =>
            (await document.fonts.load(font)).map((face) => face.status),
          ),
        ),
      ),
    ).toEqual([["loaded"], ["loaded"]]);
    await page.getByRole("heading", { level: 1 }).getByText("main...topic").waitFor();
    // Read-only: no Viewed, comments, refresh or export, in the page or its keys.
    for (const name of ["Comments", "Export…", "All sessions", "Delete…"])
      expect(await page.getByRole("button", { name }).count()).toBe(0);
    expect(await pane.getByRole("checkbox").count()).toBe(0);
    expect(await page.getByText("PRIVATE-COMMENT-SENTINEL").count()).toBe(0);

    // Group and file navigation, layouts and folds.
    await side.getByRole("button", { name: /^Quote the app line/ }).click();
    await expect.poll(() => headings(page)).toEqual(["src/app.ts"]);
    await pane
      .getByText("'</script><script>window.hostileRan=1</script><!--'", { exact: false })
      .first()
      .waitFor();
    await keys(page, "Shift+J");
    await expect.poll(() => headings(page)).toEqual(["src/other.ts"]);
    await side.getByRole("button", { name: "Overview" }).click();
    await expect.poll(() => headings(page)).toEqual(["src/app.ts", "src/other.ts"]);
    await keys(page, "2");
    await page.getByRole("radio", { name: "Stacked", exact: true }).isChecked();
    expect(await page.getByRole("radio", { name: "Stacked", exact: true }).isChecked()).toBe(true);
    await keys(page, "1");
    expect(await page.getByRole("radio", { name: "Split", exact: true }).isChecked()).toBe(true);
    await keys(page, "z", "Shift+M");
    await expect.poll(() => pane.getByText("export const other19 = 19;").count()).toBe(0);
    await keys(page, "z", "Shift+R");
    await pane.getByText("export const other19 = 19;").first().waitFor();

    // A reference peeks and expands to its captured file, a reference there expands again, and
    // Back retraces both, each time with the peek it left open.
    await side.getByRole("button", { name: /^Quote the app line/ }).click();
    await pane
      .locator("[data-note=app-note]")
      .getByRole("button", { name: "the doubling" })
      .click();
    const peek = pane.locator("[data-peek]");
    await peek.locator("[data-peek-preview]").getByText("export const other20 = 20 * 2;").waitFor();
    await peek.getByRole("button", { name: "Expand" }).click();
    const captured = pane.getByRole("region", { name: "Captured file" });
    await captured.getByText("src/other.ts", { exact: true }).waitFor();
    await expect.poll(() => headings(page)).toEqual(["src/other.ts"]);
    await pane
      .locator("[data-note=other-note]")
      .getByRole("button", { name: "the helper" })
      .click();
    await peek.locator("[data-peek-preview]").getByText("return 'helped';").waitFor();
    await peek.getByRole("button", { name: "Expand" }).click();
    await captured.getByText("src/helper.ts", { exact: true }).waitFor();
    expect(await captured.textContent()).toMatch(/src\/helper\.ts · new side/);
    await expect.poll(() => headings(page)).toEqual(["src/helper.ts"]);
    await keys(page, "Backspace");
    await expect.poll(() => headings(page)).toEqual(["src/other.ts"]);
    await expect
      .poll(() => peek.getAttribute("aria-label"))
      .toBe("Reference src/helper.ts:L1–3 · new");
    await keys(page, "Backspace");
    await expect.poll(() => headings(page)).toEqual(["src/app.ts"]);
    await expect
      .poll(() => peek.getAttribute("aria-label"))
      .toBe("Reference src/other.ts:L20 · new");
    // Full-file expansion of a changed file's hidden lines.
    await keys(page, "Escape");
    await pane
      .getByText(/unmodified lines$/)
      .first()
      .click();
    await pane.getByText("export const app1 = 1;").first().waitFor();

    // The commands it offers only read.
    await keys(page, "Control+K");
    const menu = page.getByRole("dialog", { name: "Command menu" });
    await menu.waitFor();
    const offered = await menu.getByRole("option").allTextContents();
    for (const write of ["Comment", "Refresh", "Mark the cursor", "Export", "All comments"])
      expect(offered.some((label) => label.startsWith(write))).toBe(false);
    expect(offered.some((label) => label.startsWith("Next walkthrough group"))).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Exported / }).click();
    const about = page.getByRole("dialog", { name: "About this export" });
    await about.getByText(`Old side: merge base ${mergeBase} of ${base}`).waitFor();
    await about.getByText(snapshotId).waitFor();
  }, 180_000);

  it("states uncommitted and unborn inputs honestly, never as a commit's bytes", async () => {
    const box = await headless();
    const unborn = await repository(box.root, "unborn");
    await writeFile(join(unborn, "fresh.ts"), "export const fresh = 1;\n");
    const born = await repository(box.root, "born");
    await commit(born, { "kept.ts": "export const kept = 1;\n" }, "base");
    await writeFile(join(born, "kept.ts"), "export const kept = 2;\n");
    await writeFile(join(born, "untracked.ts"), "export const untracked = 1;\n");
    const expected = {
      [unborn]: { kind: "uncommitted", head: null },
      [born]: { kind: "uncommitted", head: git(born, "rev-parse", "HEAD") },
    };
    for (const cwd of [unborn, born]) {
      const { id } = await session(box, cwd);
      const hunks = await hunksOf(box, cwd, id);
      await publish(box, cwd, id, "publish", [
        { type: "walkthrough.update", overview: "Working-tree changes." },
        {
          type: "group.create",
          id: "all",
          title: "Everything",
          overview: "All of it.",
          memberHunkIds: hunks.map((hunk) => hunk.id),
        },
      ]);
      const out = join(box.root, `${cwd === unborn ? "unborn" : "born"}.html`);
      const shown = succeeded(
        await atTerminal(
          box,
          cwd,
          ["session", "export", "--session", id, "--output", out],
          "yes\n",
        ),
      ).stdout;
      expect(shown).toContain("New side: the working tree as captured, which no commit identifies");
      expect(shown).toContain(
        cwd === unborn
          ? "Old side: an empty baseline; the repository had no commits"
          : `Old side: HEAD ${expected[cwd]!.head}`,
      );
      const data = JSON.parse(embeddedOf(await readFile(out, "utf8")).text);
      expect(data.walkthrough.provenance).toEqual(expected[cwd]);
      expect(data.walkthrough.files.map(({ path }: { path: string }) => path)).toEqual(
        cwd === unborn ? ["fresh.ts"] : ["kept.ts", "untracked.ts"],
      );
    }
    await stopDaemon(box.data);
    const { page } = await offline(join(box.root, "unborn.html"));
    await page.getByRole("button", { name: /^Exported / }).click();
    await page
      .getByRole("dialog", { name: "About this export" })
      .getByText("Old side: an empty baseline; the repository had no commits")
      .waitFor();
  }, 120_000);

  it("discloses an unavailable reference on both surfaces, and reads it, an earlier pin and hostile data safely offline", async () => {
    const box = await headless();
    const cwd = await repository(box.root, "repo");
    await commit(
      cwd,
      { "a.ts": numbered("a", 20), "helper.ts": "export const h1 = 1;\nexport const h2 = 2;\n" },
      "base",
    );
    await writeFile(
      join(cwd, "a.ts"),
      numbered("a", 20, (n) => (n === 10 ? "10 * 2" : undefined)),
    );
    await writeFile(join(cwd, "added.ts"), "export const added = 1;\n");
    const { id, snapshotId: first } = await session(box, cwd);
    await publish(box, cwd, id, "publish", [
      { type: "walkthrough.update", overview: "Doubles a10 and adds a file." },
      {
        type: "group.create",
        id: "g",
        title: "Double a10",
        overview: "Doubles a10.",
        memberHunkIds: (await hunksOf(box, cwd, id)).map((hunk) => hunk.id),
      },
      {
        type: "note.create",
        id: "n",
        group: "g",
        anchor: { path: "a.ts", side: "new", startLine: 10, endLine: 10 },
        markdown:
          "Calls [the helper](gyst:new/helper.ts#L1-L2); see [the start](gyst:new/added.ts#L1-L1).",
      },
    ]);
    // A refresh moves the walkthrough to a new snapshot; the note's references stay pinned to the
    // first, so the export carries helper.ts from there.
    await writeFile(join(cwd, "more.ts"), "export const more = 1;\n");
    succeeded(
      await box.gyst(cwd, [
        "session",
        "refresh",
        "--session",
        id,
        "--snapshot",
        first,
        "--request-id",
        "r1",
      ]),
    );
    const { preparation } = json(await box.gyst(cwd, ["session", "status", "--session", id]));
    await publish(box, cwd, id, "regroup", [
      ...(preparation.overviewOutdated ? [{ type: "walkthrough.revalidate" }] : []),
      {
        type: "group.update",
        id: "g",
        memberHunkIds: (await hunksOf(box, cwd, id)).map((hunk) => hunk.id),
      },
    ]);
    const current = json(await box.gyst(cwd, ["session", "status", "--session", id])).session
      .snapshotId as string;
    expect(current).not.toBe(first);

    // Authoring refuses a reference to a side without text, unsafe links and diagram
    // configuration, so they are written into the saved session as older or hand-edited data
    // would carry them: the note's second reference now names added.ts's absent old side.
    await stopDaemon(box.data);
    const file = join(box.data, `${id}.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    const note = saved.groups[0].notes[0];
    note.markdown = note.markdown.replace("gyst:new/added.ts", "gyst:old/added.ts");
    for (const reference of note.references)
      if (reference.path === "added.ts") reference.side = "old";
    saved.overview.markdown = [
      saved.overview.markdown,
      "[run](javascript:window.hostileRan=1) ![probe](https://example.com/probe.png) <script>window.hostileRan=2</script>",
      '```mermaid\n%%{init: {"securityLevel": "loose", "theme": "forest"}}%%\nflowchart LR\n  start --> done\n```',
      '```mermaid\nflowchart LR\n  a@{ img: "https://example.com/probe.png" } --> b\n```',
    ].join("\n\n");
    await writeFile(file, JSON.stringify(saved));
    expect(note.references).toContainEqual({
      snapshotId: first,
      path: "added.ts",
      side: "old",
      startLine: 1,
      endLine: 1,
    });

    // The terminal lists it with its reason, and the earlier snapshot's side beside the current.
    const out = join(box.root, "walkthrough.html");
    const shown = succeeded(
      await atTerminal(box, cwd, ["session", "export", "--session", id, "--output", out], "yes\n"),
    ).stdout;
    for (const line of [
      `  helper.ts (new, earlier snapshot ${first}): sha256 `,
      "Unavailable references, shown in the file with their reason:",
      `  added.ts:1-1 (old, snapshot ${first}): absent on the old side`,
    ])
      expect(shown).toContain(line);
    const data = JSON.parse(embeddedOf(await readFile(out, "utf8")).text);
    expect(data.walkthrough.pinned).toEqual([
      { snapshotId: first, path: "added.ts", side: "old", content: { kind: "absent" } },
      {
        snapshotId: first,
        path: "helper.ts",
        side: "new",
        content: { kind: "text", blob: expect.any(String), size: 42 },
      },
    ]);

    // The viewer's dialog lists the same reference and reason.
    const { port } = viewerLink(
      succeeded(await run(installed.bin, ["--session", id], { cwd, env: box.env })).stdout,
    );
    const context = await browser.newContext();
    onTestFinished(() => context.close());
    const live = await context.newPage();
    live.setDefaultTimeout(15_000);
    await live.goto(`http://localhost:${port}/session/${id}`);
    await live.getByRole("button", { name: "Export…" }).click();
    const unavailable = live
      .getByRole("dialog", { name: "Export the walkthrough" })
      .getByRole("region", { name: "Unavailable references" });
    expect(await unavailable.getByRole("listitem").allTextContents()).toEqual([
      "added.ts:L1 · old · absent on the old side",
    ]);
    await context.close();

    // Offline, with gyst stopped and the checkout gone.
    await stopDaemon(box.data);
    await rm(cwd, { recursive: true, force: true });
    const { page } = await offline(out);
    const pane = page.getByRole("main");
    const overview = pane.getByRole("region", { name: "Walkthrough overview" });
    await overview.getByText("Doubles a10 and adds a file.").waitFor();
    // Unsafe links and markup stay text, the directive is dropped and the diagram drawn, and the
    // diagram that would fetch an image fails visibly instead.
    await overview.getByText("<script>window.hostileRan=2</script>").waitFor();
    expect(await overview.getByRole("link", { name: "run" }).count()).toBe(0);
    await overview.getByText("run", { exact: true }).waitFor();
    expect(await overview.locator("img, script").count()).toBe(0);
    await overview.getByRole("img", { name: "Diagram" }).locator("svg").waitFor();
    await overview.getByText(/^Diagram failed:/).waitFor();
    expect(await page.evaluate(() => "hostileRan" in window)).toBe(false);

    await page
      .getByRole("navigation", { name: "gyst" })
      .getByRole("button", { name: /^Double a10/ })
      .click();
    const peek = pane.locator("[data-peek]");
    await pane.locator("[data-note=n]").getByRole("button", { name: "the start" }).click();
    await peek.getByText("Unavailable: absent on the old side.").waitFor();
    await pane.locator("[data-note=n]").getByRole("button", { name: "the helper" }).click();
    await peek.locator("[data-peek-preview]").getByText("export const h2 = 2;").waitFor();
    await peek.getByRole("button", { name: "Expand" }).click();
    const captured = pane.getByRole("region", { name: "Captured file" });
    await captured.getByText("helper.ts", { exact: true }).waitFor();
    expect(await captured.textContent()).toContain(`snapshot ${first.slice(0, 7)}`);
    await keys(page, "Backspace");
    await expect.poll(() => peek.getAttribute("aria-label")).toBe("Reference helper.ts:L1–2 · new");
  }, 180_000);

  it("exports from the viewer only for the approved preview, refusing one the agent changed meanwhile and an unready walkthrough", async () => {
    const box = await headless();
    const cwd = await repository(box.root, "repo");
    await commit(cwd, { "a.ts": numbered("a", 20), "helper.ts": "export const h = 1;\n" }, "base");
    await writeFile(
      join(cwd, "a.ts"),
      numbered("a", 20, (n) => (n === 5 ? "5 * 2" : undefined)),
    );
    const { id } = await session(box, cwd);
    const [hunk] = await hunksOf(box, cwd, id);
    const { port } = viewerLink(
      succeeded(await run(installed.bin, ["--session", id], { cwd, env: box.env })).stdout,
    );
    await publish(box, cwd, id, "publish", [
      { type: "walkthrough.update", overview: "First wording." },
      {
        type: "group.create",
        id: "g",
        title: "Double a5",
        overview: "See [h](gyst:new/helper.ts#L1-L1).",
        memberHunkIds: [hunk!.id],
      },
    ]);
    const context = await browser.newContext({ acceptDownloads: true });
    onTestFinished(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`http://localhost:${port}/session/${id}`);
    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog", { name: "Export the walkthrough" });
    await dialog.getByText(/may disclose secrets or confidential content/).waitFor();
    const included = dialog.getByRole("region", { name: "Included files" });
    await included.getByText("Included: 4 file sides").waitFor();
    expect(await included.getByRole("listitem").allTextContents()).toEqual([
      expect.stringMatching(/^a\.ts old · sha256 [0-9a-f]{12} · \d+ bytes$/),
      expect.stringMatching(/^a\.ts new · sha256 [0-9a-f]{12} · \d+ bytes$/),
      expect.stringMatching(/^helper\.ts old · sha256 [0-9a-f]{12} · \d+ bytes$/),
      expect.stringMatching(/^helper\.ts new · sha256 [0-9a-f]{12} · \d+ bytes$/),
    ]);
    await dialog.getByText(/^Old side: HEAD [0-9a-f]{40}$/).waitFor();

    // The agent rewords the walkthrough after this preview: its approval is refused, nothing is
    // downloaded, and the new state needs approving again.
    await publish(box, cwd, id, "reword", [
      { type: "walkthrough.update", overview: "Second wording." },
    ]);
    let downloads = 0;
    page.on("download", () => downloads++);
    await dialog.getByRole("button", { name: "Approve and download" }).click();
    await dialog.getByText(/changed since this preview, so nothing was exported/).waitFor();
    expect(downloads).toBe(0);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Approve and download" }).click(),
    ]);
    const saved = join(box.root, download.suggestedFilename());
    await download.saveAs(saved);
    await dialog.getByText(/Your browser is saving gyst-walkthrough-[0-9a-f]{12}\.html/).waitFor();
    const data = JSON.parse(embeddedOf(await readFile(saved, "utf8")).text);
    expect(data.walkthrough.overview.markdown).toBe("Second wording.");
    await dialog.getByRole("button", { name: "Close" }).click();

    // A plain session has nothing ready to export, and no approval to give.
    const plain = await repository(box.root, "plain");
    await commit(plain, { "p.ts": "export const p = 1;\n" }, "base");
    await writeFile(join(plain, "p.ts"), "export const p = 2;\n");
    const unready = await session(box, plain);
    await page.goto(`http://localhost:${port}/session/${unready.id}`);
    await page.getByRole("button", { name: "Export…" }).click();
    const refusal = page.getByRole("dialog", { name: "Export the walkthrough" });
    await refusal.getByText("the session has no walkthrough").waitFor();
    expect(await refusal.getByRole("button", { name: "Approve and download" }).count()).toBe(0);
  }, 120_000);

  it("records a large export's size, generation and open time", async () => {
    const box = await headless();
    const cwd = await repository(box.root, "large");
    const count = 1000;
    const files = (edited: boolean) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `src/${String(i).padStart(4, "0")}.ts`,
          numbered(`v${i}_`, 100, (n) => (edited && n === 50 ? `${n} * 2` : undefined)),
        ]),
      );
    await commit(cwd, files(false), "base");
    git(cwd, "switch", "-qc", "large");
    await commit(cwd, files(true), "large");
    const { id } = json(
      await run(installed.bin, ["session", "open", "main...large"], {
        cwd,
        env: box.env,
        timeout: 120_000,
      }),
    ).session;
    const hunks = await hunksOf(box, cwd, id);
    expect(hunks).toHaveLength(count);
    await publish(box, cwd, id, "publish", [
      { type: "walkthrough.update", overview: "Doubles line 50 of every file." },
      {
        type: "group.create",
        id: "all",
        title: "Every file",
        overview: "The same change everywhere.",
        memberHunkIds: hunks.map((hunk) => hunk.id),
      },
    ]);
    const out = join(box.root, "large.html");
    const started = performance.now();
    succeeded(
      await atTerminal(box, cwd, ["session", "export", "--session", id, "--output", out], "yes\n"),
    );
    const generation = performance.now() - started;
    const { size } = await stat(out);
    await stopDaemon(box.data);
    const { page, started: opening } = await offline(out);
    await page.getByRole("region", { name: "Walkthrough overview" }).waitFor({ timeout: 60_000 });
    await page.getByRole("heading", { level: 2 }).first().waitFor({ timeout: 60_000 });
    const open = performance.now() - opening;
    const step = performance.now();
    await keys(page, "Shift+G");
    await page
      .getByRole("contentinfo")
      .getByText(/^0999\.ts/)
      .waitFor({ timeout: 60_000 });
    const lastFile = performance.now() - step;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find(({ name }) => name === "JSHeapUsedSize")?.value;
    console.log(
      `[export measurement] ${count} changed files: ${(size / 2 ** 20).toFixed(1)} MiB, generation (CLI, terminal approval included) ${generation.toFixed(0)} ms, offline open to first file ${open.toFixed(0)} ms, G to the last file ${lastFile.toFixed(0)} ms, JS heap ${heap === undefined ? "unknown" : `${(heap / 2 ** 20).toFixed(0)} MiB`}`,
    );
  }, 300_000);
});
