// The installed gyst in a real sandboxed Chromium: real foreground launches, their daemon and bridge,
// and a private key-authenticated SSH local forward. Hard states (a held or lost reply, a broken
// daemon answer) are produced by Playwright routing in front of the real bridge.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Request as PageRequest,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  commandLine,
  daemonPid,
  installed,
  isAlive,
  isolatedEnv,
  json,
  killDaemon,
  run,
  stopDaemon,
  waitFor,
} from "./installed-gyst.ts";

type Owned = { name: string; child: ChildProcess; out: string; exit?: number | string };
type Launch = {
  proc: Owned;
  hostname: string;
  port: number;
  path: string;
  id: string;
  origin: string;
  url: string;
  secret: string;
};

const hostile = '<img src=x onerror="window.injected=1">';
/** src/long.ts: 300 numbered lines; the uncommitted edit doubles 100–110 and 114–180. */
const longTs = (edited: boolean) =>
  Array.from({ length: 300 }, (_, i) => i + 1)
    .map((n) =>
      edited && n >= 100 && n <= 180 && (n < 111 || n > 113)
        ? `export const line${n} = ${n} * 2;\n`
        : `export const line${n} = ${n};\n`,
    )
    .join("");
const isOperationUrl = (url: URL) => url.pathname === "/api/operation";
const isEventsUrl = (url: URL) => url.pathname === "/api/events";
const operationOf = (request: PageRequest) =>
  request.method() === "POST" && isOperationUrl(new URL(request.url()))
    ? request.postDataJSON()
    : undefined;

// sshd's StrictModes rejects a world-writable ancestor such as /tmp, so the root lives under $HOME.
let root: string;
let repo: string;
let data: string;
let env: NodeJS.ProcessEnv;
let browser: Browser | undefined;
let context: BrowserContext;
const owned: Owned[] = [];

/** Spawns a process kept until afterAll, resolving once `ready` appears in its output. */
async function start(name: string, file: string, args: string[], cwd: string, ready: string) {
  const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const proc: Owned = { name, child, out: "" };
  owned.push(proc);
  let log = "";
  child.once("error", (error) => (proc.exit ??= error.message));
  child.once("close", (code, signal) => (proc.exit ??= code ?? signal ?? "closed"));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (proc.out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));
  await waitFor(
    () => proc.out.includes(ready) || log.includes(ready) || proc.exit !== undefined,
    `${name} to be ready`,
    20_000,
  );
  // stdout is left out: a launch prints its secret-bearing URL there.
  if (proc.exit !== undefined) throw new Error(`${name} exited ${proc.exit} early:\n${log}`);
  return Object.assign(proc, { log: () => log });
}

async function stop(proc: Owned, signal: NodeJS.Signals) {
  if (proc.exit === undefined) proc.child.kill(signal);
  await waitFor(() => proc.exit !== undefined, `${proc.name} to exit on ${signal}`, 10_000);
  return proc.exit;
}

/** One foreground `gyst` launch; stopped with SIGINT like Ctrl-C. */
async function launch(...args: string[]): Promise<Launch> {
  const proc = await start(`gyst ${args.join(" ")}`, installed.bin, args, repo, "Press Ctrl-C");
  const url = proc.out.split("\n").find((line) => line.startsWith("http://")) ?? "";
  const match = /^http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+)(\/session\/[^#]+)#([\w-]{43})$/.exec(
    url,
  );
  // The URL carries the bootstrap secret, so only its shape is reported.
  if (!match) throw new Error("the launch URL lacks the .localhost host, session path or secret");
  const [, hostname = "", port = "", path = "", secret = ""] = match;
  return {
    proc,
    hostname,
    port: Number(port),
    path,
    id: decodeURIComponent(path.slice("/session/".length)),
    origin: `http://${hostname}:${port}`,
    url,
    secret,
  };
}

/** Opens a launch link; Playwright's failure message quotes the URL, so its secret is masked. */
async function go(page: Page, url: string) {
  const secret = new URL(url).hash.slice(1);
  try {
    await page.goto(url);
  } catch (error) {
    // oxlint-disable-next-line preserve-caught-error -- the original error quotes the secret
    throw new Error(String(error).replaceAll(secret, "<secret>"));
  }
}

const gyst = async (...args: string[]) => json(await run(installed.bin, args, { cwd: repo, env }));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
const sessionIds = async () =>
  (await gyst("session", "list")).sessions.map(({ id }: { id: string }) => id);
const openRange = async (range: string): Promise<string> =>
  (await gyst("session", "open", range)).session.id;
const ownDaemon = (pid: number) =>
  isAlive(pid) &&
  commandLine(pid).includes(installed.prefix) &&
  commandLine(pid).endsWith(" daemon run");

/** Each test page's operations on the wire, which `settled` waits out. */
const operationsInFlight = new WeakMap<Page, Set<PageRequest>>();

/**
 * A page closed after its test, which must see exactly the listed HTTP error responses
 * (`<path> <status>`) and problems: failed requests, page errors and console errors. Chromium's
 * "Failed to load resource" lines only repeat those responses and failures. A session page's
 * event stream fails by design whenever it is left, closed or its launcher stops, so only its
 * responses count.
 */
