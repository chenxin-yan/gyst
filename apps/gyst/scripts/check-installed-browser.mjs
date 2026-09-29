// Product check of the INSTALLED gyst in a real sandboxed Chromium, with no mock launcher: builds,
// packs and globally installs the package into a private prefix (tests/e2e/global-setup.ts), runs
// real foreground `gyst` launches against a real daemon, and drives the browser through them and
// through a private, key-authenticated localhost SSH local forward on an unequal port.
//
//   CHROMIUM_PATH=/path/to/chromium node apps/gyst/scripts/check-installed-browser.mjs
//
// Needs git, and OpenSSH's sshd/ssh/ssh-keygen (SSH_BIN_DIR, default /run/current-system/sw/bin).
// The private root lives under $HOME (mode 0700), since sshd StrictModes rejects a /tmp ancestor.
// Launch URLs, bootstrap secrets and cookies stay in memory; failures are redacted before printing.
//
// CHECK_INJECT exercises this script's own cleanup against the real product: `fail-after-ssh`
// throws once launcher, daemon, sshd, ssh and Chromium all run; `launch-timeout` makes the first
// launch's readiness wait time out while that launcher and its daemon run. Both must exit 1 with
// every owned process stopped (`result.cleanup`) and nothing left matching this run's paths.
// `extra-401` adds one unlisted 401 on a deliberate page, which the exact accounting must reject.
// Test-harness faults, not product evidence: `ssh-missing` / `ssh-noexec` start the SSH client from
// a missing / non-executable file once sshd, launchers, daemon and Chromium run; `response-error` /
// `response-cut` fail or cut the client side of a real installed bridge asset response mid-body;
// `replay-hang` leaves the replayed delete unanswered in the browser; `pgrep-fault` makes the
// leftover-process probe itself fail. Each must exit 1 for that reason after full cleanup.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as tcpServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { chromium } from "playwright-core";

import setupInstalled from "../tests/e2e/global-setup.ts";

const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) throw new Error("set CHROMIUM_PATH to a Chromium executable");
const sshBin = process.env.SSH_BIN_DIR ?? "/run/current-system/sw/bin";

const secrets = new Set();
const redact = (text) => {
  let out = String(text);
  for (const value of secrets) out = out.replaceAll(value, "[redacted]");
  return out;
};
const inject = process.env.CHECK_INJECT;
const result = { node: process.version, checks: [], unexpected: [] };
if (inject) result.inject = inject;
const check = (name) => result.checks.push(name);
/** Every process this run spawned, each with its exit promise registered at spawn time. */
const owned = [];
let browser;
let installed;
let teardown;

/** Rejects with `label` if `promise` has not settled within `ms`. */
const within = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Spawns and registers a child. `exited` resolves to its exit code or signal, or to
 * `spawn failed: <code>` when it never started (no pid), so readiness waits reject and cleanup
 * skips it. Any later child or stdio stream error is kept in `errors` and reported by cleanup.
 */
function own(label, file, args, options) {
  const child = spawn(file, args, options);
  const errors = [];
  const exited = new Promise((resolve) => {
    child.once("close", (code, sig) => resolve(code ?? sig));
    child.on("error", (error) => {
      if (child.pid === undefined) resolve(`spawn failed: ${error.code ?? error.message}`);
      else errors.push(error.message);
    });
  });
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream?.on("error", (error) => errors.push(`stdio: ${error.message}`));
  const entry = { label, child, exited, errors };
  owned.push(entry);
  return entry;
}

/** Sends a signal; false if the process is already gone. */
function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/** SIGTERM, then SIGKILL after `grace`; throws if SIGKILL was needed or did not work either. */
async function stopOwned({ label, child, exited }, grace = 5_000) {
  if (child.pid === undefined) return within(exited, 2_000, `${label} spawn failure`);
  if (child.exitCode !== null || child.signalCode !== null) return exited;
  signal(child.pid, "SIGTERM");
  const code = await within(exited, grace, `${label} to exit on SIGTERM`).catch(() => undefined);
  if (code !== undefined) return code;
  signal(child.pid, "SIGKILL");
  await within(exited, 2_000, `${label} to exit on SIGKILL`);
  throw new Error(`${label} (pid ${child.pid}) ignored SIGTERM during cleanup`);
}

