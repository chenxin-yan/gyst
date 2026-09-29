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
const isOperationUrl = (url: URL) => url.pathname === "/api/operation";
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

/**
 * A page closed after its test, which must see exactly the listed HTTP error responses
 * (`<path> <status>`) and problems: failed requests, page errors and console errors. Chromium's
 * "Failed to load resource" lines only repeat those responses and failures.
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
  page.on("requestfailed", (request) => seen.problems.push(`requestfailed ${path(request.url())}`));
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

/** OpenSSH executables from PATH, plus /usr/sbin where Ubuntu keeps sshd. */
function openssh(name: string): string {
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), "/usr/sbin"].filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  throw new Error(`OpenSSH ${name} is not on PATH or in /usr/sbin`);
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
    git("add", ".");
    git("commit", "-qm", "init");
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
    // Untracked binary: captured as an unavailable side, never as text.
    await writeFile(join(repo, "logo.bin"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]));

    const chromiumPath = process.env.CHROMIUM_PATH;
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
    expect(operations.map(operationOf).sort((a, b) => a.command.localeCompare(b.command))).toEqual([
      { command: "diff", session: one.id },
      { command: "files", session: one.id, snapshotId: sessions[0].snapshotId },
      { command: "open", session: one.id },
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

    // The captured patch renders as escaped text with old/new line numbers.
    expect(await pane.getByText(hostile).count()).toBe(1);
    expect(await pane.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
    // The changed files' headings; the captured files section has its own.
    expect(
      await pane
        .getByRole("heading", { level: 2 })
        .filter({ hasNotText: /^Captured files/ })
        .count(),
    ).toBe(2);
    // A line is a row of old number, new number and code cells.
    const numbers = (text: string) =>
      pane
        .getByRole("row")
        .filter({ hasText: text })
        .locator("[role=cell]:not(:last-child)")
        .allTextContents();
    expect(await numbers("onerror")).toEqual(["2", ""]);
    expect(await numbers("uncommitted-edit")).toEqual(["", "2"]);
    expect(await numbers("A new line")).toEqual(["", "11"]);
    expect(await pane.getByRole("row").filter({ hasText: /^\\/ }).allTextContents()).toEqual([
      "\\ No newline at end of file",
    ]);
    expect(await numbers("No newline at end of file")).toEqual(["", ""]);
  }, 30_000);

  it("lists captured files and renders captured code as escaped numbered text; an unavailable side shows its reason", async () => {
    const page = await newPage();
    await page.goto(`${one.origin}${one.path}`);
    const pane = page.getByRole("main");
    const capturedRow = (path: string) =>
      pane
        .getByRole("list", { name: "Captured files" })
        .getByRole("listitem")
        .filter({ hasText: path });
    await capturedRow("app.ts").getByRole("button", { name: "View old" }).click();
    const oldApp = pane.getByRole("region", { name: "app.ts, old side" });
    await oldApp.getByText(hostile).waitFor();
    expect(await oldApp.getByRole("row").count()).toBe(3);
    expect(await pane.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
    await capturedRow("logo.bin").getByRole("button", { name: "View new" }).click();
    await pane
      .getByRole("region", { name: "logo.bin, new side" })
      .getByText("Not captured: binary content is not captured.")
      .waitFor();
  }, 30_000);

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
    await page.goto(`${one.origin}/session/does-not-exist`);
    await page.getByRole("heading", { name: "Session not found" }).waitFor();
    await page.goto(`${one.origin}/deliberately/unknown`);
    await page.getByRole("heading", { name: "Page not found" }).waitFor();
    const host = `${one.hostname}:${one.port}`;
    expect(await raw(one.port, { path: "/assets/missing.js", headers: { host } })).toBe(404);
  }, 30_000);

  it("shows Loading… while the session's real diff is held, then renders the bridge's reply", async () => {
    const page = await newPage();
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
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
    expect(await page.getByRole("status").count()).toBe(0);
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
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
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
      responses: ["/api/operation 503", "/api/operation 503"],
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
    fault = "internal";
    await page.goto(`${one.origin}/session/${b}`);
    await page.getByRole("alert").getByText("injected internal failure").waitFor();
    fault = "outage";
    await page.goto(`${one.origin}/session/${b}`);
    await page.getByRole("alert").getByText("Can't reach gyst").waitFor();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
  }, 30_000);

  it("keeps the real hunk view within a narrow viewport", async () => {
    const page = await newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${one.origin}${one.path}`);
    await page.getByRole("main").getByRole("table").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
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
    expect(await stop(four.proc, "SIGINT")).toBe(130);
  }, 30_000);
});