async function newPage(
  from: BrowserContext = context,
  expected: { responses?: unknown[]; problems?: unknown[] } = {},
) {
  const page = await from.newPage();
  page.setDefaultTimeout(15_000);
  const seen = { responses: [] as string[], problems: [] as string[] };
  const path = (url: string) => new URL(url).pathname;
  page.on("response", (response) => {
    if (response.status() >= 400)
      seen.responses.push(`${path(response.url())} ${response.status()}`);
  });
  page.on("requestfailed", (request) => {
    if (!isEventsUrl(new URL(request.url())))
      seen.problems.push(`requestfailed ${path(request.url())}`);
  });
  const operations = new Set<PageRequest>();
  operationsInFlight.set(page, operations);
  page.on("request", (request) => {
    if (isOperationUrl(new URL(request.url()))) operations.add(request);
  });
  page.on("requestfinished", (request) => operations.delete(request));
  page.on("requestfailed", (request) => operations.delete(request));
  page.on("pageerror", (error) => seen.problems.push(`pageerror ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:"))
      seen.problems.push(`console ${message.text()}`);
  });
  onTestFinished(async () => {
    const snapshot = structuredClone(seen);
    await page.close();
    expect(snapshot).toEqual({ responses: [], problems: [], ...expected });
  });
  return page;
}

/**
 * Waits until no operation of the page has been on the wire for 500 ms. A session page's event
 * stream stays open, so the network itself never goes idle.
 */
async function settled(page: Page) {
  const operations = operationsInFlight.get(page)!;
  let quiet = performance.now();
  await waitFor(() => {
    if (operations.size > 0) quiet = performance.now();
    return performance.now() - quiet >= 500;
  }, "the page's operations to settle");
}

/** Leaves the page's session streams unanswered, so it never hears of changes made elsewhere. */
const holdEvents = (page: Page) => page.route(isEventsUrl, () => {});

/**
 * Holds the page's first `count` status reads once `armed`: each is sent to the real bridge, and
 * its answer waits until released.
 */
async function heldStatusReads(page: Page, count: number, armed: () => boolean) {
  const gates = Array.from({ length: count }, () => Promise.withResolvers<void>());
  const fetched = new Set<number>();
  let reads = 0;
  await page.route(isOperationUrl, async (route) => {
    if (!armed() || route.request().postDataJSON()?.command !== "status") return route.fallback();
    const n = reads++;
    if (n >= count) return route.fallback();
    const response = await route.fetch();
    fetched.add(n);
    await gates[n]!.promise;
    await route.fulfill({ response });
  });
  return {
    reads: () => reads,
    fetched: (n: number, what: string) => waitFor(() => fetched.has(n), what),
    release: (n: number) => gates[n]!.resolve(),
    releaseAll: () => {
      for (const gate of gates) gate.resolve();
    },
  };
}

/** Sends the page's next delete to the real bridge, then drops its reply like a cut connection. */
async function loseNextDeleteReply(page: Page) {
  let lost = false;
  await page.route(isOperationUrl, async (route) => {
    if (lost || route.request().postDataJSON()?.command !== "delete") return route.continue();
    lost = true;
    await route.fetch();
    await route.abort();
  });
}

const deletesOf = (page: Page) => {
  const deletes: any[] = [];
  page.on("request", (request) => {
    if (operationOf(request)?.command === "delete") deletes.push(operationOf(request));
  });
  return deletes;
};

// The viewer's styles hash its class names, so pages are read by role and structure.
const sessionRows = (page: Page) =>
  page.getByRole("list", { name: "Saved sessions" }).getByRole("listitem");

const crumbIs = (page: Page, text: string) =>
  page.waitForFunction((expected) => document.querySelector("h1")?.textContent === expected, text);

/** The reader's file headers in order; each names its full path. */
const fileHeadings = (page: Page) =>
  page
    .getByRole("main")
    .getByRole("heading", { level: 2 })
    .evaluateAll((headings) => headings.map((heading) => heading.getAttribute("aria-label")));

/** The status line, which names the Vim cursor's place, the selection and Viewed progress. */
const statusLine = (page: Page) => page.getByRole("contentinfo");
/** Waits for the status line to say exactly `text`, such as `long.ts:97 · new`. */
const says = (page: Page, text: string) =>
  statusLine(page).getByText(text, { exact: true }).waitFor();
/** The Vim cursor's accent bar over a code line or hidden range. */
const cursorBar = (page: Page) => page.getByRole("main").locator("[data-cursor][aria-hidden=true]");
/** Presses keys in order, from the page rather than a focused control. */
async function keys(page: Page, ...pressed: string[]) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const key of pressed) await page.keyboard.press(key);
}
/** Waits until the cursor bar covers a copy of the line `text`, on the bar's own column. */
const barOn = (page: Page, text: string) =>
  waitFor(async () => {
    const bar = await cursorBar(page).boundingBox();
    if (bar === null) return false;
    for (const copy of await page.getByRole("main").getByText(text, { exact: true }).all()) {
      const box = await copy.boundingBox();
      if (box && Math.abs(box.y - bar.y) < 4 && box.x >= bar.x && box.x < bar.x + bar.width)
        return true;
    }
    return false;
  }, `the cursor bar on ${text}`);
/** A file header's fold toggle, whichever way it points. */
const foldToggle = (page: Page, path: string) =>
  page
    .getByRole("main")
    .getByRole("button", { name: new RegExp(`^(Fold|Unfold) ${path.replace(/[.]/g, "\\.")}$`) });
const viewedBox = (page: Page, path: string) =>
  page.getByRole("main").getByRole("checkbox", { name: `${path} viewed`, exact: true });
const viewedOf = (page: Page) => {
  const writes: any[] = [];
  page.on("request", (request) => {
    if (operationOf(request)?.command === "viewed") writes.push(operationOf(request));
  });
  return writes;
};
/** The revisions the page's answered status reads returned, in order. */
const statusReadsOf = (page: Page) => {
  const revisions: number[] = [];
  page.on("response", async (response) => {
    if (operationOf(response.request())?.command !== "status") return;
    const reply = await response.json().catch(() => undefined);
    if (reply?.ok) revisions.push(reply.value.revision);
  });
  return revisions;
};
/** Where the reader is: its status line without the progress count, and its panel's scroll. */
const positionOf = async (page: Page) => ({
  status: (await statusLine(page).innerText()).replace(/\d+\/\d+ hunks? viewed/, ""),
  scrollTop: await page.getByRole("main").evaluate((main) => {
    const scroller = [main, ...main.querySelectorAll("*")].find(
      (element) =>
        getComputedStyle(element).overflowY === "auto" &&
        element.scrollHeight > element.clientHeight,
    );
    return scroller?.scrollTop;
  }),
});

/** A fresh saved session of `range`, deleted after the test: later tests count saved sessions. */
async function freshSession(range = "main...live") {
  const id = await openRange(range);
  onTestFinished(() =>
    gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
  );
  return id;
}
/** A foreground launch of a saved session, stopped like Ctrl-C after the test. */
async function launchFor(id: string) {
  const launched = await launch("--session", id);
  onTestFinished(async () => {
    await stop(launched.proc, "SIGINT");
  });
  return launched;
}
/** A CLI apply of no ops: a change committed elsewhere that only raises the revision. */
async function applyFromCli(id: string): Promise<number> {
  const { revision } = await gyst("session", "status", "--session", id);
  const batch = { revision, idempotencyKey: randomBytes(16).toString("hex"), ops: [] };
  const applied = await run(installed.bin, ["session", "apply", "--session", id], {
    cwd: repo,
    env,
    stdin: JSON.stringify(batch),
  });
  return json(applied).revision;
}

/**
 * A raw request to a launch's listener with explicit headers, as a hostile client could send;
 * resolves its status.
 */
const raw = (
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
) =>
  new Promise<number | undefined>((resolve, reject) => {
    const { method = "GET", path = "/", headers = {}, body } = options;
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, setHost: false },
      (response) => {
        response.once("error", reject);
        // An accepted event stream stays open: its status is all there is to read.
        if (response.headers["content-type"]?.startsWith("text/event-stream")) {
          resolve(response.statusCode);
          return request.destroy();
        }
        response.once("end", () => resolve(response.statusCode));
        response.resume();
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error(`${method} ${path} timed out`)));
    request.once("error", reject);
    request.end(body);
  });

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
  });

/** The first executable `name` on PATH or in `extra` directories. */
function executable(name: string, extra: ReadonlyArray<string> = []): string | undefined {
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return undefined;
}

/** OpenSSH executables from PATH, plus /usr/sbin where Ubuntu keeps sshd. */
function openssh(name: string): string {
  const file = executable(name, ["/usr/sbin"]);
  if (file === undefined) throw new Error(`OpenSSH ${name} is not on PATH or in /usr/sbin`);
  return file;
}

describe("installed gyst in a sandboxed browser", () => {
  let one: Launch;
  let two: Launch;
  let four: Launch;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(homedir(), ".gyst-browser-")));
    const home = join(root, "home");
    data = join(root, "data");
    repo = join(root, "demo");
    await mkdir(home);
    await mkdir(repo);
    await mkdir(join(root, "tmp"));
    env = isolatedEnv(home, { GYST_DATA_DIR: data });
    for (const name of ["SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[name];

    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@gyst.invalid");
    git("config", "user.name", "t");
    await writeFile(join(repo, "app.ts"), `const a = 1;\nconst b = '${hostile}';\ncontext();\n`);
    await writeFile(
      join(repo, "README.md"),
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join(""),
    );
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "long.ts"), longTs(false));
    git("add", ".");
    git("commit", "-qm", "init");
    // bulk...paged: the snapshot holds the whole tree (these 400 unchanged files, app.ts, README.md,
    // src/long.ts and paged.ts), more than one 64 KiB files page; paged~1 is another snapshot of the
    // same files for a refresh between pages.
    git("switch", "-qc", "bulk");
    await mkdir(join(repo, "bulk"));
    for (let i = 0; i < 400; i++)
      await writeFile(join(repo, "bulk", `${String(i).padStart(3, "0")}.txt`), "bulk\n");
    git("add", ".");
    git("commit", "-qm", "bulk");
    git("switch", "-qc", "paged");
    for (const version of ["v1", "v2"]) {
      await writeFile(join(repo, "paged.ts"), `${version}\n`);
      git("add", ".");
      git("commit", "-qm", version);
    }
    // stress~1...stress modifies line 10 of the 400 bulk files, now 20 lines each: hundreds of
    // files whose sides load eagerly, each with a leading and a trailing hidden range.
    git("switch", "-q", "bulk");
    git("switch", "-qc", "stress");
    for (const edited of [false, true]) {
      for (let i = 0; i < 400; i++)
        await writeFile(
          join(repo, "bulk", `${String(i).padStart(3, "0")}.txt`),
          Array.from(
            { length: 20 },
            (_, n) => `bulk ${i} line ${n + 1}${edited && n === 9 ? " edited" : ""}\n`,
          ).join(""),
        );
      git("add", ".");
      git("commit", "-qm", edited ? "stress" : "stress base");
    }
    // large~1...large edits line 1500 of big.ts's 3000, about 87 KiB a side (two code pages), and
    // line 1 of small.ts's 10.
    git("switch", "-q", "main");
    git("switch", "-qc", "large");
    for (const edited of [false, true]) {
      await writeFile(
        join(repo, "big.ts"),
        Array.from(
          { length: 3000 },
          (_, i) => `export const big${i + 1} = ${i + 1}${edited && i === 1499 ? " * 2" : ""};\n`,
        ).join(""),
      );
      await writeFile(
        join(repo, "small.ts"),
        Array.from(
          { length: 10 },
          (_, i) => `export const small${i + 1} = ${i + 1}${edited && i === 0 ? " * 2" : ""};\n`,
        ).join(""),
      );
      git("add", ".");
      git("commit", "-qm", edited ? "large" : "large base");
    }
    // main...live edits README.md, app.ts and src/long.ts once each: three hunks in three files,
    // a fresh saved session for each live-review test.
    git("switch", "-q", "main");
    git("switch", "-qc", "live");
    await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 'live-edit';\ncontext();\n");
    await writeFile(
      join(repo, "README.md"),
      `${await readFile(join(repo, "README.md"), "utf8")}A live line\n`,
    );
    await writeFile(join(repo, "src", "long.ts"), longTs(true));
    git("add", ".");
    git("commit", "-qm", "live");
    git("switch", "-q", "main");
    git("switch", "-qc", "feature");
    await writeFile(join(repo, "feature.ts"), "export const feature = 'range-only';\n");
    git("add", ".");
    git("commit", "-qm", "feature");
    git("branch", "topic-a");
    git("branch", "topic-b");
    await writeFile(
      join(repo, "app.ts"),
      "const a = 1;\nconst b = 'uncommitted-edit';\ncontext();\n",
    );
    await writeFile(
      join(repo, "README.md"),
      `${await readFile(join(repo, "README.md"), "utf8")}A new line`,
    );
    await writeFile(join(repo, "src", "long.ts"), longTs(true));
    // Untracked binary: captured as an unavailable side, never as text.
    await writeFile(join(repo, "logo.bin"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]));

    // Without either, Playwright's chrome channel finds Google Chrome's standard install location.
    const chromiumPath =
      process.env.CHROMIUM_PATH ??
      ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
        .map((name) => executable(name))
        .find((file) => file !== undefined);
    browser = await chromium.launch({
      ...(chromiumPath ? { executablePath: chromiumPath } : { channel: "chrome" }),
      chromiumSandbox: true,
      headless: true,
      timeout: 20_000,
      // Proxy bypass selects direct transport; .localhost resolves natively (no hosts/resolver maps).
      proxy: { server: "http://127.0.0.1:9", bypass: ".localhost,127.0.0.1" },
      env: { ...env, TMPDIR: join(root, "tmp") },
    });
    context = await browser.newContext();
  }, 30_000);

  afterAll(async () => {
    try {
      await browser?.close();
      for (const proc of owned.toReversed())
        await stop(proc, "SIGTERM").catch(() => stop(proc, "SIGKILL"));
      if (data) await stopDaemon(data);
      if (root) {
        const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = [root, installed.prefix].map(escape).join("|");
        const found = spawnSync("pgrep", ["-a", "-f", pattern], { encoding: "utf8" });
        expect([0, 1]).toContain(found.status);
        expect(found.stdout, "processes left by the browser tests").toBe("");
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs Chromium sandboxed", async () => {
    const page = await context.newPage();
    onTestFinished(() => page.close());
    await page.goto("chrome://sandbox/");
    expect(await page.locator("body").innerText()).toMatch(/You are adequately sandboxed/);
  });

  it("opens the root launch's uncommitted scope at its deep path and strips the fragment", async () => {
    one = await launch();
    const page = await newPage();
    const requests: PageRequest[] = [];
    page.on("request", (request) => requests.push(request));
    await go(page, one.url);
    const pane = page.getByRole("main");
    await pane.getByText("uncommitted-edit").waitFor();
    expect(await pane.getByText("range-only").count()).toBe(0);
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(page.url()).pathname).toBe(one.path);
    expect(await page.evaluate(() => location.href.includes("#"))).toBe(false);
    await crumbIs(page, "demo/uncommitted changes");
    expect(await page.getByRole("heading", { level: 1 }).getAttribute("title")).toBe(repo);
    const { sessions } = await gyst("session", "list");
    expect(sessions).toEqual([
      expect.objectContaining({ id: one.id, scope: { kind: "uncommitted" } }),
    ]);

    const scripts = requests
      .filter((request) => request.resourceType() === "script")
      .map((request) => new URL(request.url()).pathname);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((path) => !/^\/assets\/[^/]+\.js$/.test(path))).toEqual([]);
    const bootstraps = requests.filter((r) => new URL(r.url()).pathname === "/bootstrap");
    expect(bootstraps.map((r) => r.method())).toEqual(["POST"]);
    const bootstrap = await bootstraps[0]!.allHeaders();
    expect(bootstrap.authorization === `Bearer ${one.secret}`).toBe(true);
    expect(bootstrap.origin).toBe(one.origin);
    const operations = requests.filter((r) => operationOf(r) !== undefined);
    // Eager captured-content reads are bounded and checked in their own test.
    const reads = operations.map(operationOf).filter((op) => op.command !== "code");
    expect(reads.sort((a, b) => a.command.localeCompare(b.command))).toEqual([
      { command: "diff", session: one.id },
      { command: "files", session: one.id, snapshotId: sessions[0].snapshotId },
      { command: "open", session: one.id },
      { command: "status", session: one.id },
    ]);
    for (const request of operations) {
      const headers = await request.allHeaders();
      expect([headers.origin, headers["content-type"], headers.authorization]).toEqual([
        one.origin,
        "application/json",
        undefined,
      ]);
    }

    const [cookie, ...others] = (await context.cookies(one.origin)).filter(
      (c) => c.name === "gyst_auth",
    );
    expect(others).toEqual([]);
    expect([cookie?.domain, cookie?.path, cookie?.httpOnly, cookie?.sameSite]).toEqual([
      one.hostname,
      "/",
      true,
      "Strict",
    ]);
    expect(await page.evaluate(() => document.cookie)).toBe("");

    // The captured hostile line renders as text in the continuous diff, never as markup.
    expect(await pane.getByText(hostile).count()).toBe(1);
    expect(await pane.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
    // The whole snapshot's changes read by default, one compact header per file in path order; a
    // change without captured text says why instead of showing content.
    expect(await fileHeadings(page)).toEqual(["README.md", "app.ts", "logo.bin", "src/long.ts"]);
    await pane.getByText("New side not captured: binary.").waitFor();
    // The snapshot-wide tree lists the unchanged supporting file too; changes carry a status word.
    const tree = page.getByRole("navigation", { name: "gyst" });
    for (const name of ["app.ts (modified)", "logo.bin (added)", "feature.ts", "src/"])
      await tree.getByRole("button", { name, exact: true }).waitFor();
  }, 30_000);

  it("loads visible files' captured sides eagerly, a bounded few at a time, so every hidden range shows its exact count", async () => {
    const page = await newPage();
    const codes: any[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const settle = (request: PageRequest) => {
      if (operationOf(request)?.command === "code") inFlight--;
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const operation = route.request().postDataJSON();
      if (operation?.command === "code") {
        codes.push(operation);
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await released;
      }
      await route.continue();
    });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    // README.md's hunk starts at line 8; src/long.ts's at line 97. Both counts come from the hunks.
    await pane.getByText("7 unmodified lines").first().waitFor();
    await pane.getByText("96 unmodified lines").first().waitFor();
    // Without a click, the visible files' sides are read: two files at a time, two sides each.
    const loading = pane
      .getByRole("heading", { name: "README.md", exact: true })
      .locator("..")
      .getByRole("status")
      .filter({ hasText: "Loading the captured file…" });
    try {
      await loading.waitFor();
      await waitFor(async () => codes.length === 4, "four code reads");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(codes.length).toBe(4);
    } finally {
      release();
    }
    // src/long.ts's trailing range (lines 184-300) shows the renderer's count once its sides load.
    await pane.getByText("117 unmodified lines").first().waitFor();
    await loading.waitFor({ state: "detached" });
    expect(await pane.getByRole("status").count()).toBe(0);
    // Each changed text file's two sides, read once, from the session's snapshot.
    const { snapshotId } = (await gyst("session", "list")).sessions[0];
    const reads = codes.map(({ file, side, snapshotId: read }) => `${file} ${side} ${read}`);
    expect(reads.sort()).toEqual(
      ["README.md", "app.ts", "src/long.ts"]
        .flatMap((file) => [`${file} new ${snapshotId}`, `${file} old ${snapshotId}`])
        .sort(),
    );
    expect(mostInFlight).toBeLessThanOrEqual(4);
    // A loaded range opens on a click without another read; the other ranges stay hidden.
    await pane.getByText("7 unmodified lines").first().click();
    // Split shows a context line on both sides.
    await pane.getByText("line 3", { exact: true }).first().waitFor();
    for (const n of [1, 7]) await pane.getByText(`line ${n}`, { exact: true }).first().waitFor();
    expect(await pane.getByText("7 unmodified lines").count()).toBe(0);
    expect(await pane.getByText("96 unmodified lines").count()).toBeGreaterThan(0);
    expect(codes.length).toBe(6);
  }, 30_000);

  it("opens a range in a third file within the same request bound while two files' reads are held", async () => {
    const page = await newPage();
    const codes: any[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const settle = (request: PageRequest) => {
      if (operationOf(request)?.command === "code") inFlight--;
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const operation = route.request().postDataJSON();
      if (operation?.command === "code") {
        codes.push(operation);
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await released;
      }
      await route.continue();
    });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    try {
      await waitFor(async () => codes.length === 4, "two files' eager reads");
      // src/long.ts's leading range opens while the reads are held: it waits for a free slot.
      await pane.getByText("96 unmodified lines").first().click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(mostInFlight).toBeLessThanOrEqual(4);
    } finally {
      release();
    }
    await waitFor(
      async () => (await pane.getByText("96 unmodified lines").count()) === 0,
      "src/long.ts's range to open",
    );
    expect(mostInFlight).toBeLessThanOrEqual(4);
    // Each side read once: the opened file joined no duplicate read.
    expect(codes.filter(({ file }) => file === "src/long.ts")).toHaveLength(2);
  }, 30_000);

  it("loads a file eagerly on return when its opened range's read landed after the reader left it", async () => {
    const page = await newPage();
    const codes: any[] = [];
    let landed = 0;
    page.on("requestfinished", (request) => {
      const operation = operationOf(request);
      if (operation?.command === "code" && operation.file === "src/long.ts") landed++;
    });
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const operation = route.request().postDataJSON();
      if (operation?.command === "code") {
        codes.push(operation);
        if (operation.file === "src/long.ts") await released;
      }
      await route.continue();
    });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    const tree = page.getByRole("navigation", { name: "gyst" });
    const readsOf = (file: string) => codes.filter((code) => code.file === file).length;
    try {
      await waitFor(async () => readsOf("src/long.ts") === 2, "src/long.ts's eager reads");
      // Its leading range opens while its read is held: the renderer's request joins that read.
      await pane.getByText("96 unmodified lines").first().click();
      // The reader leaves for an unchanged file before the read lands; the renderer drops it.
      await tree.getByRole("button", { name: "feature.ts", exact: true }).click();
      await pane.getByText("No captured changes under feature.ts.").waitFor();
    } finally {
      release();
    }
    await waitFor(async () => landed === 2, "src/long.ts's held reads to land");
    await tree.getByRole("button", { name: "src/", exact: true }).click();
    // Without a click it loads again.
    await waitFor(async () => readsOf("src/long.ts") === 4, "src/long.ts read again");
    // Its trailing range (lines 184-300), below the panel, shows its count once scrolled to.
    await pane.hover();
    await page.mouse.wheel(0, 1500);
    await pane.getByText("117 unmodified lines").first().waitFor();
    expect(readsOf("src/long.ts")).toBe(4);
  }, 30_000);

  it("stops a multi-page file's opened range read before its next page once the reader selects another file, and loads it again on return", async () => {
    const id = await openRange("large~1...large");
    onTestFinished(() =>
      gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
    );
    // The renderer logs every `loadDiffFiles` rejection, this intentional cancellation included.
    const page = await newPage(context, {
      problems: [expect.stringMatching(/^console .*the file left the window/)],
    });
    const codes: any[] = [];
    let landed = 0;
    page.on("requestfinished", (request) => {
      const operation = operationOf(request);
      if (operation?.command === "code" && operation.file === "big.ts") landed++;
    });
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const operation = route.request().postDataJSON();
      if (operation?.command === "code") {
        codes.push(operation);
        // big.ts's first pages are held, so its second pages are not asked for yet.
        if (operation.file === "big.ts") await released;
      }
      await route.continue();
    });
    await page.goto(`${one.origin}/session/${id}`);
    const pane = page.getByRole("main");
    const tree = page.getByRole("navigation", { name: "gyst" });
    const pagesOf = (file: string, later: boolean) =>
      codes.filter((code) => code.file === file && (code.offset !== undefined) === later).length;
    try {
      await waitFor(async () => pagesOf("big.ts", false) === 2, "big.ts's first pages");
      // Its leading range opens while they are held: the renderer's request joins that read.
      await pane.getByText("1496 unmodified lines").first().click();
      await tree.getByRole("button", { name: "small.ts (modified)", exact: true }).click();
      await waitFor(
        async () => JSON.stringify(await fileHeadings(page)) === '["small.ts"]',
        "small.ts selected",
      );
    } finally {
      release();
    }
    await waitFor(async () => landed === 2, "big.ts's held first pages to land");
    // The selected file loads: its trailing range (lines 5-10) shows its count.
    await pane.getByText("6 unmodified lines").first().waitFor();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pagesOf("big.ts", true)).toBe(0);
    expect(await page.getByRole("alert").count()).toBe(0);

    await tree.getByRole("button", { name: "big.ts (modified)", exact: true }).click();
    // Without a click it loads again, every page, and its trailing range (lines 1504-3000) shows
    // its count.
    await waitFor(async () => pagesOf("big.ts", true) === 2, "big.ts's second pages");
    await pane.getByText("1497 unmodified lines").first().waitFor();
    expect(pagesOf("big.ts", false)).toBe(4);
    // Its leading range opens further on a click without another read, wherever the renderer kept
    // its earlier expansion; the first such separator is the leading one.
    const leading = pane.getByText(/^1\d{3} unmodified lines$/).first();
    const before = await leading.textContent();
    await leading.click();
    await waitFor(
      async () => (await pane.getByText(before!, { exact: true }).count()) === 0,
      "big.ts's leading range to open",
    );
    expect(codes.filter((code) => code.file === "big.ts")).toHaveLength(6);
    expect(await page.getByRole("alert").count()).toBe(0);
  }, 30_000);

  it("shows the captured changes under a selected file or folder, and the whole snapshot again", async () => {
    const page = await newPage();
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    const tree = page.getByRole("navigation", { name: "gyst" });
    await pane.getByText("uncommitted-edit").waitFor();
    const select = async (name: string) => {
      const button = tree.getByRole("button", { name, exact: true });
      await button.click();
      expect(await button.getAttribute("aria-current")).toBe("true");
    };
    await select("src/");
    await waitFor(
      async () => JSON.stringify(await fileHeadings(page)) === '["src/long.ts"]',
      "the folder's changes",
    );
    await select("app.ts (modified)");
    await waitFor(
      async () => JSON.stringify(await fileHeadings(page)) === '["app.ts"]',
      "the file's changes",
    );
    expect(await pane.getByText(hostile).count()).toBe(1);
    await select("feature.ts");
    await pane.getByText("No captured changes under feature.ts.").waitFor();
    await select("All changes");
    await waitFor(async () => (await fileHeadings(page)).length === 4, "every changed file");
  }, 30_000);

  it("lays the diff out split or stacked by available width, fits a narrow page and keeps the reading position across layout switches", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    const layout = page.getByRole("radiogroup", { name: "Diff layout" });
    const auto = (shown: string) => layout.getByRole("radio", { name: `Auto (${shown})` });
    await auto("split").waitFor();
    expect(await auto("split").isChecked()).toBe(true);
    // The renderer's documented layout attribute confirms what the control says.
    await pane.locator("[data-diff-type=split]").first().waitFor();
    // 1000px of viewport leaves the diff fewer than 120 columns once the sidebar takes its share.
    await page.setViewportSize({ width: 1000, height: 800 });
    await auto("stacked").waitFor();
    expect(await pane.locator("[data-diff-type=split]").count()).toBe(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await auto("split").waitFor();

    // Read from a context line inside src/long.ts's hunk, then switch layouts both ways.
    await page.getByRole("button", { name: "src/", exact: true }).click();
    const line = pane.getByText("export const line112 = 112;").first();
    await line.evaluate((element) => element.scrollIntoView({ block: "start" }));
    // Out from under the sticky file header, so the line is the first one in view.
    await pane.hover();
    await page.mouse.wheel(0, -48);
    const nearTop = async () => {
      const [box, panel] = [await line.boundingBox(), await pane.boundingBox()];
      return box !== null && panel !== null && box.y >= panel.y + 30 && box.y < panel.y + 100;
    };
    await waitFor(nearTop, "the line at the top of the panel");
    await layout.getByRole("radio", { name: "Stacked", exact: true }).check();
    await waitFor(
      async () => (await pane.locator("[data-diff-type=split]").count()) === 0,
      "the stacked layout",
    );
    await waitFor(nearTop, "the same line at the top after stacking");
    await layout.getByRole("radio", { name: "Split", exact: true }).check();
    await pane.locator("[data-diff-type=split]").first().waitFor();
    await waitFor(nearTop, "the same line at the top after splitting");

    // A phone-width page stacks the diff and never scrolls sideways.
    await layout.getByRole("radio", { name: /^Auto/ }).check();
    await page.setViewportSize({ width: 390, height: 844 });
    await auto("stacked").waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // The footer wraps rather than clips: each control lies whole inside it and the page.
    const footer = statusLine(page);
    const controls = [
      layout.getByText("Split", { exact: true }),
      layout.getByText("Stacked", { exact: true }),
      layout.getByText("Auto (stacked)", { exact: true }),
      footer.getByText(/^\d+\/\d+ hunks? viewed in \d+ files?$/),
      footer.getByRole("button", { name: /^Keys/ }),
    ];
    for (const [at, control] of controls.entries())
      await waitFor(async () => {
        const [box, bounds] = await Promise.all([control.boundingBox(), footer.boundingBox()]);
        return (
          box !== null &&
          bounds !== null &&
          box.x >= Math.max(bounds.x, 0) &&
          box.y >= Math.max(bounds.y, 0) &&
          box.x + box.width <= Math.min(bounds.x + bounds.width, 390) &&
          box.y + box.height <= Math.min(bounds.y + bounds.height, 844)
        );
      }, `footer control ${at} inside the footer and the page`);
    await layout.getByText("Stacked", { exact: true }).click();
    expect(await layout.getByRole("radio", { name: "Stacked", exact: true }).isChecked()).toBe(
      true,
    );
    await layout.getByText("Auto (stacked)", { exact: true }).click();
    expect(await auto("stacked").isChecked()).toBe(true);
    await footer.getByRole("button", { name: /^Keys/ }).click();
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await help.waitFor();
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
  }, 30_000);

  it("keeps the reading position across layout switches after one jump far past the rendered files", async () => {
    // main...bulk adds 400 one-line files: far more than the renderer mounts at once.
    const id = await openRange("main...bulk");
    // Deleted even on failure: later tests count saved sessions.
    onTestFinished(() =>
      gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
    );
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}/session/${id}`);
    const pane = page.getByRole("main");
    await pane.getByRole("heading", { name: "bulk/000.txt", exact: true }).waitFor();
    /** The file whose header is at the top of the panel. */
    const topFile = () =>
      pane.evaluate((main) => {
        const panel = main.getBoundingClientRect().top;
        const below = [...main.querySelectorAll("h2")]
          .map((heading) => ({ heading, y: heading.getBoundingClientRect().top - panel }))
          .filter(({ y }) => y >= -1)
          .sort((a, b) => a.y - b.y)[0];
        return below !== undefined && below.y < 40
          ? below.heading.getAttribute("aria-label")
          : null;
      });
    const frames = () =>
      page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
    // One step to the middle, as a scrollbar drag lands: no scroll event passes the files between.
    await pane.evaluate((main) => {
      const scroller = [...main.querySelectorAll("*")].find(
        (element) => element.scrollHeight > element.clientHeight * 10,
      )!;
      scroller.scrollTop = scroller.scrollHeight / 2;
    });
    let destination: string | null = null;
    await waitFor(async () => {
      destination = await topFile();
      return destination !== null && /^bulk\/[1-2]\d\d\.txt$/.test(destination);
    }, "a file from the middle of the list at the top");
    const layout = page.getByRole("radiogroup", { name: "Diff layout" });
    for (const name of ["Stacked", "Split"]) {
      await layout.getByRole("radio", { name, exact: true }).check();
      await frames();
      await waitFor(
        async () => (await topFile()) === destination,
        `${destination} still at the top after the switch to ${name}`,
      );
    }
  }, 30_000);

  it("loads hundreds of changed files a bounded few at a time, far scrolls included, and navigates loaded files without reads", async () => {
    const id = await openRange("stress~1...stress");
    onTestFinished(() =>
      gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
    );
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    const started = { code: 0, files: 0 };
    const inFlight = { code: 0, files: 0 };
    const most = { code: 0, files: 0 };
    const settle = (request: PageRequest) => {
      const command = operationOf(request)?.command;
      if (command === "code" || command === "files") inFlight[command as "code" | "files"]--;
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
    await page.route(isOperationUrl, async (route) => {
      const command = route.request().postDataJSON()?.command;
      if (command === "code" || command === "files") {
        started[command as "code" | "files"]++;
        const count = ++inFlight[command as "code" | "files"];
        most[command as "code" | "files"] = Math.max(most[command as "code" | "files"], count);
        // A little latency, so concurrent requests overlap and are counted.
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await route.continue();
    });
    await page.goto(`${one.origin}/session/${id}`);
    const pane = page.getByRole("main");
    await pane.getByRole("heading", { name: "bulk/000.txt", exact: true }).waitFor();
    // First content shows long before the 400 files' 800 sides could have loaded.
    expect(started.code).toBeLessThan(800);
    // A loaded file's trailing range (lines 14-20) shows its count.
    await pane.getByText("7 unmodified lines").first().waitFor();
    const settled = async () => {
      let last = -1;
      await waitFor(async () => {
        const quiet = inFlight.code === 0 && started.code === last;
        last = started.code;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return quiet;
      }, "the eager loads to settle");
    };
    await settled();
    // Only the window and a few nearby files loaded, not the whole session.
    expect(started.code).toBeLessThan(100);

    // Moving between loaded files reads nothing more.
    const before = started.code;
    const at = await statusLine(page).textContent();
    await keys(page, "]", "f");
    await waitFor(async () => (await statusLine(page).textContent()) !== at, "the next file");
    await keys(page, "[", "f");
    await waitFor(
      async () => (await statusLine(page).textContent()) === at,
      "the first file again",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(started.code).toBe(before);

    // A far jump loads the files it lands on, still within the bounds.
    await pane.evaluate((main) => {
      const scroller = [...main.querySelectorAll("*")].find(
        (element) => element.scrollHeight > element.clientHeight * 10,
      )!;
      scroller.scrollTop = scroller.scrollHeight / 2;
    });
    await waitFor(async () => started.code > before, "reads for the files landed on");
    await settled();
    await pane.getByText("7 unmodified lines").first().waitFor();
    expect(started.code).toBeLessThan(before + 100);
    expect(most.code).toBeLessThanOrEqual(4);
    expect(most.files).toBeLessThanOrEqual(1);
  }, 60_000);

  it("reads from the selection just shown, not a file restored before it, after short selections", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    const tree = page.getByRole("navigation", { name: "gyst" });
    await pane.getByText("uncommitted-edit").waitFor();
    const select = async (name: string, headings: string[]) => {
      await tree.getByRole("button", { name, exact: true }).click();
      await waitFor(
        async () => JSON.stringify(await fileHeadings(page)) === JSON.stringify(headings),
        `${name} selected`,
      );
    };
    const topFile = () =>
      pane.evaluate((main) => {
        const panel = main.getBoundingClientRect().top;
        const below = [...main.querySelectorAll("h2")]
          .map((heading) => ({ heading, y: heading.getBoundingClientRect().top - panel }))
          .filter(({ y }) => y >= -1)
          .sort((a, b) => a.y - b.y)[0];
        return below !== undefined && below.y < 40
          ? below.heading.getAttribute("aria-label")
          : null;
      });
    // A layout switch on a file too short to scroll restores it at the very top.
    await select("app.ts (modified)", ["app.ts"]);
    await page
      .getByRole("radiogroup", { name: "Diff layout" })
      .getByRole("radio", { name: "Stacked", exact: true })
      .check();
    await select("README.md (modified)", ["README.md"]);
    // README.md, now being read, is what the whole snapshot returns to, not the earlier app.ts.
    await select("All changes", ["README.md", "app.ts", "logo.bin", "src/long.ts"]);
    await waitFor(async () => (await topFile()) === "README.md", "README.md at the top");
  }, 30_000);

  it("marks a file section Viewed from its header, shared by the snapshot and file views, folding and advancing, and keeps it across a reload", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(page);
    await page.goto(`${one.origin}${one.path}`);
    const tree = page.getByRole("navigation", { name: "gyst" });
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    const { hunks, snapshotId } = await gyst("session", "diff", "--session", one.id);
    const idsOf = (file: string) =>
      hunks
        .filter((hunk: { file: string }) => hunk.file === file)
        .map(({ id }: { id: string }) => id);
    await says(page, "0/3 hunks viewed in 4 files");

    // Checking sends one write for exactly the file's hunks, folds it and moves to the next file.
    await viewedBox(page, "README.md").check();
    await says(page, "1/3 hunks viewed in 4 files");
    expect(writes).toEqual([
      {
        command: "viewed",
        session: one.id,
        snapshotId,
        revision: expect.any(Number),
        requestId: expect.stringMatching(/^[0-9a-f]{32}$/),
        hunkIds: idsOf("README.md"),
        viewed: true,
      },
    ]);
    expect(await foldToggle(page, "README.md").getAttribute("aria-expanded")).toBe("false");
    await says(page, "app.ts · file");
    expect((await gyst("session", "status", "--session", one.id)).viewedHunkIds).toEqual(
      idsOf("README.md"),
    );

    // The file view reads the same Viewed hunks; unchecking there clears only that section.
    await tree.getByRole("button", { name: "README.md (modified)", exact: true }).click();
    expect(await viewedBox(page, "README.md").isChecked()).toBe(true);
    await viewedBox(page, "README.md").uncheck();
    await says(page, "0/1 hunk viewed in 1 file");
    expect(writes[1]).toMatchObject({ hunkIds: idsOf("README.md"), viewed: false });
    expect(writes[1].requestId).not.toBe(writes[0].requestId);
    await tree.getByRole("button", { name: "All changes", exact: true }).click();
    await says(page, "0/3 hunks viewed in 4 files");
    expect(await viewedBox(page, "README.md").isChecked()).toBe(false);

    // m marks the cursor's file and advances past files without hunks.
    await keys(page, "g", "g", "]", "f");
    await says(page, "app.ts · file");
    await keys(page, "m");
    await says(page, "1/3 hunks viewed in 4 files");
    await says(page, "long.ts · file");
    expect(writes[2]).toMatchObject({ hunkIds: idsOf("app.ts"), viewed: true });
    // Moving never writes Viewed.
    await keys(page, "j", "j", "k", "]", "c");
    expect(writes).toHaveLength(3);

    await page.reload();
    await viewedBox(page, "app.ts").waitFor();
    expect(await viewedBox(page, "app.ts").isChecked()).toBe(true);
    expect(await viewedBox(page, "README.md").isChecked()).toBe(false);
    await says(page, "1/3 hunks viewed in 4 files");
  }, 30_000);

  it("conflicts a stale Viewed write from another page without overwriting, and replays a lost reply with the same request id", async () => {
    const [first, second] = [await newPage(), await newPage()];
    // The second page stays deliberately stale: it never hears of the first page's write.
    await holdEvents(second);
    for (const page of [first, second]) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${one.origin}${one.path}`);
      await viewedBox(page, "src/long.ts").waitFor();
    }
    await viewedBox(first, "README.md").check();
    await says(first, "2/3 hunks viewed in 4 files");
    // The second page saw an older revision: its write conflicts, then it reads progress again,
    // so the box goes back unchecked.
    await viewedBox(second, "src/long.ts").click();
    await second
      .getByRole("main")
      .getByText("Not saved: progress changed elsewhere and was read again.")
      .waitFor();
    await says(second, "2/3 hunks viewed in 4 files");
    expect(await viewedBox(second, "src/long.ts").isChecked()).toBe(false);
    expect((await gyst("session", "status", "--session", one.id)).viewedHunkIds).toHaveLength(2);
    // Acting again is a new intent against what it read, and applies.
    await viewedBox(second, "src/long.ts").check();
    await says(second, "3/3 hunks viewed in 4 files");

    const third = await newPage(context, { problems: ["requestfailed /api/operation"] });
    await third.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(third);
    const commands: string[] = [];
    third.on("request", (request) => {
      const operation = operationOf(request);
      if (operation) commands.push(operation.command);
    });
    let lost = false;
    await third.route(isOperationUrl, async (route) => {
      if (lost || route.request().postDataJSON()?.command !== "viewed") return route.continue();
      lost = true;
      await route.fetch();
      await route.abort();
    });
    await third.goto(`${one.origin}${one.path}`);
    await viewedBox(third, "src/long.ts").waitFor();
    await settled(third);
    commands.length = 0;
    // The daemon applies it and only the reply is lost. The page's stream announces the change,
    // so the page resends the same request, which its receipt answers, without a click.
    await viewedBox(third, "src/long.ts").click();
    await says(third, "2/3 hunks viewed in 4 files");
    // A replayed answer may replay history, so status is read again before any new write.
    await waitFor(
      async () => commands.join() === "viewed,viewed,status",
      "the replay and the status read after it",
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(await viewedBox(third, "src/long.ts").isChecked()).toBe(false);
    expect((await gyst("session", "status", "--session", one.id)).viewedHunkIds).toHaveLength(2);

    // A reread that fails blocks every write until a reload of the same snapshot reads progress.
    const fourth = await newPage(context, { responses: ["/api/operation 503"] });
    // Stale like the second page, so its write conflicts and its reread is the one refused.
    await holdEvents(fourth);
    await fourth.setViewportSize({ width: 1280, height: 800 });
    const blocked = viewedOf(fourth);
    await fourth.goto(`${one.origin}${one.path}`);
    await says(fourth, "2/3 hunks viewed in 4 files");
    await viewedBox(third, "src/long.ts").click();
    await says(third, "3/3 hunks viewed in 4 files");
    let unreadable = true;
    await fourth.route(isOperationUrl, async (route) => {
      if (!unreadable || route.request().postDataJSON()?.command !== "status")
        return route.continue();
      unreadable = false;
      await route.fulfill({ status: 503, body: "" });
    });
    await viewedBox(fourth, "app.ts").click();
    const unread = fourth
      .getByRole("main")
      .getByRole("alert")
      .filter({ hasText: "Progress can't be read again." });
    await unread.waitFor();
    await viewedBox(fourth, "app.ts").click();
    await viewedBox(fourth, "README.md").click();
    expect(blocked).toHaveLength(1);
    await unread.getByRole("button", { name: "Reload session" }).click();
    await unread.waitFor({ state: "detached" });
    await says(fourth, "3/3 hunks viewed in 4 files");
    // README.md, not app.ts: the daemon-restart test reads app.ts still Viewed.
    await viewedBox(fourth, "README.md").click();
    await says(fourth, "2/3 hunks viewed in 4 files");
    expect(blocked).toHaveLength(2);
    expect((await gyst("session", "status", "--session", one.id)).viewedHunkIds).toHaveLength(2);
  }, 30_000);

  it("walks the Vim cursor over headers, hidden ranges and lines with its bar on the line and side, keeping scrolloff, selection and layout", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    await pane.getByText("uncommitted-edit").waitFor();
    await says(page, "README.md · file");
    await keys(page, "]", "c");
    await says(page, "README.md:11 · new");
    await barOn(page, "A new line");
    await keys(page, "]", "c");
    await says(page, "app.ts:2 · new");
    await barOn(page, "const b = 'uncommitted-edit';");
    await keys(page, "h");
    await says(page, "app.ts:2 · old");
    await barOn(page, `const b = '${hostile}';`);
    await keys(page, "[", "c", "]", "f");
    await says(page, "app.ts · file");
    await keys(page, "]", "f", "[", "f");
    await says(page, "app.ts · file");

    await page.getByRole("button", { name: "src/", exact: true }).click();
    await pane.getByRole("heading", { name: "src/long.ts" }).waitFor();
    await keys(page, "g", "g", "j");
    await says(page, "long.ts · hidden lines");
    await keys(page, "j", "l");
    await says(page, "long.ts:97 · new");
    await barOn(page, "export const line97 = 97;");
    await keys(page, "h");
    await says(page, "long.ts:97 · old");
    await barOn(page, "export const line97 = 97;");
    await keys(page, "l");
    // Enter opens the hidden range; once its sides load the cursor is on its first line.
    await keys(page, "k", "Enter");
    await says(page, "long.ts:1 · new");
    await barOn(page, "export const line1 = 1;");

    // A held j keeps the cursor clear of the panel's bottom edge.
    await keys(page, "g", "g", ...Array.from({ length: 30 }, () => "j"));
    await says(page, "long.ts:30 · new");
    await barOn(page, "export const line30 = 30;");
    const panel = (await pane.boundingBox())!;
    await waitFor(async () => {
      const bar = await cursorBar(page).boundingBox();
      return bar !== null && bar.y + bar.height <= panel.y + panel.height - 80;
    }, "the cursor clear of the bottom edge");

    // A selection and the cursor survive layout switches.
    await keys(page, "Shift+V", "j", "j");
    await says(page, "3 lines selected");
    await keys(page, "2");
    await says(page, "long.ts:32");
    await says(page, "3 lines selected");
    await barOn(page, "export const line32 = 32;");
    await keys(page, "1");
    await says(page, "long.ts:32 · new");
    await says(page, "3 lines selected");
    await barOn(page, "export const line32 = 32;");
    await keys(page, "Escape");
    await statusLine(page).getByText("3 lines selected").waitFor({ state: "detached" });

    // Scrolling by hand pulls the cursor back into the panel.
    await pane.hover();
    await page.mouse.wheel(0, 1500);
    await waitFor(async () => {
      const box = await cursorBar(page).boundingBox();
      return (
        (await statusLine(page).getByText("long.ts:32 · new", { exact: true }).count()) === 0 &&
        box !== null &&
        box.y >= panel.y &&
        box.y + box.height <= panel.y + panel.height
      );
    }, "the cursor pulled back on screen");
    // The pulled-back cursor stands on the line its bar covers.
    const pulled = Number(/long\.ts:(\d+) · new/.exec(await statusLine(page).innerText())![1]);
    const doubled = (pulled >= 100 && pulled <= 110) || (pulled >= 114 && pulled <= 180);
    await barOn(page, `export const line${pulled} = ${pulled}${doubled ? " * 2" : ""};`);

    // A selecting cursor stays where a hand scroll leaves it; a layout switch then keeps the
    // reading position rather than scrolling back to it.
    await keys(page, "Shift+V");
    await says(page, "1 line selected");
    await pane.hover();
    await page.mouse.wheel(0, 1500);
    // Hidden or above: either way not in the panel.
    const above = async () => {
      const box = await cursorBar(page).boundingBox();
      return box === null || box.y + box.height <= panel.y;
    };
    await waitFor(above, "the selecting cursor left above the panel");
    await keys(page, "2");
    await waitFor(
      async () => (await pane.locator("[data-diff-type=split]").count()) === 0,
      "the stacked layout",
    );
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(await above()).toBe(true);
    await says(page, "1 line selected");
  }, 30_000);

  it("folds and unfolds files and opens hidden ranges with Enter, zo, zc, za, zR and zM; Esc never folds", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    const expanded = (path: string) => foldToggle(page, path).getAttribute("aria-expanded");
    const allExpanded = async (value: string) =>
      waitFor(
        async () => {
          const states = await Promise.all(
            ["README.md", "app.ts", "src/long.ts"].map((path) => expanded(path)),
          );
          return states.every((state) => state === value);
        },
        `every file ${value === "true" ? "unfolded" : "folded"}`,
      );
    await says(page, "README.md · file");
    await keys(page, "Enter");
    await waitFor(async () => (await expanded("README.md")) === "false", "README.md folded");
    await keys(page, "Enter");
    await waitFor(async () => (await expanded("README.md")) === "true", "README.md unfolded");
    await keys(page, "Escape");
    expect(await expanded("README.md")).toBe("true");
    await keys(page, "z", "a");
    await waitFor(async () => (await expanded("README.md")) === "false", "za folds");
    await keys(page, "z", "o");
    await waitFor(async () => (await expanded("README.md")) === "true", "zo unfolds");
    await keys(page, "j", "Enter");
    await page.getByRole("main").getByText("line 1", { exact: true }).first().waitFor();
    await keys(page, "j", "z", "c");
    await waitFor(async () => (await expanded("README.md")) === "false", "zc folds");
    await says(page, "README.md · file");
    await keys(page, "z", "Shift+M");
    await allExpanded("false");
    await keys(page, "z", "Shift+R");
    await allExpanded("true");
    // Caps Lock types `M` without Shift: neither Viewed nor a fold. Bottom still runs after it.
    await keys(page, "M", "Shift+G");
    await waitFor(
      async () => /long\.ts/.test(await statusLine(page).innerText()),
      "Shift+G at the bottom",
    );
    await allExpanded("true");
    expect(await viewedBox(page, "README.md").isChecked()).toBe(false);
    await keys(page, "g", "g");
    await says(page, "README.md · file");
    // The header's toggle does the same by mouse.
    await foldToggle(page, "app.ts").click();
    await waitFor(async () => (await expanded("app.ts")) === "false", "app.ts folded by click");

    // A fold keeps the selection: it is there again when the file unfolds.
    await keys(page, "g", "g", "]", "c", "Shift+V", "k");
    await says(page, "2 lines selected");
    await foldToggle(page, "README.md").click();
    await waitFor(async () => (await expanded("README.md")) === "false", "README.md folded");
    await says(page, "2 lines selected");
    await foldToggle(page, "README.md").click();
    await waitFor(async () => (await expanded("README.md")) === "true", "README.md unfolded");
    await says(page, "2 lines selected");
  }, 30_000);

  it("scrolls with movement keys in Mouse mode, without a cursor, and selects lines with the hover + and by dragging", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    await page.getByRole("button", { name: "src/", exact: true }).click();
    await pane.getByRole("heading", { name: "src/long.ts" }).waitFor();
    await page
      .getByRole("radiogroup", { name: "Input mode" })
      .getByRole("radio", { name: "Mouse" })
      .check();
    expect(await cursorBar(page).isVisible()).toBe(false);
    expect(await statusLine(page).getByText("long.ts · file").count()).toBe(0);
    const line = pane.getByText("export const line99 = 99;", { exact: true }).last();
    const before = (await line.boundingBox())!.y;
    await keys(page, "j");
    await waitFor(async () => (await line.boundingBox())!.y < before - 40, "j scrolled down");
    await keys(page, "k");
    await waitFor(
      async () => Math.abs((await line.boundingBox())!.y - before) < 4,
      "k scrolled up",
    );

    // The renderer may redraw the hovered row once its scroll settles, taking the + with it; hover
    // again until the + selects the line.
    const plus = pane.locator("button[data-utility-button]").filter({ visible: true }).first();
    await waitFor(async () => {
      await line.hover();
      await plus.click({ timeout: 500 }).catch(() => {});
      return (await statusLine(page).getByText("1 line selected", { exact: true }).count()) === 1;
    }, "the hover + selecting the line");
    const from = (await pane
      .getByText("export const line97 = 97;", { exact: true })
      .last()
      .boundingBox())!;
    const to = (await line.boundingBox())!;
    await page.mouse.move(from.x - 20, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x - 20, to.y + 8, { steps: 5 });
    await page.mouse.up();
    await says(page, "3 lines selected");
    await keys(page, "Escape");
    await statusLine(page).getByText("3 lines selected").waitFor({ state: "detached" });
  }, 30_000);

  it("runs commands from a keyboard-operable ⌘K menu and lists the implemented keys in ? help, ignoring review keys while typing", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${one.origin}${one.path}`);
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    await says(page, "README.md · file");
    const focused = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        return {
          name: element.getAttribute("aria-label") ?? element.textContent,
          visible:
            element.matches(":focus-visible") && getComputedStyle(element).outlineStyle !== "none",
        };
      });

    await keys(page, "Control+k");
    const menu = page.getByRole("dialog", { name: "Command menu" });
    await menu.waitFor();
    expect(await focused()).toEqual({ name: "Search commands", visible: true });
    // Typing in the search box filters; it never moves the cursor.
    await page.keyboard.type("jk");
    expect(await menu.getByRole("combobox", { name: "Search commands" }).inputValue()).toBe("jk");
    await says(page, "README.md · file");
    await menu.getByRole("combobox").fill("");
    await page.keyboard.type("stacked");
    expect(await menu.getByRole("option").allTextContents()).toEqual(["Stacked diff2"]);
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    expect(await page.getByRole("radio", { name: "Stacked", exact: true }).isChecked()).toBe(true);

    await keys(page, "Meta+k");
    await menu.waitFor();
    const active = () => menu.getByRole("option", { selected: true }).innerText();
    const firstOption = await active();
    await page.keyboard.press("ArrowDown");
    expect(await active()).not.toBe(firstOption);
    // Past the menu's viewport the active option scrolls into view: ArrowUp from the first wraps
    // to the last.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    expect(await active()).toMatch(/^Keyboard shortcuts/);
    await waitFor(async () => {
      const [option, box] = await Promise.all([
        menu.getByRole("option", { selected: true }).boundingBox(),
        menu.boundingBox(),
      ]);
      return (
        option !== null &&
        box !== null &&
        option.y >= box.y &&
        option.y + option.height <= box.y + box.height
      );
    }, "the last option in view");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^Commands/ }).click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    await keys(page, "?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await help.waitFor();
    expect(await focused()).toEqual({ name: "Close Esc", visible: true });
    for (const label of ["Next change", "Fold every file", "Command menu"])
      await help.getByText(label, { exact: true }).waitFor();
    // Keys of later tickets are not listed.
    expect(await help.getByText(/Reply|comment|Resolve/i).count()).toBe(0);
    await page.keyboard.press("j");
    await says(page, "README.md · file");
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    await keys(page, "j");
    await says(page, "README.md · hidden lines");
  }, 30_000);

  it("pages the snapshot's files into the tree in the background and offers a session reload when a refresh replaced the snapshot between pages", async () => {
    const id = await openRange("bulk...paged");
    // Deleted even on failure: later tests count saved sessions.
    onTestFinished(() =>
      gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
    );
    const snapshotOf = async () =>
      (await gyst("session", "list")).sessions.find((session: { id: string }) => session.id === id)
        .snapshotId;
    const captured = await snapshotOf();
    const page = await newPage();
    const listings: any[] = [];
    page.on("request", (request) => {
      if (operationOf(request)?.command === "files") listings.push(operationOf(request));
    });
    // Later pages wait until the snapshot is replaced, so the first background page goes stale.
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const request = route.request().postDataJSON();
      if (request?.command === "files" && request.snapshotId === captured && request.after)
        await released;
      await route.continue();
    });
    await page.goto(`${one.origin}/session/${id}`);
    await crumbIs(page, "demo/bulk...paged");
    await expect.poll(() => listings.length).toBe(2);
    git("branch", "-f", "paged", "paged~1");
    await gyst("session", "refresh", "--session", id);
    const refreshed = await snapshotOf();
    expect(refreshed).not.toBe(captured);
    release();
    const tree = page.getByRole("navigation", { name: "gyst" });
    await tree.getByRole("alert").getByText("is not the current snapshot").waitFor();
    // The session's stream announced the refresh too.
    await statusLine(page).getByRole("alert").getByText("This session was refreshed.").waitFor();
    expect(await page.getByRole("button", { name: "Retry loading files" }).count()).toBe(0);
    await tree.getByRole("button", { name: "Reload session" }).click();
    // The last unchanged file arrives with the later page; the changed one was listed from the start.
    await tree.getByRole("button", { name: "Expand bulk" }).click();
    await tree.getByRole("button", { name: "bulk/399.txt", exact: true }).waitFor();
    await tree.getByRole("button", { name: "paged.ts (added)" }).waitFor();
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(
      await page.getByRole("button", { name: /Retry loading files|Reload session/ }).count(),
    ).toBe(0);
    expect(listings.at(-1)).toEqual({
      command: "files",
      session: id,
      snapshotId: refreshed,
      after: expect.stringMatching(/^bulk\/\d{3}\.txt$/),
    });
  }, 30_000);

  it("loads an added file listed only on a later files page, its trailing range opened, whichever reply lands first", async () => {
    // bulk...paged adds paged.ts; its manifest entry is on the second and last files page.
    const id = await openRange("bulk...paged");
    onTestFinished(() =>
      gyst("session", "delete", "--session", id, "--request-id", randomBytes(16).toString("hex")),
    );
    for (const first of ["code", "files"] as const) {
      const page = await newPage();
      const held = { code: 0, files: 0 };
      const finished = { code: 0, files: 0 };
      const gateOf = (operation: any) =>
        operation?.command === "code" && operation.file === "paged.ts"
          ? "code"
          : operation?.command === "files" && operation.after
            ? "files"
            : undefined;
      page.on("requestfinished", (request) => {
        const gate = gateOf(operationOf(request));
        if (gate) finished[gate]++;
      });
      const gates = { code: Promise.withResolvers<void>(), files: Promise.withResolvers<void>() };
      await page.route(isOperationUrl, async (route) => {
        const gate = gateOf(route.request().postDataJSON());
        if (gate) {
          held[gate]++;
          await gates[gate].promise;
        }
        await route.continue();
      });
      await page.goto(`${one.origin}/session/${id}`);
      const pane = page.getByRole("main");
      try {
        // Until its entry lands, paged.ts reads as a change, so its sides load eagerly.
        await waitFor(
          async () => held.code === 2 && held.files === 1,
          "paged.ts's reads and the later files page",
        );
        await pane.getByText("More unchanged context may be available").first().click();
        gates[first].resolve();
        await waitFor(async () => finished[first] === held[first], `the ${first} replies`);
      } finally {
        gates.code.resolve();
        gates.files.resolve();
      }
      await waitFor(
        async () => finished.code === 2 && finished.files === 1,
        `every reply, ${first} first`,
      );
      // An earlier test moves `paged` back a commit, so either version may be captured.
      await pane
        .getByText(/^v[12]$/)
        .first()
        .waitFor();
      await new Promise((resolve) => setTimeout(resolve, 300));
      // No false failure, no stale load status, and no range left to open.
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await pane.getByRole("status").count()).toBe(0);
      expect(await pane.getByText("More unchanged context may be available").count()).toBe(0);
    }

    // The files page lands first and rebuilds paged.ts as added; its eager reads then fail. The
    // failure no longer applies to a file with nothing to load, so no alert offers a retry.
    const page = await newPage(context, {
      responses: ["/api/operation 503", "/api/operation 503"],
    });
    let held = 0;
    const release = Promise.withResolvers<void>();
    const files = Promise.withResolvers<void>();
    await page.route(isOperationUrl, async (route) => {
      const operation = route.request().postDataJSON();
      if (operation?.command === "code" && operation.file === "paged.ts") {
        held++;
        await release.promise;
        return route.fulfill({ status: 503, body: "" });
      }
      if (operation?.command === "files" && operation.after) await files.promise;
      await route.continue();
    });
    await page.goto(`${one.origin}/session/${id}`);
    await waitFor(async () => held === 2, "paged.ts's eager reads");
    files.resolve();
    await page
      .getByRole("navigation", { name: "gyst" })
      .getByRole("button", { name: "paged.ts (added)" })
      .waitFor();
    release.resolve();
    await settled(page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.getByRole("main").getByRole("status").count()).toBe(0);
  }, 60_000);

  it("keeps the session across client navigation, cookie reload and a new tab; shows not-found views", async () => {
    const page = await newPage();
    let documents = 0;
    let bootstraps = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents++;
      if (new URL(request.url()).pathname === "/bootstrap") bootstraps++;
    });
    await page.goto(`${one.origin}${one.path}`);
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    await page.getByRole("link", { name: "All sessions" }).click();
    await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
    expect(await sessionRows(page).count()).toBe(1);
    expect(documents).toBe(1);
    await page.reload();
    await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
    // The launch cookie authorizes the deep link and the reload; no page here sent a secret.
    expect(bootstraps).toBe(0);
    // Each view's lazily split route chunks finish loading first, so the test's own next
    // navigation never aborts one and reads as a failed request.
    await page.waitForLoadState("networkidle");
    await page.goto(`${one.origin}/session/does-not-exist`);
    await page.getByRole("heading", { name: "Session not found" }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.goto(`${one.origin}/deliberately/unknown`);
    await page.getByRole("heading", { name: "Page not found" }).waitFor();
    const host = `${one.hostname}:${one.port}`;
    expect(await raw(one.port, { path: "/assets/missing.js", headers: { host } })).toBe(404);
  }, 30_000);

  it("shows Loading… while the session's real diff is held, then renders the bridge's reply", async () => {
    const page = await newPage();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const held: string[] = [];
    await page.route(isOperationUrl, async (route) => {
      if (route.request().postDataJSON()?.command === "diff") {
        held.push("diff");
        await released;
      }
      await route.continue();
    });
    const diffReply = page.waitForResponse((r) => r.request().postDataJSON()?.command === "diff");
    try {
      await page.goto(`${one.origin}${one.path}`);
      await page.getByRole("status").getByText("Loading…").waitFor();
      expect(held).toEqual(["diff"]);
      expect(await page.getByRole("main").getByText("uncommitted-edit").count()).toBe(0);
    } finally {
      release();
    }
    const reply = await diffReply;
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    expect(reply.status()).toBe(200);
    expect((await reply.json()).ok).toBe(true);
    // The page's loading state is gone; eager captured-file loads may still settle afterwards.
    await page
      .getByRole("status")
      .getByText("Loading…", { exact: true })
      .waitFor({ state: "detached" });
    await waitFor(
      async () => (await page.getByRole("status").count()) === 0,
      "every loading status settled",
    );
  }, 30_000);

  it("runs a concurrent range launch in the same profile on its own host and cookie", async () => {
    two = await launch("main...feature");
    expect(two.hostname).not.toBe(one.hostname);
    const page = await newPage();
    await go(page, two.url);
    await page.getByRole("main").getByText("range-only").waitFor();
    await crumbIs(page, "demo/main...feature");
    expect(await page.getByRole("main").getByText("uncommitted-edit").count()).toBe(0);
    const cookieOf = async (origin: string) =>
      (await context.cookies(origin)).filter((c) => c.name === "gyst_auth");
    const [first] = await cookieOf(one.origin);
    const [second] = await cookieOf(two.origin);
    expect(second?.domain).toBe(two.hostname);
    expect(first?.value === second?.value).toBe(false);
    expect((await cookieOf(two.origin)).length).toBe(1);
    await page.goto(`${one.origin}/`);
    await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
    expect(await sessionRows(page).count()).toBe(2);
  }, 30_000);

  it("tells a fresh browser it is not signed in and a foreign link that it expired", async () => {
    const guidance = /Run gyst \(or gyst --session <id>\)/;
    const fresh = await newPage(await browser!.newContext(), {
      responses: ["/api/operation 401"],
    });
    await fresh.goto(`${one.origin}/`);
    const notSignedIn = await fresh.getByRole("alert").innerText();
    expect(notSignedIn).toMatch(/This browser is not signed in to this gyst launch\./);
    // The launcher is live, so this 401 must not claim it stopped.
    expect(notSignedIn).not.toMatch(/expire|has stopped|ended/);
    expect(notSignedIn).toMatch(/until (its|that) gyst stops/);
    expect(notSignedIn).toMatch(guidance);

    const foreign = await newPage(await browser!.newContext(), {
      responses: ["/bootstrap 401", "/api/operation 401"],
    });
    await go(foreign, `${one.origin}/#${two.secret}`);
    const expired = await foreign.getByRole("alert").innerText();
    expect(expired).toMatch(/expired or belongs to another gyst launch/);
    expect(expired).toMatch(/10 minutes/);
    expect(expired).toMatch(guidance);
    expect(new URL(foreign.url()).hash).toBe("");
    expect([notSignedIn, expired].some((text) => text.includes(two.secret))).toBe(false);
  }, 30_000);

  it("answers hostile and malformed bridge requests with the exact status", async () => {
    const [cookie] = (await context.cookies(one.origin)).filter((c) => c.name === "gyst_auth");
    const [cookie2] = (await context.cookies(two.origin)).filter((c) => c.name === "gyst_auth");
    const host = `${one.hostname}:${one.port}`;
    const origin = `http://${host}`;
    const op = JSON.stringify({ command: "list" });
    const subscription = JSON.stringify({ session: one.id });
    const good = { host, origin, cookie: `gyst_auth=${cookie!.value}` };
    const post = (path: string, headers: Record<string, string>, body?: string) => ({
      method: "POST",
      path,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const bearer = `Bearer ${randomBytes(32).toString("base64url")}`;
    const cases = {
      "authorized list": [post("/api/operation", good, op), 200],
      "cross-launch cookie": [
        post("/api/operation", { ...good, cookie: `gyst_auth=${cookie2!.value}` }, op),
        401,
      ],
      "no cookie": [post("/api/operation", { host, origin }, op), 401],
      "wrong bootstrap": [post("/bootstrap", { host, origin, authorization: bearer }), 401],
      "no bootstrap": [post("/bootstrap", { host, origin }), 401],
      "other launch host": [
        post("/api/operation", { ...good, host: `${two.hostname}:${one.port}` }, op),
        403,
      ],
      "loopback host": [{ headers: { host: `127.0.0.1:${one.port}` } }, 403],
      "hostless port": [{ headers: { host: one.hostname } }, 403],
      "port 0": [{ headers: { host: `${one.hostname}:0` } }, 403],
      "userinfo authority": [{ headers: { host: `u@${host}` } }, 403],
      forwarded: [{ headers: { host, forwarded: "host=evil" } }, 403],
      "x-forwarded-host": [{ headers: { host, "x-forwarded-host": "evil" } }, 403],
      "cross origin": [
        post("/api/operation", { ...good, origin: "http://evil.localhost" }, op),
        403,
      ],
      "origin other port": [
        post("/api/operation", { ...good, origin: `http://${one.hostname}:1` }, op),
        403,
      ],
      "null origin": [post("/api/operation", { ...good, origin: "null" }, op), 403],
      "no origin": [post("/api/operation", { host, cookie: good.cookie }, op), 403],
      "GET operation": [{ path: "/api/operation", headers: good }, 405],
      "PUT shell": [{ method: "PUT", headers: good }, 405],
      "reserved api route": [{ path: "/api/other", headers: good }, 404],
      "reserved bootstrap subpath": [{ path: "/bootstrap/x", headers: good }, 404],
      "dot-dot traversal": [{ path: "/assets/../index.html", headers: good }, 400],
      "encoded traversal": [{ path: "/%2e%2e/etc/passwd", headers: good }, 400],
      "encoded slash": [{ path: "/assets%2findex.html", headers: good }, 400],
      backslash: [{ path: "/assets\\index.html", headers: good }, 400],
      "non-browser op": [
        post("/api/operation", good, JSON.stringify({ command: "shutdown" })),
        400,
      ],
      "excess field": [
        post("/api/operation", good, JSON.stringify({ command: "list", x: 1 })),
        400,
      ],
      // The session stream answers to the same rules as an operation.
      "authorized events": [post("/api/events", good, subscription), 200],
      "GET events": [{ path: "/api/events", headers: good }, 405],
      "events no origin": [post("/api/events", { host, cookie: good.cookie }, subscription), 403],
      "events cross origin": [
        post("/api/events", { ...good, origin: "http://evil.localhost" }, subscription),
        403,
      ],
      "events other launch host": [
        post("/api/events", { ...good, host: `${two.hostname}:${one.port}` }, subscription),
        403,
      ],
      "events forwarded": [
        post("/api/events", { ...good, forwarded: "host=evil" }, subscription),
        403,
      ],
      "events x-forwarded-host": [
        post("/api/events", { ...good, "x-forwarded-host": "evil" }, subscription),
        403,
      ],
      "events no cookie": [post("/api/events", { host, origin }, subscription), 401],
      "events cross-launch cookie": [
        post("/api/events", { ...good, cookie: `gyst_auth=${cookie2!.value}` }, subscription),
        401,
      ],
      "events malformed body": [post("/api/events", good, "{"), 400],
      "events excess field": [
        post("/api/events", good, JSON.stringify({ session: one.id, x: 1 })),
        400,
      ],
    } as const;
    const statuses: Record<string, number | undefined> = {};
    for (const [name, [options]] of Object.entries(cases))
      statuses[name] = await raw(one.port, options);
    expect(statuses).toEqual(
      Object.fromEntries(Object.entries(cases).map(([name, [, status]]) => [name, status])),
    );
  }, 30_000);

  it("deletes from the list only after confirmation, and replays the same request id", async () => {
    const page = await newPage();
    const deletes = deletesOf(page);
    await page.goto(`${two.origin}/`);
    const row = sessionRows(page).filter({ hasText: "main...feature" });
    await row.getByRole("button", { name: "Delete…" }).click();
    await row.getByRole("group", { name: "Confirm session deletion" }).getByText(two.id).waitFor();
    await row.getByRole("button", { name: "Cancel" }).click();
    await row.getByRole("button", { name: "Delete…" }).click();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Delete…" }).click();
    await row.getByRole("button", { name: "Cancel" }).waitFor();
    expect(deletes).toEqual([]);
    expect(await sessionIds()).toHaveLength(2);

    const [response] = await Promise.all([
      page.waitForResponse((r) => operationOf(r.request())?.command === "delete"),
      row.getByRole("button", { name: "Delete session" }).click(),
    ]);
    const payload = operationOf(response.request());
    expect(Object.keys(payload).sort()).toEqual(["command", "requestId", "session"]);
    expect(payload.session).toBe(two.id);
    expect(payload.requestId).toMatch(/^[0-9a-f]{32}$/);
    const deleted = { ok: true, value: { deleted: true, sessionId: two.id } };
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(deleted);
    await row.waitFor({ state: "detached" });
    expect(deletes).toHaveLength(1);

    const send = (body: string) =>
      page.evaluate(async (text) => {
        const reply = await fetch("/api/operation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: text,
          signal: AbortSignal.timeout(10_000),
        });
        return { status: reply.status, reply: await reply.json() };
      }, body);
    expect(await send(response.request().postData()!)).toEqual({ status: 200, reply: deleted });
    // A new intent for the now absent session is a domain error, also carried by a 200.
    const requestId = randomBytes(16).toString("hex");
    expect(await send(JSON.stringify({ ...payload, requestId }))).toEqual({
      status: 200,
      reply: { ok: false, error: expect.objectContaining({ code: "no_session" }) },
    });
    expect(await sessionIds()).toEqual([one.id]);
    await page.reload();
    await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
    expect(await sessionRows(page).count()).toBe(1);
    expect(await page.getByText(two.id).count()).toBe(0);
  }, 30_000);

  it("retries a delete whose reply was lost after the daemon applied it with the same request id", async () => {
    const id = await openRange("main...topic-a");
    const page = await newPage(context, { problems: ["requestfailed /api/operation"] });
    const deletes = deletesOf(page);
    await loseNextDeleteReply(page);
    await page.goto(`${one.origin}/`);
    const row = sessionRows(page).filter({ hasText: "main...topic-a" });
    await row.getByRole("button", { name: "Delete…" }).click();
    await row.getByRole("button", { name: "Delete session" }).click();
    await row.getByRole("alert").waitFor();
    expect(await sessionIds()).toEqual([one.id]);
    await row.getByRole("button", { name: "Retry delete" }).click();
    await row.waitFor({ state: "detached" });
    expect(deletes).toHaveLength(2);
    expect(deletes[0].session).toBe(id);
    expect(deletes[1]).toEqual(deletes[0]);
    expect(await sessionRows(page).count()).toBe(1);
  }, 30_000);

  it("does not carry B's lost-reply retry to A after a history switch", async () => {
    const a = await openRange("main...topic-a");
    const b = await openRange("main...topic-b");
    const page = await newPage(context, { problems: ["requestfailed /api/operation"] });
    const deletes = deletesOf(page);
    const top = page.getByRole("banner");
    await page.goto(`${one.origin}/session/${a}`);
    await crumbIs(page, "demo/main...topic-a");
    await top.getByRole("link", { name: "All sessions" }).click();
    await page.getByRole("link", { name: /main\.\.\.topic-b/ }).click();
    await crumbIs(page, "demo/main...topic-b");
    await loseNextDeleteReply(page);
    await top.getByRole("button", { name: "Delete…" }).click();
    await top.getByRole("button", { name: "Delete session" }).click();
    await top.getByRole("button", { name: "Retry delete" }).waitFor();
    const lostB = deletes.at(-1);
    expect(lostB.session).toBe(b);
    await page.evaluate(() => history.go(-2));
    await crumbIs(page, "demo/main...topic-a");
    expect(await top.getByRole("button", { name: "Retry delete" }).count()).toBe(0);
    expect(await top.getByRole("group").count()).toBe(0);
    await top.getByRole("button", { name: "Delete…" }).click();
    await top.getByRole("group").getByText(a).waitFor();
    await top.getByRole("button", { name: "Delete session" }).click();
    await page.waitForURL(`${one.origin}/`);
    const deleteA = deletes.at(-1);
    expect(deleteA.session).toBe(a);
    expect(deleteA.requestId).not.toBe(lostB.requestId);
    expect(await sessionIds()).toEqual([one.id]);
  }, 30_000);

  it("leaves B selected when a held delete of A settles while B is shown", async () => {
    const a = await openRange("main...topic-a");
    const b = await openRange("main...topic-b");
    const page = await newPage();
    const top = page.getByRole("banner");
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    let held = false;
    await page.route(isOperationUrl, async (route) => {
      if (route.request().postDataJSON()?.command === "delete") {
        held = true;
        await released;
      }
      await route.continue();
    });
    try {
      await page.goto(`${one.origin}/session/${a}`);
      await crumbIs(page, "demo/main...topic-a");
      await top.getByRole("button", { name: "Delete…" }).click();
      await top.getByRole("button", { name: "Delete session" }).click();
      await top.getByRole("button", { name: "Deleting…" }).waitFor();
      await waitFor(() => held, "the delete to reach the route");
      await top.getByRole("link", { name: "All sessions" }).click();
      await page.getByRole("link", { name: /main\.\.\.topic-b/ }).click();
      await crumbIs(page, "demo/main...topic-b");
    } finally {
      release();
    }
    await page.waitForResponse((r) => operationOf(r.request())?.command === "delete");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(new URL(page.url()).pathname).toBe(`/session/${b}`);
    await crumbIs(page, "demo/main...topic-b");
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await sessionIds()).toEqual(expect.arrayContaining([one.id, b]));
    expect(await sessionIds()).not.toContain(a);
  }, 30_000);

  it("keeps console diagnostics for an unreadable or internal-error reply, not for an outage", async () => {
    const [b] = (await sessionIds()).filter((id: string) => id !== one.id);
    const page = await newPage(context, {
      // The outage fails each of the load's three reads: open, diff and status.
      responses: ["/api/operation 503", "/api/operation 503", "/api/operation 503"],
      problems: [
        expect.stringContaining("can't read"),
        expect.stringContaining("injected internal failure"),
      ],
    });
    let fault: "malformed" | "internal" | "outage" = "malformed";
    await page.route(isOperationUrl, async (route) => {
      const { command } = route.request().postDataJSON();
      const reply = (status: number, body?: unknown) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: body === undefined ? "" : JSON.stringify(body),
        });
      if (fault === "outage") return reply(503);
      if (fault === "malformed" && command === "diff")
        return reply(200, { ok: true, value: { sessionId: b, revision: 0, hunks: [], extra: 1 } });
      if (fault === "internal" && command === "open")
        return reply(200, {
          ok: false,
          error: { code: "internal_error", message: "injected internal failure" },
        });
      return route.continue();
    });
    await page.goto(`${one.origin}/session/${b}`);
    await page.getByRole("alert").getByText("can't read").waitFor();
    // The error shows before the session route's chunk finishes loading; navigating again would
    // abort that fetch.
    await page.waitForLoadState("networkidle");
    fault = "internal";
    await page.goto(`${one.origin}/session/${b}`);
    await page.getByRole("alert").getByText("injected internal failure").waitFor();
    await page.waitForLoadState("networkidle");
    fault = "outage";
    await page.goto(`${one.origin}/session/${b}`);
    await page.getByRole("alert").getByText("Can't reach gyst").waitFor();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  }, 30_000);

  it("returns to a fresh saved-session list after deleting from the session page", async () => {
    const [b] = (await sessionIds()).filter((id: string) => id !== one.id);
    const page = await newPage();
    const top = page.getByRole("banner");
    await page.goto(`${one.origin}/`);
    await sessionRows(page).first().waitFor();
    await page.getByRole("link", { name: /main\.\.\.topic-b/ }).click();
    await crumbIs(page, "demo/main...topic-b");
    await top.getByRole("button", { name: "Delete…" }).click();
    await top.getByRole("button", { name: "Delete session" }).click();
    await page.waitForURL(`${one.origin}/`);
    await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
    expect(await sessionRows(page).count()).toBe(1);
    expect(await page.getByText(b).count()).toBe(0);
    expect(await sessionIds()).toEqual([one.id]);
  }, 30_000);

  it("stops each viewer with 130 on SIGINT and keeps the daemon and saved sessions", async () => {
    const daemon = await daemonPid(data);
    expect(ownDaemon(daemon)).toBe(true);
    expect(await stop(one.proc, "SIGINT")).toBe(130);
    expect(await stop(two.proc, "SIGINT")).toBe(130);
    expect(ownDaemon(daemon)).toBe(true);
    expect(await sessionIds()).toEqual([one.id]);
  }, 30_000);

  it("reuses the saved scope after moved refs and a daemon restart, and reopens it by exact id", async () => {
    const [saved] = (await gyst("session", "list")).sessions;
    const daemon = await killDaemon(data, "SIGTERM");
    git("commit", "-qam", "move feature");
    const three = await launch();
    expect(three.id).toBe(one.id);
    const replacement = await daemonPid(data);
    expect(replacement).not.toBe(daemon);
    expect(ownDaemon(replacement)).toBe(true);
    expect(isAlive(daemon)).toBe(false);
    four = await launch("--session", one.id);
    expect(four.id).toBe(one.id);
    const page = await newPage();
    await go(page, four.url);
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    // Viewed progress was saved with the session and survives the restart.
    await viewedBox(page, "app.ts").waitFor();
    expect(await viewedBox(page, "app.ts").isChecked()).toBe(true);
    expect(await stop(three.proc, "SIGINT")).toBe(130);
    const [reopened] = (await gyst("session", "list")).sessions;
    expect([reopened.id, reopened.snapshotId]).toEqual([saved.id, saved.snapshotId]);
    expect(await daemonPid(data)).toBe(replacement);
  }, 30_000);

  it("serves the viewer through a key-authenticated SSH local forward on another port", async () => {
    const ssh = join(root, "ssh");
    await mkdir(ssh, { mode: 0o700 });
    for (const name of ["host", "client"])
      execFileSync(
        openssh("ssh-keygen"),
        ["-q", "-t", "ed25519", "-N", "", "-C", "gyst-e2e", "-f", join(ssh, name)],
        { stdio: "ignore" },
      );
    await writeFile(join(ssh, "auth"), await readFile(join(ssh, "client.pub")), { mode: 0o600 });
    const sshPort = await freePort();
    let forward: number;
    do forward = await freePort();
    while (forward === sshPort || forward === four.port);
    const hostKey = (await readFile(join(ssh, "host.pub"), "utf8")).split(/\s+/).slice(0, 2);
    await writeFile(join(ssh, "known"), `[127.0.0.1]:${sshPort} ${hostKey.join(" ")}\n`, {
      mode: 0o600,
    });
    const user = userInfo().username;
    await writeFile(
      join(ssh, "sshd_config"),
      `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${ssh}/host\nPidFile ${ssh}/pid\nAuthorizedKeysFile ${ssh}/auth\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nPermitRootLogin no\nAllowUsers ${user}\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:${four.port}\nGatewayPorts no\nPermitTTY no\nX11Forwarding no\nAllowAgentForwarding no\nLogLevel VERBOSE\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(ssh, "ssh_config"),
      `Host gyst-e2e\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User ${user}\n  IdentityFile ${ssh}/client\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${ssh}/known\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  UpdateHostKeys no\n  BatchMode yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  ExitOnForwardFailure yes\n  ConnectTimeout 5\n  ControlMaster no\n  ControlPath none\n  LocalForward 127.0.0.1:${forward} 127.0.0.1:${four.port}\n`,
      { mode: 0o600 },
    );
    const sshd = await start(
      "sshd",
      openssh("sshd"),
      ["-D", "-e", "-f", join(ssh, "sshd_config")],
      ssh,
      "Server listening on 127.0.0.1",
    );
    const client = await start(
      "ssh",
      openssh("ssh"),
      ["-v", "-F", join(ssh, "ssh_config"), "-N", "gyst-e2e"],
      ssh,
      "Local forwarding listening on 127.0.0.1",
    );
    const page = await newPage(await browser!.newContext());
    await go(page, `http://${four.hostname}:${forward}${four.path}#${four.secret}`);
    await page.getByRole("main").getByText("uncommitted-edit").waitFor();
    expect(new URL(page.url()).port).toBe(String(forward));
    expect(sshd.log()).toContain("Accepted publickey");
    expect(client.log()).toContain("is known and matches the ED25519 host key");
    // The session's event stream runs over the same forward.
    await says(page, "Live");
    // Eager captured-file reads settle first, so stopping the launcher doesn't fail one mid-flight.
    await settled(page);
    expect(await stop(four.proc, "SIGINT")).toBe(130);
  }, 30_000);

  // Live review: each test opens a fresh main...live session on launches of its own.
  const idsIn = async (id: string, file: string) =>
    (await gyst("session", "diff", "--session", id)).hunks
      .filter((hunk: { file: string }) => hunk.file === file)
      .map((hunk: { id: string }) => hunk.id);
  // A set: the daemon's order of Viewed hunk ids is not part of these tests.
  const viewedIn = async (id: string) =>
    new Set((await gyst("session", "status", "--session", id)).viewedHunkIds);
  /** From the first file: to src/long.ts's change, down past the first screen, three lines selected. */
  const readingKeys = [
    "]",
    "c",
    "]",
    "c",
    "]",
    "c",
    ...Array.from({ length: 12 }, () => "j"),
    "Shift+V",
    "j",
    "j",
  ];
  const pause = (page: Page, ms: number) =>
    page.evaluate((wait) => new Promise((resolve) => setTimeout(resolve, wait)), ms);
  /**
   * The page is connected again but still shows `progress` from before: it says so, and a click
   * on `file`'s Viewed box sends and queues nothing.
   */
  const synchronizingWithout = async (
    page: Page,
    writes: unknown[],
    file: string,
    progress: string,
  ) => {
    await says(page, "Synchronizing…");
    await says(page, "Reading what changed meanwhile. Viewed changes are paused.");
    await says(page, progress);
    const sent = writes.length;
    await viewedBox(page, file).click();
    await pause(page, 300);
    expect(writes).toHaveLength(sent);
    expect(await viewedBox(page, file).isChecked()).toBe(false);
  };

  it("shares committed Viewed progress live between two viewers and the CLI, leaving the other viewer's cursor, selection and scroll", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const [a, b] = [await newPage(), await newPage()];
    const reads = statusReadsOf(b);
    const writes = viewedOf(b);
    for (const page of [a, b]) await page.setViewportSize({ width: 1280, height: 800 });
    await go(a, launched.url);
    await b.goto(`${launched.origin}${launched.path}`);
    for (const page of [a, b]) {
      await says(page, "Live");
      await says(page, "0/3 hunks viewed in 3 files");
    }
    // B reads into src/long.ts's change with three lines selected.
    await keys(b, ...readingKeys);
    await says(b, "3 lines selected");
    await settled(b);
    const position = await positionOf(b);
    expect(position.scrollTop).toBeGreaterThan(0);

    await viewedBox(a, "README.md").check();
    await says(a, "1/3 hunks viewed in 3 files");
    await says(b, "1/3 hunks viewed in 3 files");
    expect(await viewedBox(b, "README.md").isChecked()).toBe(true);
    const readme = await idsIn(id, "README.md");
    expect(await viewedIn(id)).toEqual(new Set(readme));
    await settled(b);
    expect(await positionOf(b)).toEqual(position);

    // A CLI apply is read again too, so B's next write names the CLI's revision and applies.
    const revision = await applyFromCli(id);
    await waitFor(() => reads.includes(revision), "B to read the CLI's revision");
    await settled(b);
    expect(await positionOf(b)).toEqual(position);
    expect(writes).toEqual([]);
    await viewedBox(b, "app.ts").check();
    await says(b, "2/3 hunks viewed in 3 files");
    await says(a, "2/3 hunks viewed in 3 files");
    const app = await idsIn(id, "app.ts");
    expect(writes).toEqual([expect.objectContaining({ revision, hunkIds: app, viewed: true })]);
    expect(await b.getByText("Not saved", { exact: false }).count()).toBe(0);
    expect(await viewedIn(id)).toEqual(new Set([...readme, ...app]));
  }, 60_000);

  it("brings a viewer whose first subscription was held up to a change made before it subscribed", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const [a, b] = [await newPage(), await newPage()];
    for (const page of [a, b]) await page.setViewportSize({ width: 1280, height: 800 });
    let held = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await b.route(isEventsUrl, async (route) => {
      if (held) return route.continue();
      held = true;
      await released;
      await route.continue();
    });
    await go(a, launched.url);
    await says(a, "Live");
    try {
      // B has read status, but its subscription has not reached the daemon yet.
      await b.goto(`${launched.origin}${launched.path}`);
      await says(b, "0/3 hunks viewed in 3 files");
      await waitFor(() => held, "B's first subscription to be held");
      await says(b, "Connecting…");
      await viewedBox(a, "README.md").check();
      await says(a, "1/3 hunks viewed in 3 files");
      expect(await viewedIn(id)).toEqual(new Set(await idsIn(id, "README.md")));
      await says(b, "0/3 hunks viewed in 3 files");
    } finally {
      release();
    }
    // The subscription's ready names the newer revision, so B reads status again.
    await says(b, "Live");
    await says(b, "1/3 hunks viewed in 3 files");
    expect(await viewedBox(b, "README.md").isChecked()).toBe(true);
  }, 60_000);

  it("coalesces changes announced while a viewer's status read is held into one more read of the final state", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const [a, b] = [await newPage(), await newPage()];
    for (const page of [a, b]) await page.setViewportSize({ width: 1280, height: 800 });
    const reads: unknown[] = [];
    let armed = false;
    let fetched = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await b.route(isOperationUrl, async (route) => {
      if (!armed || route.request().postDataJSON()?.command !== "status") return route.continue();
      reads.push(route.request().postDataJSON());
      if (reads.length > 1) return route.continue();
      // Read at once, answered later: the reply is the state after the first change only.
      const response = await route.fetch();
      fetched = true;
      await released;
      await route.fulfill({ response });
    });
    await go(a, launched.url);
    await b.goto(`${launched.origin}${launched.path}`);
    for (const page of [a, b]) {
      await says(page, "Live");
      await settled(page);
    }
    armed = true;
    try {
      await viewedBox(a, "README.md").check();
      await says(a, "1/3 hunks viewed in 3 files");
      await waitFor(() => fetched, "B's status read of the first change");
      await viewedBox(a, "app.ts").check();
      await says(a, "2/3 hunks viewed in 3 files");
      await viewedBox(a, "src/long.ts").check();
      await says(a, "3/3 hunks viewed in 3 files");
      // B hears of both later changes while its one read is still out.
      await pause(b, 500);
      expect(reads).toHaveLength(1);
      await says(b, "0/3 hunks viewed in 3 files");
    } finally {
      release();
    }
    await says(b, "3/3 hunks viewed in 3 files");
    await settled(b);
    expect(reads).toHaveLength(2);
    for (const path of ["README.md", "app.ts", "src/long.ts"])
      expect(await viewedBox(b, path).isChecked()).toBe(true);
  }, 60_000);

  it("leaves the session switched to untouched by the held replies, streams and later changes of the one left", async () => {
    const x = await freshSession();
    const y = await freshSession("main..live");
    const launched = await launchFor(x);
    const [page, other] = [await newPage(), await newPage()];
    for (const each of [page, other]) await each.setViewportSize({ width: 1280, height: 800 });
    const pathOf = (id: string) => `/session/${encodeURIComponent(id)}`;
    const at = (id: string) =>
      waitFor(() => new URL(page.url()).pathname === pathOf(id), `the page at ${id}`);
    let readsOfY = 0;
    page.on("request", (request) => {
      const operation = operationOf(request);
      if (operation?.command === "status" && operation.session === y) readsOfY++;
    });
    await go(page, launched.url);
    await crumbIs(page, "demo/main...live");
    await says(page, "Live");
    await page.getByRole("banner").getByRole("link", { name: "All sessions" }).click();
    await page.locator(`a[href="${pathOf(y)}"]`).click();
    await crumbIs(page, "demo/main..live");
    await says(page, "Live");
    await settled(page);

    // From here X's streams wait until the test ends the switching; its reads wait once X has
    // been shown again, so the last switches leave X's loads unanswered.
    const held: string[] = [];
    let holdReads = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(
      (url) => isOperationUrl(url) || isEventsUrl(url),
      async (route) => {
        const request = route.request();
        const events = isEventsUrl(new URL(request.url()));
        if (request.postDataJSON()?.session !== x || (!events && !holdReads))
          return route.continue();
        held.push(events ? "events" : request.postDataJSON().command);
        await released;
        // A stream its reader left is already aborted.
        await route.continue().catch(() => {});
      },
    );
    try {
      await page.evaluate(() => history.go(-2));
      await crumbIs(page, "demo/main...live");
      await says(page, "Connecting…");
      await page.evaluate(() => history.go(2));
      await at(y);
      holdReads = true;
      await page.evaluate(() => history.go(-2));
      await at(x);
      await page.evaluate(() => history.go(2));
      await at(y);
      await page.evaluate(() => history.go(-2));
      await at(x);
      await page.evaluate(() => history.go(2));
      await at(y);
      await crumbIs(page, "demo/main..live");
      await says(page, "Live");
      // X's replies are still held, so the page's operations can't settle yet.
      await pause(page, 300);
      expect(held).toContain("events");
      expect(held).toContain("status");
      readsOfY = 0;
    } finally {
      release();
    }
    await other.goto(`${launched.origin}${pathOf(x)}`);
    await says(other, "Live");
    await viewedBox(other, "README.md").check();
    await says(other, "1/3 hunks viewed in 3 files");
    await applyFromCli(x);
    await settled(page);
    for (let i = 0; i < 5; i++) {
      await pause(page, 200);
      expect(new URL(page.url()).pathname).toBe(pathOf(y));
      expect(await page.locator("h1").textContent()).toBe("demo/main..live");
      await says(page, "0/3 hunks viewed in 3 files");
      await says(page, "Live");
      expect(await viewedBox(page, "README.md").isChecked()).toBe(false);
    }
    expect(readsOfY).toBe(0);
    expect(await viewedIn(y)).toEqual(new Set());
  }, 60_000);

  it("shows Reconnecting… and refuses Viewed changes while the daemon restarts, then resubscribes to the same session, progress and position", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const page = await newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(page);
    const reads = statusReadsOf(page);
    await go(page, launched.url);
    await says(page, "Live");
    await viewedBox(page, "README.md").check();
    await says(page, "1/3 hunks viewed in 3 files");
    await keys(page, ...readingKeys);
    await says(page, "3 lines selected");
    await settled(page);
    const position = await positionOf(page);
    expect(position.scrollTop).toBeGreaterThan(0);

    // The page's next subscription waits for the test, so the outage stays in view.
    let resubscribed = false;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    await page.route(isEventsUrl, async (route) => {
      resubscribed = true;
      await released;
      await route.continue().catch(() => {});
    });
    const daemon = await killDaemon(data, "SIGTERM");
    try {
      await says(page, "Reconnecting…");
      await says(page, "Can't reach gyst; retrying. Viewed changes are paused.");
      await waitFor(() => resubscribed, "the page to subscribe again");
      // m marks the cursor's file, src/long.ts; nothing is sent or queued.
      await keys(page, "m");
      await pause(page, 300);
      expect(writes).toHaveLength(1);
      expect(await viewedBox(page, "src/long.ts").isChecked()).toBe(false);
      expect(isAlive(daemon)).toBe(false);
    } finally {
      release();
    }
    // The resubscription starts a new daemon; the session is reread, never recreated.
    await says(page, "Live");
    const replacement = await daemonPid(data);
    expect(replacement).not.toBe(daemon);
    expect(ownDaemon(replacement)).toBe(true);
    expect(new URL(page.url()).pathname).toBe(launched.path);
    await says(page, "1/3 hunks viewed in 3 files");
    expect(await viewedIn(id)).toEqual(new Set(await idsIn(id, "README.md")));
    await settled(page);
    expect(await positionOf(page)).toEqual(position);
    expect(writes).toHaveLength(1);
    expect(await sessionIds()).toContain(id);

    const revision = await applyFromCli(id);
    await waitFor(() => reads.includes(revision), "the CLI's change to reach the page");
    await settled(page);
    expect(await positionOf(page)).toEqual(position);
  }, 60_000);

  it("synchronizes the connection a daemon restart brought, Viewed changes paused, while a read for the connection it ended is still held", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const [a, b] = [await newPage(), await newPage()];
    for (const page of [a, b]) await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(b);
    let armed = false;
    // B's first two status reads: one of A's change, then the new connection's.
    const held = await heldStatusReads(b, 2, () => armed);
    await go(a, launched.url);
    await b.goto(`${launched.origin}${launched.path}`);
    for (const page of [a, b]) {
      await says(page, "Live");
      await settled(page);
    }
    armed = true;
    try {
      await viewedBox(a, "README.md").check();
      await says(a, "1/3 hunks viewed in 3 files");
      await held.fetched(0, "B's status read of the change");
      const daemon = await killDaemon(data, "SIGTERM");
      // B's resubscription is a new connection, which reads status of its own.
      await held.fetched(1, "the new connection's status read");
      expect(await daemonPid(data)).not.toBe(daemon);
      await synchronizingWithout(b, writes, "app.ts", "0/3 hunks viewed in 3 files");
      held.release(1);
      await says(b, "Live");
      await says(b, "1/3 hunks viewed in 3 files");
      expect(await viewedBox(b, "README.md").isChecked()).toBe(true);
      // The given-up connection's answer changes nothing.
      held.release(0);
      await settled(b);
      await says(b, "1/3 hunks viewed in 3 files");
      expect(held.reads()).toBe(2);
    } finally {
      held.releaseAll();
    }
    await viewedBox(a, "app.ts").check();
    await says(b, "2/3 hunks viewed in 3 files");
    expect(held.reads()).toBe(3);
    expect(writes).toEqual([]);
  }, 60_000);

  it("rereads for the connection a daemon restart brought while the read after a lost write's resend is held, Viewed changes paused until it lands", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const page = await newPage(context, { problems: ["requestfailed /api/operation"] });
    await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(page);
    let lost = false;
    await page.route(isOperationUrl, async (route) => {
      if (lost || route.request().postDataJSON()?.command !== "viewed") return route.fallback();
      lost = true;
      // The daemon applies it; only its reply is cut off.
      await route.fetch();
      await route.abort();
    });
    // The resend's receipt asks for a status read before any new write; it and the new
    // connection's read are held.
    const held = await heldStatusReads(page, 2, () => lost);
    // Once the daemon is stopped, the page's resubscription waits for the CLI's apply, so the new
    // connection's ready names it rather than announcing it after its read.
    let restarted = false;
    const { promise: applied, resolve: commit } = Promise.withResolvers<void>();
    await page.route(isEventsUrl, async (route) => {
      if (restarted) await applied;
      await route.continue().catch(() => {});
    });
    await go(page, launched.url);
    await says(page, "Live");
    await settled(page);
    const before = (await gyst("session", "status", "--session", id)).revision;
    try {
      await viewedBox(page, "README.md").click();
      await held.fetched(0, "the status read after the resend");
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      restarted = true;
      const daemon = await killDaemon(data, "SIGTERM");
      // Committed while the page reconnects; the new connection's ready names it.
      const revision = await applyFromCli(id);
      expect(revision).toBe(before + 2);
      commit();
      await held.fetched(1, "the new connection's status read");
      expect(await daemonPid(data)).not.toBe(daemon);
      await synchronizingWithout(page, writes, "app.ts", "0/3 hunks viewed in 3 files");
      held.release(1);
      await says(page, "Live");
      await says(page, "1/3 hunks viewed in 3 files");
      held.release(0);
      await settled(page);
      await says(page, "1/3 hunks viewed in 3 files");
      expect(held.reads()).toBe(2);

      // A new change is a fresh intent against the revision the new connection read.
      await viewedBox(page, "app.ts").check();
      await says(page, "2/3 hunks viewed in 3 files");
      expect(writes).toHaveLength(3);
      expect(writes[2]).toMatchObject({ revision, hunkIds: await idsIn(id, "app.ts") });
      expect(writes[2].requestId).not.toBe(writes[0].requestId);
      expect((await gyst("session", "status", "--session", id)).revision).toBe(revision + 1);
    } finally {
      commit();
      held.releaseAll();
    }
  }, 60_000);

  it("resends a Viewed write whose reply was lost once, with the same request id and payload, then reads status", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    const page = await newPage(context, { problems: ["requestfailed /api/operation"] });
    await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(page);
    const commands: string[] = [];
    page.on("request", (request) => {
      const operation = operationOf(request);
      if (operation) commands.push(operation.command);
    });
    let lost = false;
    await page.route(isOperationUrl, async (route) => {
      if (lost || route.request().postDataJSON()?.command !== "viewed") return route.continue();
      lost = true;
      // The daemon applies it; only its reply is cut off.
      await route.fetch();
      await route.abort();
    });
    await go(page, launched.url);
    await says(page, "Live");
    await settled(page);
    const before = (await gyst("session", "status", "--session", id)).revision;
    commands.length = 0;
    await viewedBox(page, "README.md").click();
    await says(page, "1/3 hunks viewed in 3 files");
    await waitFor(
      async () => commands.join() === "viewed,viewed,status",
      "the replay and the status read after it",
    );
    await settled(page);
    expect(commands.join()).toBe("viewed,viewed,status");
    expect(writes[1]).toEqual(writes[0]);
    const readme = await idsIn(id, "README.md");
    expect(writes[0]).toMatchObject({ revision: before, hunkIds: readme, viewed: true });
    // The receipt answered the resend: the revision rose once.
    expect(await gyst("session", "status", "--session", id)).toMatchObject({
      revision: before + 1,
      viewedHunkIds: readme,
    });

    // A different change is a new intent with an id of its own.
    await viewedBox(page, "app.ts").check();
    await says(page, "2/3 hunks viewed in 3 files");
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({
      revision: before + 1,
      hunkIds: await idsIn(id, "app.ts"),
      viewed: true,
    });
    expect(writes[2].requestId).not.toBe(writes[0].requestId);
    expect((await gyst("session", "status", "--session", id)).revision).toBe(before + 2);
  }, 60_000);

  it("queues nothing while reconnecting, and makes the next click after recovery a fresh intent against the reread revision", async () => {
    const id = await freshSession();
    const launched = await launchFor(id);
    // The outage refuses the one status read the announced change asks for.
    const page = await newPage(context, { responses: ["/api/operation 503"] });
    await page.setViewportSize({ width: 1280, height: 800 });
    const writes = viewedOf(page);
    const reads = statusReadsOf(page);
    let outage = false;
    await page.route(isEventsUrl, (route) => (outage ? route.abort() : route.continue()));
    await page.route(isOperationUrl, (route) =>
      outage && route.request().postDataJSON()?.command === "status"
        ? route.fulfill({ status: 503, body: "" })
        : route.continue(),
    );
    await go(page, launched.url);
    await says(page, "Live");
    await settled(page);
    outage = true;
    // A change made elsewhere is announced, its read is refused and the reader can't reconnect.
    const revision = await applyFromCli(id);
    await says(page, "Reconnecting…");
    await viewedBox(page, "README.md").click();
    await keys(page, "m");
    await pause(page, 300);
    expect(writes).toEqual([]);
    expect(await viewedBox(page, "README.md").isChecked()).toBe(false);

    outage = false;
    await says(page, "Live");
    await waitFor(() => reads.includes(revision), "the reread after recovery");
    await settled(page);
    expect(writes).toEqual([]);
    await viewedBox(page, "README.md").check();
    await says(page, "1/3 hunks viewed in 3 files");
    const readme = await idsIn(id, "README.md");
    expect(writes).toEqual([
      expect.objectContaining({
        revision,
        hunkIds: readme,
        viewed: true,
        requestId: expect.any(String),
      }),
    ]);
    expect(await gyst("session", "status", "--session", id)).toMatchObject({
      revision: revision + 1,
      viewedHunkIds: readme,
    });
  }, 60_000);

  it("stops only its own launch on SIGINT: that page reconnects while another launch's page stays live, keeping the daemon and the session", async () => {
    const id = await freshSession();
    const first = await launchFor(id);
    const second = await launchFor(id);
    expect(second.hostname).not.toBe(first.hostname);
    const [left, kept] = [await newPage(), await newPage()];
    for (const page of [left, kept]) await page.setViewportSize({ width: 1280, height: 800 });
    const reads = statusReadsOf(kept);
    await go(left, first.url);
    await go(kept, second.url);
    for (const page of [left, kept]) {
      await says(page, "Live");
      await settled(page);
    }
    const daemon = await daemonPid(data);
    expect(await stop(first.proc, "SIGINT")).toBe(130);
    await says(left, "Reconnecting…");
    await says(kept, "Live");

    const revision = await applyFromCli(id);
    await waitFor(() => reads.includes(revision), "the CLI's change to reach the other page");
    await settled(kept);
    await viewedBox(kept, "README.md").check();
    await says(kept, "1/3 hunks viewed in 3 files");
    expect(await gyst("session", "status", "--session", id)).toMatchObject({
      revision: revision + 1,
      viewedHunkIds: await idsIn(id, "README.md"),
    });
    await says(left, "Reconnecting…");
    expect(await daemonPid(data)).toBe(daemon);
    expect(ownDaemon(daemon)).toBe(true);
    expect(await sessionIds()).toContain(id);
  }, 60_000);
});