/** False once the process is gone or a zombie; Linux reads /proc for that. */
function isAlive(pid) {
  if (!signal(pid, 0)) return false;
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** Bounded wait for a condition with no event to await, like installed-gyst.ts's `waitFor`. */
async function waitFor(condition, ms, label) {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out after ${ms} ms: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Stops the daemon this run's data dir names, only if its command line is this private install's
 * `daemon run` (a stale pid file may name a reused pid). The daemon is not our child, so its exit
 * is observed through /proc; SIGKILL after 5 s is reported as a failure.
 */
const daemonPid = () => readFile(join(data, "daemon.pid"), "utf8").then(Number, () => NaN);

/** A live `daemon run` process launched from this run's private install. */
function isOwnedDaemon(pid) {
  if (Number.isNaN(pid) || !installed || !isAlive(pid)) return false;
  const args = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return args.stdout.includes(installed.prefix) && args.stdout.trim().endsWith(" daemon run");
}

async function stopDaemon() {
  const pid = await daemonPid();
  if (Number.isNaN(pid) || !installed || !isAlive(pid)) return { pid, stopped: "not running" };
  if (!isOwnedDaemon(pid)) return { pid, stopped: "not ours" };
  if (!signal(pid, "SIGTERM")) return { pid, stopped: "exited" };
  const exited = await waitFor(() => !isAlive(pid), 5_000, `daemon ${pid} to exit`).then(
    () => true,
    () => false,
  );
  if (exited) return { pid, stopped: "SIGTERM" };
  signal(pid, "SIGKILL");
  await waitFor(() => !isAlive(pid), 2_000, `daemon ${pid} to exit after SIGKILL`);
  throw new Error(`daemon ${pid} ignored SIGTERM during cleanup`);
}

const root = await realpath(await mkdtemp(join(homedir(), ".g86-")));
const home = join(root, "h");
const data = join(root, "d");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GYST_"))),
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  GYST_DATA_DIR: data,
};
delete env.SSH_AUTH_SOCK;
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;

// Build, pnpm pack and npm install: private HOME, npm cache and user/global config; inherited
// npm_config_* settings are dropped so none can redirect them.
const npmFiles = {
  cache: join(root, "npm-cache"),
  userconfig: join(root, "npmrc"),
  globalconfig: join(root, "npm-globalrc"),
};
const npmEnv = {
  ...Object.fromEntries(Object.entries(env).filter(([name]) => !/^npm_config_/i.test(name))),
  npm_config_cache: npmFiles.cache,
  npm_config_userconfig: npmFiles.userconfig,
  npm_config_globalconfig: npmFiles.globalconfig,
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 15_000 });
const gyst = (cwd, ...args) =>
  JSON.parse(execFileSync(installed.bin, args, { cwd, env, encoding: "utf8", timeout: 15_000 }));

/** One foreground launch; resolves once it printed its URL. Stops via SIGINT like Ctrl-C. */
async function launch(cwd, ...args) {
  const entry = own(`gyst ${args.join(" ")}`.trim(), installed.bin, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { child, exited } = entry;
  let out = "";
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (err += chunk));
  // The injected timeout waits for a marker gyst never prints, with the launcher and daemon up.
  const marker = inject === "launch-timeout" ? "never printed" : "Press Ctrl-C";
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
      if (out.includes(marker)) resolve();
    });
    void exited.then((code) => reject(new Error(`gyst exited ${code} early: ${err}`)));
  });
  await within(ready, inject === "launch-timeout" ? 5_000 : 20_000, `${entry.label} to be ready`);
  const url = out.split("\n").find((line) => line.startsWith("http://"));
  const match = url?.match(
    /^http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+)(\/session\/[^#]+)#([\w-]{43})$/,
  );
  assert.ok(match, "launch URL has the random .localhost host, deep path and fragment shape");
  const [, hostname, port, path, bootstrap] = match;
  secrets.add(bootstrap);
  return {
    hostname,
    port: Number(port),
    path,
    id: decodeURIComponent(path.slice("/session/".length)),
    origin: `http://${hostname}:${port}`,
    url,
    /** Ctrl-C: SIGINT and the launcher's exit code, bounded. */
    stop: () => {
      signal(child.pid, "SIGINT");
      return within(exited, 10_000, `${entry.label} to exit on SIGINT`);
    },
  };
}

/**
 * A raw request to a launch's listener with explicit headers, as a hostile client could send.
 * Settles once: the complete response, or a request/response error, a response closed before its
 * end, or the 10 s deadline (which destroys the request).
 */
