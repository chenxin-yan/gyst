// Component check of the built viewer (apps/gyst/dist/web-ui) in a real sandboxed Chromium. The
// launcher is replaced by an explicit in-process MOCK transport with fixture sessions: this pins
// the viewer's bootstrap, routing, rendering and deletion behavior, not the installed product.
//
//   CHROMIUM_PATH=/path/to/chromium node apps/gyst/scripts/check-web-ui.mjs
//
// Writes gyst-web-ui-{desktop,narrow}.png screenshots to the temporary directory.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) throw new Error("set CHROMIUM_PATH to a Chromium executable");
const webUi = fileURLToPath(new URL("../dist/web-ui/", import.meta.url));
const secret = "check-bootstrap-secret";
const cookie = "check-cookie-value";

const summary = (id, scope) => ({
  id,
  repoRoot: "/work/demo",
  scope,
  snapshotId: `snap-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});
const hostile = '<img src=x onerror="window.injected=1">';
const hunks = [
  {
    id: "h1",
    file: "src/app.ts",
    header: "@@ -1,3 +1,3 @@",
    patch: `@@ -1,3 +1,3 @@\n const a = 1;\n-const b = "${hostile}";\n+const b = 2;\n context();`,
    contentHash: "c1",
  },
  {
    id: "h2",
    file: "README.md",
    header: "@@ -10,0 +11,1 @@",
    patch: "@@ -10,0 +11,1 @@\n+A new line\n\\ No newline at end of file",
    contentHash: "c2",
  },
];
const sessions = new Map([
  ["s-range", summary("s-range", { kind: "range", range: "main...feature" })],
  ["s-local", summary("s-local", { kind: "uncommitted" })],
]);

const calls = { bootstrap: [], operations: [] };
// Test controls: lose the next delete reply after applying it (the first delete starts lost), or
// hold the next delete until released.
const control = {
  loseNextDelete: true,
  holdDelete: /** @type {Promise<void> | undefined} */ (undefined),
  held: false,
};
// Like the daemon, a delete's request id is recorded and answers every retry of that request.
const deleteReceipts = new Map();
const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const internal = {
  ok: false,
  error: { code: "internal_error", message: "injected internal failure" },
};
const answer = (request) => {
  // Deliberately broken daemon answers for the diagnostics regression; never listed.
  if (request.session === "s-internal") return internal;
  if (request.session === "s-bad")
    return request.command === "open"
      ? {
          ok: true,
          value: {
            session: summary("s-bad", { kind: "uncommitted" }),
            created: false,
            launch: { argv: ["gyst"] },
          },
        }
      : { ok: true, value: { sessionId: "s-bad", revision: 0, hunks: [], unexpected: true } };
  const session = sessions.get(request.session);
  const missing = { ok: false, error: { code: "no_session", message: "no such session" } };
  switch (request.command) {
    case "list":
      return { ok: true, value: { sessions: [...sessions.values()] } };
    case "open":
      return session
        ? { ok: true, value: { session, created: false, launch: { argv: ["gyst"] } } }
        : missing;
    case "diff":
      return session ? { ok: true, value: { sessionId: session.id, revision: 0, hunks } } : missing;
    case "delete": {
      const receipt = deleteReceipts.get(request.requestId);
      if (receipt !== undefined && receipt !== request.session)
        return {
          ok: false,
          error: { code: "validation_failed", message: "request id was used for another session" },
        };
      if (receipt === undefined && !session) return missing;
      sessions.delete(request.session);
      deleteReceipts.set(request.requestId, request.session);
      return { ok: true, value: { deleted: true, sessionId: request.session } };
    }
    default:
      return { ok: false, error: { code: "bad_args", message: "unsupported" } };
  }
};

const handle = async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && path === "/bootstrap") {
    calls.bootstrap.push({ authorization: req.headers.authorization, origin: req.headers.origin });
    if (req.headers.authorization !== `Bearer ${secret}`) return reply(res, 401);
    res.writeHead(204, { "set-cookie": `gyst=${cookie}; HttpOnly; SameSite=Strict; Path=/` });
    return res.end();
  }
  if (req.method === "POST" && path === "/api/operation") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.operations.push({ request, headers: req.headers });
    if (req.headers.cookie !== `gyst=${cookie}`) return reply(res, 401);
    if (request.command === "delete" && control.holdDelete) {
      const hold = control.holdDelete;
      control.holdDelete = undefined;
      control.held = true;
      await hold;
    }
    // Lose a delete's reply after the daemon applied it, as a dropped connection would.
    if (request.command === "delete" && control.loseNextDelete) {
      control.loseNextDelete = false;
      answer(request);
      return reply(res, 503);
    }
    return reply(res, 200, answer(request));
  }
  const asset = path.startsWith("/assets/") && !path.includes("..");
  const file = asset ? join(webUi, path) : join(webUi, "index.html");
  const type = { ".js": "text/javascript", ".css": "text/css" }[extname(file)] ?? "text/html";
  try {
    res.writeHead(200, { "content-type": type }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
};
const server = createServer((req, res) => void handle(req, res));

const shots = tmpdir();
const runtime = await mkdtemp(join(shots, "gyst-web-ui-check-"));
const result = { checks: [], pageErrors: [], consoleErrors: [], requestFailures: [] };
let browser;
try {
  for (const dir of ["home", "tmp", "config", "cache", "data"]) await mkdir(join(runtime, dir));
  process.env.TMPDIR = join(runtime, "tmp");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://g-check.localhost:${server.address().port}`;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: true,
    timeout: 15000,
    proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,.localhost" },
    env: {
      ...process.env,
      HOME: join(runtime, "home"),
      XDG_CONFIG_HOME: join(runtime, "config"),
      XDG_CACHE_HOME: join(runtime, "cache"),
      XDG_DATA_HOME: join(runtime, "data"),
    },
  });
  result.browser = browser.version();
  const watch = (page) => {
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) =>
      result.requestFailures.push(`${request.url()} ${request.failure()?.errorText}`),
    );
    return page;
  };
  const check = (name) => result.checks.push(name);

  // Launch URL: deep session path plus the bootstrap fragment.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = watch(await context.newPage());
  const documents = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
    if (request.resourceType() === "script") assert.match(request.url(), /\/assets\/.+\.js$/);
  });
  await page.goto(`${base}/session/s-range#${secret}`);
  const crumb = page.getByRole("heading", { level: 1 });
  await crumb.waitFor();
  assert.equal(await crumb.textContent(), "demo/main...feature");
  assert.equal(await crumb.getAttribute("title"), "/work/demo");
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(await page.evaluate(() => location.href.includes("#")), false);
  assert.deepEqual(calls.bootstrap, [{ authorization: `Bearer ${secret}`, origin: base }]);
  check("launch fragment stripped; bootstrap POST sent the bearer secret with the page Origin");

  const operation = calls.operations[0];
  assert.equal(operation.headers.origin, base);
  assert.equal(operation.headers["content-type"], "application/json");
  assert.equal(operation.headers.authorization, undefined);
  assert.deepEqual(
    calls.operations.map((call) => call.request).sort((a, b) => a.command.localeCompare(b.command)),
    [
      { command: "diff", session: "s-range" },
      { command: "open", session: "s-range" },
    ],
  );
  check("deep path selected the session: raw open + diff BrowserRequests with cookie only");

  const pane = page.locator(".pane");
  await pane.getByText(hostile, { exact: false }).waitFor();
  assert.equal(await pane.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await pane.getByRole("heading", { level: 2 }).count(), 2);
  assert.equal(await pane.locator(".hunk-line.add").count(), 2);
  assert.equal(await pane.locator(".hunk-line.del").count(), 1);
  assert.deepEqual(
    await pane
      .locator(".hunk-line.add .num")
      .evaluateAll((cells) => cells.map((cell) => cell.textContent)),
    ["", "2", "", "11"],
  );
  check("real Hunk.patch lines rendered as escaped text with old/new line numbers");

  await page.getByRole("link", { name: "All sessions" }).click();
  await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
  assert.equal(await page.locator(".session-row").count(), 2);
  assert.equal(documents.length, 1);
  check("client navigation to the saved-session list without a document load");

  await page.reload();
  await page.getByRole("heading", { name: "Saved sessions" }).waitFor();
  assert.equal(calls.bootstrap.length, 1);
  check("reload without fragment authorized by the launch cookie; no second bootstrap");

  const local = page.locator(".session-row", { hasText: "uncommitted changes" });
  await local.getByRole("button", { name: "Delete…" }).click();
  await local
    .getByRole("group", { name: "Confirm session deletion" })
    .getByText("s-local")
    .waitFor();
  await local.getByRole("button", { name: "Cancel" }).click();
  await local.getByRole("button", { name: "Delete…" }).click();
  await page.keyboard.press("Escape");
  await local.getByRole("button", { name: "Delete…" }).waitFor();
  assert.equal(calls.operations.filter((call) => call.request.command === "delete").length, 0);
  await local.getByRole("button", { name: "Delete…" }).click();
  await local.getByRole("button", { name: "Delete session" }).click();
  await local.getByRole("alert").waitFor();
  await local.getByRole("button", { name: "Retry delete" }).click();
  await page.locator(".session-row", { hasText: "uncommitted changes" }).waitFor({
    state: "detached",
  });
  const deletes = calls.operations.filter((call) => call.request.command === "delete");
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].request.session, "s-local");
  assert.deepEqual(deletes[1].request, deletes[0].request);
  assert.match(deletes[0].request.requestId, /^[0-9a-f]{32}$/);
  assert.equal(await page.locator(".session-row").count(), 1);
  check(
    "cancel and Escape send nothing; lost delete reply retried with the same request id; other kept",
  );

  await page.goto(`${base}/session/missing`);
  await page.getByRole("heading", { name: "Session not found" }).waitFor();
  await page.goto(`${base}/deliberately/unknown`);
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
  check("missing session and unknown route render explicit not-found views");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/session/s-range`);
  await page.locator(".hunk").first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(shots, "gyst-web-ui-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".top").getByRole("button", { name: "Delete…" }).click();
  await page.screenshot({ path: join(shots, "gyst-web-ui-desktop.png") });
  await page.locator(".top").getByRole("button", { name: "Cancel" }).click();
  check("narrow viewport keeps the real-hunk view within the page width");

  // The session list is visited (and cached) before this session is deleted from its own page.
  await page.getByRole("link", { name: "All sessions" }).click();
  await page.locator(".session-row").waitFor();
  await page.getByRole("link", { name: /main\.\.\.feature/ }).click();
  await page.locator(".top").getByRole("button", { name: "Delete…" }).click();
  await page.locator(".top").getByRole("button", { name: "Delete session" }).click();
  await page.getByText("No saved sessions.").waitFor();
  assert.equal(await page.locator(".session-row").count(), 0);
  assert.equal(new URL(page.url()).pathname, "/");
  check("deleting from the session page returns to a fresh, empty saved-session list");

  // Review regressions: each runs on its own page and records its failure without stopping the
  // others, so a broken build reports every one.
  const failures = [];
  const regression = async (name, run) => {
    try {
      await run();
      check(name);
    } catch (error) {
      failures.push(`${name}: ${error.message.split("\n").slice(0, 6).join(" ")}`);
    }
  };
  const top = (tab) => tab.locator(".top");
  const crumbIs = async (tab, text) => {
    const heading = tab.getByRole("heading", { level: 1 });
    await tab.waitForFunction(
      (expected) => document.querySelector("h1")?.textContent === expected,
      text,
    );
    assert.equal(await heading.textContent(), text);
  };
  const lastDelete = () =>
    calls.operations.filter((call) => call.request.command === "delete").at(-1)?.request;
  const addSessions = () => {
    sessions.set("s-a", summary("s-a", { kind: "range", range: "topic-a" }));
    sessions.set("s-b", summary("s-b", { kind: "range", range: "topic-b" }));
  };
  const onlyResourceErrors = (messages) =>
    messages.every((message) => /^Failed to load resource: .* (401|503)/.test(message));

  await regression(
    "history switch after a lost delete reply does not carry B's retry to A",
    async () => {
      addSessions();
      const tab = watch(await context.newPage());
      await tab.goto(`${base}/session/s-a`);
      await crumbIs(tab, "demo/topic-a");
      await top(tab).getByRole("link", { name: "All sessions" }).click();
      await tab.getByRole("link", { name: /topic-b/ }).click();
      await crumbIs(tab, "demo/topic-b");
      control.loseNextDelete = true;
      await top(tab).getByRole("button", { name: "Delete…" }).click();
      await top(tab).getByRole("button", { name: "Delete session" }).click();
      await top(tab).getByRole("button", { name: "Retry delete" }).waitFor();
      const lostB = lastDelete();
      assert.equal(lostB.session, "s-b");
      await tab.evaluate(() => history.go(-2));
      await crumbIs(tab, "demo/topic-a");
      assert.equal(await top(tab).getByRole("button", { name: "Retry delete" }).count(), 0);
      assert.equal(await top(tab).getByRole("group").count(), 0);
      await top(tab).getByRole("button", { name: "Delete…" }).click();
      await top(tab).getByRole("group").getByText("s-a").waitFor();
      await top(tab).getByRole("button", { name: "Delete session" }).click();
      await tab.waitForURL(`${base}/`);
      const deleteA = lastDelete();
      assert.equal(deleteA.session, "s-a");
      assert.notEqual(deleteA.requestId, lostB.requestId);
      assert.ok(!sessions.has("s-a"));
      await tab.close();
    },
  );

  await regression(
    "a delayed delete of A settling while B is shown leaves B selected",
    async () => {
      addSessions();
      const tab = watch(await context.newPage());
      await tab.goto(`${base}/session/s-a`);
      await crumbIs(tab, "demo/topic-a");
      let release;
      control.held = false;
      control.holdDelete = new Promise((resolve) => (release = resolve));
      await top(tab).getByRole("button", { name: "Delete…" }).click();
      await top(tab).getByRole("button", { name: "Delete session" }).click();
      await top(tab).getByRole("button", { name: "Deleting…" }).waitFor();
      for (let i = 0; !control.held; i++) {
        assert.ok(i < 100, "delete never reached the mock launcher");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await top(tab).getByRole("link", { name: "All sessions" }).click();
      await tab.getByRole("link", { name: /topic-b/ }).click();
      await crumbIs(tab, "demo/topic-b");
      const settled = tab.waitForResponse(
        (response) => response.request().postDataJSON()?.command === "delete",
      );
      release();
      await settled;
      await tab.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
      assert.equal(new URL(tab.url()).pathname, "/session/s-b");
      await crumbIs(tab, "demo/topic-b");
      assert.equal(await tab.getByRole("alert").count(), 0);
      await tab.close();
    },
  );

  await regression(
    "unexpected failures keep console diagnostics; expected ones do not",
    async () => {
      const tab = watch(await context.newPage());
      const before = result.consoleErrors.length;
      await tab.goto(`${base}/session/s-bad`);
      await tab.getByRole("alert").getByText("can't read").waitFor();
      await tab.goto(`${base}/session/s-internal`);
      await tab.getByRole("alert").getByText("injected internal failure").waitFor();
      await tab.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
      // Move these deliberate diagnostics out of the final all-clear accounting.
      const logged = result.consoleErrors.splice(before);
      result.expectedDiagnostics = logged;
      assert.ok(
        logged.some((message) => message.includes("can't read")),
        "bad payload not logged",
      );
      assert.ok(
        logged.some((message) => message.includes("injected internal failure")),
        "internal_error not logged",
      );
      for (const message of logged)
        for (const value of [secret, cookie]) assert.ok(!message.includes(value));
      await tab.close();
    },
  );

  // The launcher is live here, so a 401 without a link must not claim that it stopped.
  await regression(
    "401 guidance separates an expired link from a browser not signed in",
    async () => {
      const before = result.consoleErrors.length;
      const expiredLink = watch(await (await browser.newContext()).newPage());
      await expiredLink.goto(`${base}/#wrong-secret`);
      const expired = expiredLink.getByRole("alert");
      await expired.waitFor();
      const expiredText = await expired.innerText();
      assert.match(expiredText, /link/i);
      assert.match(expiredText, /expired/);
      assert.match(expiredText, /10 minutes/);
      assert.match(expiredText, /Run gyst \(or gyst --session <id>\)/);
      assert.equal(new URL(expiredLink.url()).hash, "");

      const noLink = watch(await (await browser.newContext()).newPage());
      await noLink.goto(`${base}/`);
      const ended = noLink.getByRole("alert");
      await ended.waitFor();
      const endedText = await ended.innerText();
      assert.match(endedText, /This browser is not signed in to this gyst launch\./);
      assert.doesNotMatch(endedText, /expire|has stopped|ended/);
      assert.match(endedText, /until (its|that) gyst stops/);
      assert.match(endedText, /Run gyst \(or gyst --session <id>\)/);
      for (const text of [expiredText, endedText])
        for (const value of ["wrong-secret", secret, cookie]) assert.ok(!text.includes(value));
      // An expected 401 is explained on the page, not logged as a defect.
      assert.ok(onlyResourceErrors(result.consoleErrors.slice(before)));
    },
  );

  assert.deepEqual(failures, []);

  // Chromium logs each intentional non-2xx fetch (the lost delete reply and the refused 401s).
  const expected = /Failed to load resource: the server responded with a status of (401|503)/;
  assert.ok(result.consoleErrors.every((message) => expected.test(message)));
  assert.equal(result.consoleErrors.filter((message) => message.includes("503")).length, 2);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.requestFailures, []);
  check("no page errors or failed requests; console errors only for injected 401/503 responses");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
  await rm(runtime, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}