const raw = (port, { method = "GET", path = "/", headers = {}, body, fault } = {}) =>
  new Promise((settle, fail) => {
    const timer = setTimeout(
      () => req.destroy(new Error(`${method} ${path} timed out after 10000 ms`)),
      10_000,
    );
    const resolve = (value) => {
      clearTimeout(timer);
      settle(value);
    };
    const reject = (error) => {
      clearTimeout(timer);
      fail(error);
    };
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, setHost: false },
      (res) => {
        // Harness fault on the first body chunk: a stream error, or the connection cut mid-body.
        if (fault)
          res.once("data", () =>
            fault === "response-error"
              ? res.destroy(new Error("injected response stream error"))
              : res.socket.destroy(),
          );
        res.resume();
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode, headers: res.headers }));
        res.once("close", () => {
          if (!res.complete) reject(new Error(`${method} ${path}: response closed before its end`));
        });
      },
    );
    req.once("error", reject);
    req.end(body);
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = tcpServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
  });

/**
 * Every watched page records its HTTP error responses and Chromium's matching "Failed to load
 * resource" console errors as `<path> <status>`, never headers or query strings. At the end each
 * page's records must equal exactly its `expected` list (empty unless a case is deliberate); any
 * other console error, page error or failed request is unexpected.
 */
const watched = [];
function watch(page, label, expected = []) {
  const record = { label, expected, responses: [], console: [] };
  watched.push(record);
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) =>
    result.unexpected.push(`${label} pageerror: ${redact(error.message)}`),
  );
  page.on("requestfailed", (request) =>
    result.unexpected.push(`${label} requestfailed: ${redact(new URL(request.url()).pathname)}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      record.responses.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const status = message
      .text()
      .match(/^Failed to load resource: the server responded with a status of (\d+)/);
    const where = message.location().url;
    if (status && where) record.console.push(`${new URL(where).pathname} ${status[1]}`);
    else result.unexpected.push(`${label} console: ${redact(message.text())}`);
  });
  return page;
}

/** page.goto with its error redacted: Playwright errors echo the full fragment URL. */
const go = (page, url) =>
  page.goto(url).catch((error) => {
    throw new Error(redact(error.message));
  });

try {
  assert.match(process.version, /^v24\./);
  // Private HOME and npm cache/config exist before anything, including npm, runs.
  await mkdir(home);
  await mkdir(npmFiles.cache);
  await writeFile(npmFiles.userconfig, "");
  await writeFile(npmFiles.globalconfig, "");
  const npmGet = (key) =>
    execFileSync("npm", ["config", "get", key], {
      cwd: root,
      env: npmEnv,
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
  result.npmEffective = Object.fromEntries(
    ["cache", "userconfig", "globalconfig"].map((key) => [key, npmGet(key)]),
  );
  assert.deepEqual(result.npmEffective, npmFiles);
  assert.equal(
    execFileSync("sh", ["-c", 'printf %s "$HOME"'], { env: npmEnv, encoding: "utf8" }),
    home,
  );
  await setupInstalled({ provide: (_, value) => (installed = value) }, npmEnv).then(
    (stop) => (teardown = stop),
  );
  // npm really used the private cache: the install filled it.
  assert.ok((await readdir(join(npmFiles.cache, "_cacache"))).length > 0);
  assert.throws(() => execFileSync("sh", ["-c", "command -v bun"], { env, stdio: "ignore" }));
  result.installedPackageDir = installed.packageDir;
  check(
    "fresh build → pack → private global install outside the checkout, npm confined to this run's HOME, cache and user/global config (effective paths checked, cache filled); Bun absent on PATH",
  );

  const repo = join(root, "r");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@gyst.invalid");
  git(repo, "config", "user.name", "t");
  await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "switch", "-qc", "feature");
  await writeFile(join(repo, "feature.ts"), "export const feature = 'range-only';\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "feature");
  await writeFile(join(repo, "app.ts"), "const a = 1;\nconst b = 'uncommitted-edit';\n");

  const tmp = join(root, "t");
  await mkdir(tmp);
  browser = await chromium.launch({
    executablePath,
    chromiumSandbox: true,
    headless: true,
    timeout: 20_000,
    // Proxy bypass selects direct transport; .localhost resolves natively (no hosts/resolver maps).
    proxy: { server: "http://127.0.0.1:9", bypass: ".localhost,127.0.0.1" },
    env: { ...env, TMPDIR: tmp },
  });
  result.browser = browser.version();
  const context = await browser.newContext();

  // Root launcher defaults to the uncommitted scope and shows the real captured hunk.
  const one = await launch(repo);
  const page = watch(await context.newPage(), "launch one");
  const documents = [];
  page.on("request", (r) => r.resourceType() === "document" && documents.push(1));
  await go(page, one.url);
  await page.locator(".pane").getByText("uncommitted-edit").waitFor();
  assert.equal(await page.locator(".pane").getByText("range-only").count(), 0);
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(new URL(page.url()).pathname, one.path);
  assert.deepEqual(
    gyst(repo, "session", "list").sessions.map((s) => [s.id, s.scope.kind]),
    [[one.id, "uncommitted"]],
  );
  check(
    "root `gyst` opened the uncommitted scope; deep path renders the real captured hunk; fragment removed",
  );

  const [cookie] = (await context.cookies(one.origin)).filter((c) => c.name === "gyst_auth");
  assert.ok(cookie);
  secrets.add(cookie.value);
  assert.equal(cookie.domain, one.hostname);
  assert.deepEqual([cookie.path, cookie.httpOnly, cookie.sameSite], ["/", true, "Strict"]);
  assert.equal(await page.evaluate(() => document.cookie), "");
  check("host-only HttpOnly SameSite=Strict launch cookie, invisible to script");

  await page.getByRole("link", { name: "All sessions" }).click();
  await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
  assert.equal(documents.length, 1);
  await page.reload();
  await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
  const tab = watch(await context.newPage(), "new tab");
  await go(tab, `${one.origin}${one.path}`);
  await tab.locator(".pane").getByText("uncommitted-edit").waitFor();
  await go(tab, `${one.origin}/session/does-not-exist`);
  await tab.getByRole("heading", { name: "Session not found" }).waitFor();
  await go(tab, `${one.origin}/deliberately/unknown`);
  await tab.getByRole("heading", { name: "Page not found" }).waitFor();
  const asset = await raw(one.port, {
    path: "/assets/missing.js",
    headers: { host: `${one.hostname}:${one.port}` },
  });
  assert.equal(asset.status, 404);
  check(
    "client navigation, cookie reload and new tab without fragment; not-found views; asset miss 404",
  );

  // Loading state: the session's real diff operation is held in the browser (public route API),
  // then continued unmodified to the installed bridge, whose own response the page renders.
  const loading = watch(await context.newPage(), "held diff");
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const held = [];
  await loading.route(
    (url) => url.pathname === "/api/operation",
    async (route) => {
      const command = route.request().postDataJSON()?.command;
      if (command === "diff") {
        held.push(command);
        await within(released, 20_000, "the held diff to be released").catch(() => {});
      }
      // A page closed by an earlier failure makes continue reject; record it, never drop it.
      await route
        .continue()
        .catch((error) => result.unexpected.push(`held diff continue: ${redact(error.message)}`));
    },
  );
  const diffReply = loading.waitForResponse((r) => r.request().postDataJSON()?.command === "diff");
  // Awaited below; this handler only keeps an earlier failure from also rejecting it unobserved.
  diffReply.catch(() => {});
  try {
    await go(loading, `${one.origin}${one.path}`);
    await loading.getByRole("status").getByText("Loading…").waitFor();
    assert.deepEqual(held, ["diff"]);
    assert.equal(await loading.locator(".pane").getByText("uncommitted-edit").count(), 0);
  } finally {
    release();
  }
  const diffResponse = await diffReply;
  await loading.locator(".pane").getByText("uncommitted-edit").waitFor();
  assert.equal(diffResponse.status(), 200);
  assert.equal((await within(diffResponse.json(), 10_000, "the diff reply body")).ok, true);
  assert.equal(await loading.getByRole("status").count(), 0);
  await loading.unrouteAll();
  check(
    "loading state: with the real diff operation held, the session page shows Loading… and no hunk; released unmodified, the bridge's 200 reply renders the hunk",
  );

  // A second concurrent launch in the same profile: recorded range, its own host and cookie.
  const two = await launch(repo, "main...feature");
  assert.notEqual(two.hostname, one.hostname);
  const page2 = watch(await context.newPage(), "launch two");
  await go(page2, two.url);
  await page2.locator(".pane").getByText("range-only").waitFor();
  assert.equal(await page2.locator(".pane").getByText("uncommitted-edit").count(), 0);
  const [cookie2] = (await context.cookies(two.origin)).filter((c) => c.name === "gyst_auth");
  secrets.add(cookie2.value);
  assert.equal(cookie2.domain, two.hostname);
  assert.equal(cookie2.value === cookie.value, false);
  assert.equal(
    (await context.cookies(two.origin)).some((c) => c.value === cookie.value),
    false,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
  assert.equal(await page.locator(".session-row").count(), 2);
  check(
    "two concurrent launches in one profile: range scope, distinct hosts, host-separated cookies",
  );

  // Fresh profile against a live launch: cause-neutral 401 wording, and an expired/foreign link.
  // Each deliberate page lists exactly the resource failures it must produce, in order.
  const fresh = watch(await (await browser.newContext()).newPage(), "fresh profile", [
    "/api/operation 401",
  ]);
  await go(fresh, `${one.origin}/`);
  const notice = await fresh.getByRole("alert").innerText();
  assert.match(notice, /This browser is not signed in to this gyst launch\./);
  assert.doesNotMatch(notice, /expire|has stopped|ended/);
  // One more 401 than the list allows must fail the final accounting.
  if (inject === "extra-401")
    await fresh.evaluate(() => fetch("/api/operation", { method: "POST", body: "{}" }));
  const foreign = watch(await (await browser.newContext()).newPage(), "foreign link", [
    "/bootstrap 401",
    "/api/operation 401",
  ]);
  await go(foreign, `${one.origin}/#${two.url.split("#")[1]}`);
  assert.match(
    await foreign.getByRole("alert").innerText(),
    /expired or belongs to another gyst launch/,
  );
  check(
    "live launch: no-cookie 401 says not signed in (no false shutdown claim); cross-launch bootstrap refused",
  );

  // Hostile requests straight to the real bridge.
  const host = `${one.hostname}:${one.port}`;
  // Each case is a thunk, issued only when the loop reaches it, so no request can fail unobserved.
  const post = (path, headers, body) => () =>
    raw(one.port, { method: "POST", path, headers, body });
  const at = (options) => () => raw(one.port, options);
  const op = JSON.stringify({ command: "list" });
  const good = { host, origin: `http://${host}`, cookie: `gyst_auth=${cookie.value}` };
  const cases = [
    ["authorized list", post("/api/operation", good, op), 200],
    [
      "cross-launch cookie",
      post("/api/operation", { ...good, cookie: `gyst_auth=${cookie2.value}` }, op),
      401,
    ],
    ["no cookie", post("/api/operation", { host, origin: good.origin }, op), 401],
    [
      "wrong bootstrap",
      post("/bootstrap", {
        host,
        origin: good.origin,
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
      }),
      401,
    ],
    ["no bootstrap", post("/bootstrap", { host, origin: good.origin }), 401],
    [
      "other launch host",
      post("/api/operation", { ...good, host: `${two.hostname}:${one.port}` }, op),
      403,
    ],
    ["loopback host", at({ headers: { host: `127.0.0.1:${one.port}` } }), 403],
    ["hostless port", at({ headers: { host: one.hostname } }), 403],
    ["port 0", at({ headers: { host: `${one.hostname}:0` } }), 403],
    ["userinfo authority", at({ headers: { host: `u@${host}` } }), 403],
    ["forwarded", at({ headers: { host, forwarded: "host=evil" } }), 403],
    ["x-forwarded-host", at({ headers: { host, "x-forwarded-host": "evil" } }), 403],
    ["cross origin", post("/api/operation", { ...good, origin: "http://evil.localhost" }, op), 403],
    [
      "origin other port",
      post("/api/operation", { ...good, origin: `http://${one.hostname}:1` }, op),
      403,
    ],
    ["null origin", post("/api/operation", { ...good, origin: "null" }, op), 403],
    ["no origin", post("/api/operation", { host, cookie: good.cookie }, op), 403],
    ["GET operation", at({ path: "/api/operation", headers: good }), 405],
    ["PUT shell", at({ method: "PUT", headers: good }), 405],
    ["reserved api route", at({ path: "/api/other", headers: good }), 404],
    ["reserved bootstrap subpath", at({ path: "/bootstrap/x", headers: good }), 404],
    ["dot-dot traversal", at({ path: "/assets/../index.html", headers: good }), 400],
    ["encoded traversal", at({ path: "/%2e%2e/etc/passwd", headers: good }), 400],
    ["encoded slash", at({ path: "/assets%2findex.html", headers: good }), 400],
    ["backslash", at({ path: "/assets\\index.html", headers: good }), 400],
    ["non-browser op", post("/api/operation", good, JSON.stringify({ command: "shutdown" })), 400],
    ["excess field", post("/api/operation", good, JSON.stringify({ command: "list", x: 1 })), 400],
  ];
  for (const [name, issue, expected] of cases)
    assert.equal((await issue()).status, expected, `bridge: ${name}`);
  if (inject === "response-error" || inject === "response-cut") {
    // The largest packaged asset spans many reads, so the fault lands before the response ends.
    const dir = join(installed.packageDir, "dist", "web-ui", "assets");
    const [[size, name]] = (await readdir(dir))
      .map((file) => [statSync(join(dir, file)).size, file])
      .sort((a, b) => b[0] - a[0]);
    result.faultAssetBytes = size;
    await raw(one.port, { path: `/assets/${name}`, headers: { host }, fault: inject });
    throw new Error(`${inject} did not fail the interrupted response`);
  }
  result.rejections = cases.length - 1;
  check(
    `real bridge answered ${cases.length} hostile/control requests with the exact expected status`,
  );

  // Deletion through the real UI, captured with Playwright's Request API (the payload holds no
  // credential); the same intent is replayed from the page and must get the same decoded reply.
  await go(page2, `${two.origin}/`);
  const deletes = [];
  const isOperation = (r) =>
    r.method() === "POST" && new URL(r.url()).pathname === "/api/operation";
  page2.on(
    "request",
    (r) => isOperation(r) && r.postDataJSON()?.command === "delete" && deletes.push(r),
  );
  const rangeRow = page2.locator(".session-row", { hasText: "main...feature" });
  await rangeRow.getByRole("button", { name: "Delete…" }).click();
  await rangeRow.getByRole("button", { name: "Cancel" }).click();
  await rangeRow.getByRole("button", { name: "Delete…" }).waitFor();
  assert.equal(deletes.length, 0);
  assert.equal(gyst(repo, "session", "list").sessions.length, 2);
  await rangeRow.getByRole("button", { name: "Delete…" }).click();
  const [response] = await Promise.all([
    page2.waitForResponse(
      (r) => isOperation(r.request()) && r.request().postDataJSON()?.command === "delete",
    ),
    rangeRow.getByRole("button", { name: "Delete session" }).click(),
  ]);
  const payload = response.request().postDataJSON();
  assert.deepEqual(Object.keys(payload).sort(), ["command", "requestId", "session"]);
  assert.equal(payload.session, two.id);
  assert.match(payload.requestId, /^[0-9a-f]{32}$/);
  const deleted = { ok: true, value: { deleted: true, sessionId: two.id } };
  assert.equal(response.status(), 200);
  assert.deepEqual(await within(response.json(), 10_000, "the delete reply body"), deleted);
  await rangeRow.waitFor({ state: "detached" });
  assert.equal(deletes.length, 1);
  result.deleteRequestId = payload.requestId;

  // The page aborts its own fetch and body read after 10 s; `within` also bounds the evaluate
  // itself (Playwright's default timeout does not), and observes it if it settles later.
  const send = (body) =>
    within(
      page2.evaluate(async (text) => {
        const r = await fetch("/api/operation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: text,
          signal: AbortSignal.timeout(10_000),
        });
        return { status: r.status, reply: await r.json() };
      }, body),
      15_000,
      "the replayed delete",
    ).catch((error) => {
      throw new Error(`replayed delete failed: ${redact(error.message)}`);
    });
  // Harness fault: a route handler that never continues leaves the replay unanswered.
  if (inject === "replay-hang")
    await page2.route(
      (url) => url.pathname === "/api/operation",
      () => {},
    );
  assert.deepEqual(await send(response.request().postData()), { status: 200, reply: deleted });
  // A new intent for the same, now absent, session is a domain error, also carried by a 200.
  const other = await send(
    JSON.stringify({ ...payload, requestId: randomBytes(16).toString("hex") }),
  );
  assert.equal(other.status, 200);
  assert.equal(other.reply.ok, false);
  assert.equal(other.reply.error.code, "no_session");
  assert.deepEqual(
    gyst(repo, "session", "list").sessions.map((s) => s.id),
    [one.id],
  );
  await page2.reload();
  await page2.getByRole("heading", { name: "Saved sessions" }).waitFor();
  assert.equal(await page2.locator(".session-row").count(), 1);
  assert.equal(await page2.getByText(two.id).count(), 0);
  check(
    "UI cancel sends nothing; UI delete sends one exact {command,session,requestId} and gets {ok,deleted,sessionId}; same-request replay gets that reply again, a new intent gets no_session; deleted id gone from CLI and UI, other scope kept",
  );

  // Ctrl-C both foreground launches: CLI and saved state stay usable, daemon keeps running.
  const daemon = await daemonPid();
  assert.ok(isOwnedDaemon(daemon));
  assert.equal(await one.stop(), 130);
  assert.equal(await two.stop(), 130);
  assert.ok(isOwnedDaemon(daemon));
  assert.deepEqual(
    gyst(repo, "session", "list").sessions.map((s) => s.id),
    [one.id],
  );
  check("SIGINT stops each viewer with 130; daemon alive; saved sessions intact and CLI usable");

  // Scope reuse after refs move and a daemon restart; exact-id reopen through a new launcher.
  const [saved] = gyst(repo, "session", "list").sessions;
  assert.deepEqual(await stopDaemon(), { pid: daemon, stopped: "SIGTERM" });
  assert.equal(isAlive(daemon), false);
  git(repo, "commit", "-qam", "move feature");
  const three = await launch(repo);
  assert.equal(three.id, one.id);
  // The launch started a new daemon from this install; the old one stayed gone.
  const replacement = await daemonPid();
  assert.notEqual(replacement, daemon);
  assert.ok(isOwnedDaemon(replacement));
  assert.equal(isAlive(daemon), false);
  const four = await launch(repo, "--session", one.id);
  assert.equal(four.id, one.id);
  const page4 = watch(await context.newPage(), "exact-id reopen");
  await go(page4, four.url);
  await page4.locator(".pane").getByText("uncommitted-edit").waitFor();
  assert.equal(await three.stop(), 130);
  const [reopened] = gyst(repo, "session", "list").sessions;
  assert.deepEqual([reopened.id, reopened.snapshotId], [saved.id, saved.snapshotId]);
  assert.equal(await daemonPid(), replacement);
  result.daemons = { first: daemon, replacement };
  check(
    "daemon restart: the owned daemon exited on SIGTERM, the next root `gyst` started a new owned daemon (new pid); after a new commit it reused the saved session with the same snapshot id, which the exact-id reopen renders",
  );

  // Real private SSH local forward on an unequal port to the installed foreground app.
  const ssh = join(root, "s");
  await mkdir(ssh, { mode: 0o700 });
  for (const name of ["host", "client"])
    execFileSync(
      join(sshBin, "ssh-keygen"),
      ["-q", "-t", "ed25519", "-N", "", "-C", "g86", "-f", join(ssh, name)],
      { timeout: 15_000 },
    );
  await writeFile(join(ssh, "auth"), await readFile(join(ssh, "client.pub")), { mode: 0o600 });
  const sshPort = await freePort();
  let forward;
  do forward = await freePort();
  while (forward === sshPort || forward === four.port);
  const hostKey = (await readFile(join(ssh, "host.pub"), "utf8"))
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  await writeFile(join(ssh, "known"), `[127.0.0.1]:${sshPort} ${hostKey}\n`, { mode: 0o600 });
  const user = userInfo().username;
  await writeFile(
    join(ssh, "sshd_config"),
    `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${ssh}/host\nPidFile ${ssh}/pid\nAuthorizedKeysFile ${ssh}/auth\nStrictModes yes\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\nPermitRootLogin no\nAllowUsers ${user}\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:${four.port}\nGatewayPorts no\nPermitTTY no\nX11Forwarding no\nAllowAgentForwarding no\nLogLevel VERBOSE\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(ssh, "ssh_config"),
    `Host g86\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User ${user}\n  IdentityFile ${ssh}/client\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${ssh}/known\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  UpdateHostKeys no\n  BatchMode yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  ExitOnForwardFailure yes\n  ConnectTimeout 5\n  ControlMaster no\n  ControlPath none\n  LocalForward 127.0.0.1:${forward} 127.0.0.1:${four.port}\n`,
    { mode: 0o600 },
  );
  execFileSync(join(sshBin, "sshd"), ["-t", "-f", join(ssh, "sshd_config")], {
    timeout: 15_000,
  });
  // Harness fault: the SSH client file is missing or not executable (mode 0600).
  const noexec = join(ssh, "ssh-noexec");
  if (inject === "ssh-noexec") await writeFile(noexec, "#!/bin/sh\n", { mode: 0o600 });
  const sshFile = (name) =>
    name !== "ssh"
      ? join(sshBin, name)
      : inject === "ssh-missing"
        ? join(ssh, "ssh-missing")
        : inject === "ssh-noexec"
          ? noexec
          : join(sshBin, name);
  const started = (name, args, ready) => {
    const { child, exited } = own(name, sshFile(name), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    const up = new Promise((resolve, reject) => {
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        log += chunk;
        if (log.includes(ready)) resolve(() => log);
      });
      void exited.then((code) => reject(new Error(`${name} exited ${code}`)));
    });
    return within(up, 15_000, `${name} to be ready`);
  };
  const sshdLog = await started(
    "sshd",
    ["-D", "-e", "-f", join(ssh, "sshd_config")],
    "Server listening on 127.0.0.1",
  );
  const sshLog = await started(
    "ssh",
    ["-v", "-F", join(ssh, "ssh_config"), "-N", "g86"],
    "Local forwarding listening on 127.0.0.1",
  );
  if (inject === "fail-after-ssh") throw new Error("injected failure with every process running");
  const tunneled = watch(await (await browser.newContext()).newPage(), "ssh forward");
  const bootstrap4 = four.url.split("#")[1];
  await go(tunneled, `http://${four.hostname}:${forward}${four.path}#${bootstrap4}`);
  await tunneled.locator(".pane").getByText("uncommitted-edit").waitFor();
  assert.equal(new URL(tunneled.url()).port, String(forward));
  assert.ok(sshdLog().includes("Accepted publickey"));
  assert.ok(sshLog().includes("is known and matches the ED25519 host key"));
  assert.equal(await four.stop(), 130);
  result.ports = { listener: four.port, forward, ssh: sshPort };
  check(
    "real key-authenticated localhost SSH forward (unequal ports) drives the installed viewer; Origin/Host use the forward port",
  );

  await go(page, "chrome://sandbox/");
  assert.match(await page.locator("body").innerText(), /You are adequately sandboxed/);
  check("Chromium reports it is sandboxed");

  result.httpErrors = watched.map(({ label, responses, console }) => ({
    label,
    responses,
    console,
  }));
  for (const { label, expected, responses, console } of watched) {
    assert.deepEqual(responses, expected, `${label}: HTTP error responses`);
    assert.deepEqual(console, expected, `${label}: console resource errors`);
  }
  assert.deepEqual(result.unexpected, []);
  check(
    "every page's HTTP error responses and console resource errors equal exactly its deliberate list; no other console error, page error or failed request",
  );
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  // Every step runs even if an earlier one failed; genuine failures are reported together.
  const failures = [];
  const attempt = (label, run) =>
    Promise.resolve()
      .then(run)
      .catch((error) => failures.push(`${label}: ${redact(error.message ?? error)}`));
  const cleanup = { children: [] };
  await attempt("browser close", () => browser && within(browser.close(), 15_000, "browser close"));
  for (const entry of owned.toReversed())
    await attempt(entry.label, async () => {
      cleanup.children.push({
        label: entry.label,
        pid: entry.child.pid,
        exit: await stopOwned(entry),
      });
      if (entry.errors.length > 0) throw new Error(entry.errors.join("; "));
    });
  await attempt("daemon", async () => (cleanup.daemon = await stopDaemon()));
  const patterns = [root, installed?.prefix].filter(Boolean);
  await attempt("leftover processes", () => {
    const escaped = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    // Harness fault: an unbalanced parenthesis makes pgrep itself fail (status 2).
    const pattern = inject === "pgrep-fault" ? `${escaped}(` : escaped;
    const found = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 10_000 });
    // Only 0 (matches) and 1 (none) are answers; anything else leaves leftovers unknown.
    if (found.error || found.signal || ![0, 1].includes(found.status)) {
      cleanup.leftoverPids = "unknown";
      throw new Error(
        `pgrep failed (${found.error?.message ?? found.signal ?? `status ${found.status}`}): ${found.stderr?.trim()}`,
      );
    }
    cleanup.leftoverPids = found.stdout.trim().split("\n").filter(Boolean).map(Number);
    if (cleanup.leftoverPids.length > 0) throw new Error(`still running: ${cleanup.leftoverPids}`);
  });
  await attempt("install teardown", () => teardown?.());
  await attempt("private root removal", () => rm(root, { recursive: true, force: true }));
  cleanup.root = root;
  cleanup.prefix = installed?.prefix;
  cleanup.failures = failures;
  result.cleanup = cleanup;
  if (failures.length > 0) process.exitCode = 1;
  console.log(redact(JSON.stringify(result, null, 2)));
}
