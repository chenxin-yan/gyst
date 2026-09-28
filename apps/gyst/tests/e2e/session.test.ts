import { SourceCheckPayloadSchema, StatusPayloadSchema } from "@gyst/core";
import { Schema } from "effect";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import {
  commandLine,
  daemonPid,
  failed,
  installed,
  installedDaemons,
  isAlive,
  json,
  killDaemon,
  sandbox,
  succeeded,
  waitFor,
} from "./installed-gyst.ts";

// The installed daemon reports its package version.
const daemonVersion = packageJson.version;

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

const git = (box: Sandbox, cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: box.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function repo(box: Sandbox, name: string): Promise<string> {
  const cwd = join(box.root, name);
  await mkdir(cwd, { recursive: true });
  git(box, cwd, "init", "-q");
  git(box, cwd, "config", "user.email", "test@gyst.invalid");
  git(box, cwd, "config", "user.name", "Gyst Test");
  await writeFile(join(cwd, "tracked.txt"), "one\n");
  git(box, cwd, "add", ".");
  git(box, cwd, "commit", "-qm", "initial");
  return cwd;
}

function socketRequest(dataDir: string, message: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = connect(join(dataDir, "daemon.sock"));
    socket.setTimeout(2000, () => socket.destroy(new Error("socket request timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (bytes) => {
      reply += bytes.toString();
      if (reply.includes("\n")) {
        socket.destroy();
        resolve(reply.split("\n")[0]!);
      }
    });
  });
}

/**
 * A scripted socket peer for client negotiation cases that no daemon of this version produces:
 * `reply` returns the reply line's value, `null` to close without replying, or `undefined` to never answer.
 * Stopped after the test.
 */
async function fakeDaemon(dataDir: string, reply: (message: any) => unknown) {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      const message = JSON.parse(buffered.slice(0, end));
      commands.push(message.command ?? message.request?.command);
      const value = reply(message);
      if (value === null) socket.end();
      else if (value !== undefined) socket.end(`${JSON.stringify(value)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(dataDir, "daemon.sock"), resolve);
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  onTestFinished(stop);
  return { commands, stop };
}

describe("gyst session CLI seam", () => {
  it("checks scoped Git sources across restart without replacing snapshots, and distinguishes stdin", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "source-check");
    const nested = join(cwd, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "inside.txt"), "base\n");
    git(box, cwd, "add", ".");
    git(box, cwd, "commit", "-qm", "nested file");
    await writeFile(join(nested, "inside.txt"), "captured\n");
    const created = await gyst(nested, ["session", "create", "--", "HEAD", "--", "inside.txt"]);
    const captured = json(created);
    const savedPath = join(data, `${captured.session.id}.json`);
    const saved = await readFile(savedPath, "utf8");
    const check = async (directory = cwd) =>
      Schema.decodeUnknownSync(SourceCheckPayloadSchema)(
        json(await gyst(directory, ["session", "check"])),
      );
    await writeFile(join(cwd, "tracked.txt"), "outside scope\n");
    expect((await check()).state).toBe("unchanged");
    await writeFile(join(nested, "inside.txt"), "changed after capture\n");
    await killDaemon(data);
    expect((await check()).state).toBe("changed");
    expect(json(await gyst(cwd, ["session", "status"]))).toEqual(captured);
    expect(await readFile(savedPath, "utf8")).toBe(saved);
    succeeded(await gyst(cwd, ["session", "refresh"]));
    expect((await check()).state).toBe("unchanged");
    succeeded(await gyst(cwd, ["session", "close"]));

    succeeded(await gyst(nested, ["session", "create"]));
    await writeFile(join(cwd, "new-untracked.txt"), "new\n");
    expect((await check()).state).toBe("changed");
    succeeded(await gyst(cwd, ["session", "close"]));

    const base = git(box, cwd, "rev-parse", "HEAD~1").trim();
    const head = git(box, cwd, "rev-parse", "HEAD").trim();
    succeeded(await gyst(cwd, ["session", "create", "--", base, head]));
    await writeFile(join(nested, "inside.txt"), "working tree is not the fixed range\n");
    expect((await check()).state).toBe("unchanged");
    succeeded(await gyst(cwd, ["session", "close"]));

    succeeded(await gyst(cwd, ["session", "create", "--stdin"], git(box, cwd, "diff", "HEAD")));
    expect((await check()).state).toBe("stdin");
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("maps create operands and selectors from the command line without changing their replies", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "operands");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    git(box, cwd, "add", "other.txt");
    const source = async (args: string[]) => {
      const { session } = json(await gyst(cwd, ["session", "create", ...args]));
      succeeded(await gyst(cwd, ["session", "close", "--session", session.id]));
      return session.source.args;
    };
    expect(await source(["HEAD"])).toEqual(["HEAD"]);
    expect(await source(["--", "HEAD", "--", "tracked.txt"])).toEqual([
      "HEAD",
      "--",
      "tracked.txt",
    ]);
    expect(await source(["HEAD", "--", "tracked.txt"])).toEqual(["HEAD", "tracked.txt"]);
    expect(await source(["--", "HEAD", "--", "a", "--", "tracked.txt"])).toEqual([
      "HEAD",
      "--",
      "a",
      "--",
      "tracked.txt",
    ]);

    const failure = async (args: string[], stdin?: string) =>
      failed(await gyst(cwd, ["session", ...args], stdin));
    expect(await failure(["create", "--", "HEAD", "--stat"])).toEqual({
      code: "bad_args",
      message: "git options are not accepted: --stat",
    });
    expect(await failure(["create", "--", "HEAD", "--", "-p"])).toEqual({
      code: "bad_args",
      message: "git options are not accepted: -p",
    });
    expect(await failure(["create", "--stdin", "HEAD"], "")).toEqual({
      code: "bad_args",
      message: "--stdin cannot be combined with git arguments",
    });
    expect(await failure(["status", "--stdin"])).toMatchObject({ code: "bad_args" });

    const created = json(await gyst(cwd, ["session", "create"]));
    const hunks = async (args: string[]) =>
      json(await gyst(cwd, ["session", "diff", ...args])).hunks.map(
        ({ file }: { file: string }) => file,
      );
    expect(await hunks([])).toEqual(["other.txt", "tracked.txt"]);
    expect(await hunks(["--session", created.session.id, "--file", "other.txt"])).toEqual([
      "other.txt",
    ]);
    expect(await failure(["diff", "--hunk", "x", "--file", "other.txt"])).toEqual({
      code: "bad_args",
      message: "choose only one diff selector",
    });
    expect(await failure(["status", "--session", "missing"])).toEqual({
      code: "no_session",
      message: "no session with id missing",
    });
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("passes inline string flag values that start with a dash to the operation unchanged", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "inline-flags");
    await writeFile(join(cwd, "-name.txt"), "dash\n");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    git(box, cwd, "add", "--", "-name.txt");
    const created = json(await gyst(cwd, ["session", "create"]));
    expect(failed(await gyst(cwd, ["session", "status", "--session=--missing"]))).toEqual({
      code: "no_session",
      message: "no session with id --missing",
    });
    const selected = json(
      await gyst(cwd, ["session", "diff", `--session=${created.session.id}`, "--file=-name.txt"]),
    );
    expect(selected.hunks.map(({ file }: { file: string }) => file)).toEqual(["-name.txt"]);
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("serializes concurrent startup and create for one repository", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "concurrent-create");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");

    const results = await Promise.all([
      gyst(cwd, ["session", "create"]),
      gyst(cwd, ["session", "create"]),
    ]);
    expect(results.map(({ exitCode }) => exitCode).sort((a, b) => a! - b!)).toEqual([0, 1]);
    expect(failed(results.find(({ exitCode }) => exitCode === 1)!).code).toBe("session_exists");
    const status = json(await gyst(cwd, ["session", "status"]));
    expect((await readdir(data)).filter((file) => file.endsWith(".json"))).toEqual([
      `${status.session.id}.json`,
    ]);
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("creates bare snapshots, respawns from persistence, and shuts down after the last close", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "bare");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");

    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(
      json(await gyst(cwd, ["session", "create"])),
    );
    expect(status.inbox.length).toBe(2);
    expect(status.session.source).toEqual({
      kind: "git",
      patchHash: expect.any(String),
      args: ["HEAD"],
      cwd,
      includeUntracked: true,
    });
    const hunkId = status.inbox[0]!.id;

    const pid = await killDaemon(data);
    // Seed review state on disk: the respawned daemon must serve it, not the pre-kill snapshot.
    const statePath = join(data, `${status.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups = [
      {
        id: "group-1",
        title: "same edit",
        notes: [{ hunkId, text: "intent and behavior" }],
        hunkIds: [hunkId],
        accepted: false,
      },
    ];
    const independentHunk = state.hunks.find((hunk: { id: string }) => hunk.id !== hunkId);
    state.groups.push({
      id: "group-2",
      hunkIds: [independentHunk.id],
      title: "needs human review",
      notes: [{ hunkId: independentHunk.id, text: "intent and behavior" }],
      accepted: false,
    });
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(data, "corrupt.json"), "not json");
    const restoredStatus = json(await gyst(cwd, ["session", "status"]));
    expect(restoredStatus.session.id).toBe(status.session.id);
    expect(restoredStatus.groups[0].count).toBe(1);
    expect(restoredStatus.groups[1]).toEqual({
      id: "group-2",
      hunkIds: [independentHunk.id],
      count: 1,
      title: "needs human review",
      notes: [{ hunkId: independentHunk.id, text: "intent and behavior" }],
      accepted: false,
    });
    expect(restoredStatus.inbox).toEqual([]);
    const respawned = await daemonPid(data);
    expect(respawned).not.toBe(pid);
    // The CLI relaunched its own installed entry on the Node under test.
    const launched = commandLine(respawned);
    expect(launched.startsWith(`${process.execPath} `)).toBe(true);
    expect(launched).toContain(installed.prefix);
    expect(launched.endsWith(" daemon run")).toBe(true);

    expect(json(await gyst(cwd, ["session", "close"]))).toEqual({
      closed: true,
      sessionId: status.session.id,
    });
    await waitFor(
      () => !isAlive(respawned) && !existsSync(join(data, "daemon.pid")),
      `daemon ${respawned} to exit after the last close`,
    );
    expect(await readdir(data)).toEqual(["corrupt.json"]);
  }, 20_000);

  it("keeps failed persistence from exposing a session", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "persist-failure");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    expect(failed(await gyst(cwd, ["session", "status"])).code).toBe("no_session");
    await chmod(data, 0o500);
    const failedCreate = await gyst(cwd, ["session", "create"]);
    await chmod(data, 0o700);
    expect(failed(failedCreate).code).toBe("daemon_unreachable");

    succeeded(await gyst(cwd, ["session", "create"]));
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("keeps a replacement session alive during final-session shutdown", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const first = await repo(box, "shutdown-first");
    const replacement = await repo(box, "shutdown-replacement");
    await writeFile(join(first, "tracked.txt"), "first changed\n");
    await writeFile(join(replacement, "tracked.txt"), "replacement changed\n");
    succeeded(await gyst(first, ["session", "create"]));
    const pid = await daemonPid(data);

    const [closed, created] = await Promise.all([
      gyst(first, ["session", "close"]),
      gyst(replacement, ["session", "create"]),
    ]);
    succeeded(closed);
    succeeded(created);
    // Nothing signals "did not shut down": give the 20 ms idle debounce time to act wrongly.
    await sleep(100);
    expect(isAlive(pid)).toBe(true);
    succeeded(await gyst(replacement, ["session", "status"]));
    expect(await daemonPid(data)).toBe(pid);
    succeeded(await gyst(replacement, ["session", "close"]));
  }, 20_000);

  it("preserves split UTF-8 input at the socket boundary", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "utf8-socket");
    // Start the daemon without creating a session, then write one request in deliberately split byte chunks.
    expect(failed(await gyst(cwd, ["session", "status"])).code).toBe("no_session");
    const patch = `diff --git a/tracked.txt b/tracked.txt
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-one
+café
`;
    const hello = JSON.parse(await socketRequest(data, { command: "daemon.info" }));
    const request = new TextEncoder().encode(
      `${JSON.stringify({ ...hello.value, request: { command: "create", cwd, revisions: [], patch } })}\n`,
    );
    const marker = new TextEncoder().encode("é");
    const markerStart = request.findIndex(
      (byte, index) => byte === marker[0] && request[index + 1] === marker[1],
    );
    expect(markerStart).toBeGreaterThan(0);
    const reply = await new Promise<string>((resolve, reject) => {
      let response = "";
      const decoder = new TextDecoder();
      const socket = connect(join(data, "daemon.sock"));
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request.slice(0, markerStart + 1));
        setTimeout(() => socket.write(request.slice(markerStart + 1)), 5);
      });
      socket.on("data", (bytes) => {
        response += decoder.decode(bytes, { stream: true });
        if (response.includes("\n")) {
          socket.destroy();
          resolve(response);
        }
      });
    });
    expect(JSON.parse(reply).ok).toBe(true);
    const diff = json(await gyst(cwd, ["session", "diff"]));
    expect(diff.hunks[0].patch).toContain("café");
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("moves large requests and replies through the socket completely", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "large");
    const line = "x".repeat(2_000_000);
    const patch = `diff --git a/tracked.txt b/tracked.txt
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-one
+${line}
`;
    succeeded(await gyst(cwd, ["session", "create", "--stdin"], patch));
    const diff = json(await gyst(cwd, ["session", "diff"]));
    expect(diff.hunks[0].patch.endsWith(line)).toBe(true);
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("reclaims a dead daemon's socket under concurrent starts", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "reclaim");
    expect(failed(await gyst(cwd, ["session", "status"])).code).toBe("no_session");
    const pid = await killDaemon(data);
    expect(await readdir(data)).toContain("daemon.sock");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => gyst(cwd, ["session", "status"])),
    );
    expect(results.map((result) => failed(result).code)).toEqual(Array(4).fill("no_session"));
    // Losers of the link race notice within their 1 s inode check and exit.
    await waitFor(() => installedDaemons().length === 1, "exactly one daemon to remain");
    const [survivor] = installedDaemons();
    expect(survivor).not.toBe(pid);
    expect(isAlive(survivor!)).toBe(true);
    // The pid file may briefly name a loser; the owner rewrites it on its next inode check.
    await waitFor(
      async () => (await daemonPid(data)) === survivor,
      `daemon.pid to name ${survivor}`,
    );
    expect(installedDaemons()).toEqual([survivor]);
    expect((await readdir(data)).sort()).toEqual(["daemon.pid", "daemon.sock"]);
  }, 20_000);

  it("exits 130 on SIGINT through crust's cancellation and releases the socket and pid file", async () => {
    const box = await sandbox();
    const ownData = join(box.root, "sigint-data");
    const daemon = spawn(installed.bin, ["daemon", "run"], {
      cwd: box.root,
      env: { ...box.env, GYST_DATA_DIR: ownData },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    daemon.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      daemon.once("close", (code, signal) => resolve([code, signal])),
    );
    onTestFinished(() => void daemon.kill("SIGKILL"));
    await waitFor(
      async () => (await daemonPid(ownData)) === daemon.pid,
      `daemon ${daemon.pid} to publish its pid file`,
    );
    daemon.kill("SIGINT");
    expect(await exited).toEqual([130, null]);
    expect(stderr).toBe("");
    expect(await readdir(ownData)).toEqual([]);
  }, 20_000);

  it("applies batches atomically and replays receipts across a daemon restart", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    const created = json(await gyst(cwd, ["session", "create"]));
    const [first, second] = created.inbox;

    const invalidError = failed(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "invalid-batch",
          ops: [
            {
              type: "group.create",
              id: "group-1",
              title: "coherent change",
              notes: [{ hunkId: first.id, text: "intent and behavior" }],
              memberHunkIds: [first.id],
            },
            { type: "group.update", id: "missing", title: "nope" },
          ],
        }),
      ),
    );
    expect(invalidError.code).toBe("validation_failed");
    expect(invalidError.detail).toEqual([expect.objectContaining({ opIndex: 1 })]);
    expect(json(await gyst(cwd, ["session", "status"])).groups).toEqual([]);

    const envelope = {
      revision: 0,
      idempotencyKey: "pre-pass",
      ops: [
        {
          type: "group.create",
          id: "group-1",
          title: "coherent change",
          notes: [{ hunkId: first.id, text: "intent and behavior" }],
          memberHunkIds: [first.id],
        },
        {
          type: "group.create",
          id: "group-2",
          memberHunkIds: [second.id],
          title: "read this",
          notes: [{ hunkId: second.id, text: "read this" }],
        },
        { type: "queue.set", itemIds: ["group-2", "group-1"] },
      ],
    };
    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(
      json(await gyst(cwd, ["session", "apply"], JSON.stringify(envelope))),
    );
    expect(status.revision).toBe(1);
    expect(status.groups).toHaveLength(2);
    expect(status.inbox).toEqual([]);
    expect(status.queue).toEqual(["group-2", "group-1"]);
    expect(status.queueSet).toBe(true);
    expect(status.ready).toBe(true);

    await killDaemon(data);
    const statePath = join(data, `${status.session.id}.json`);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    persisted.cursor = { itemId: "group-1", pane: "diff", hunkId: first.id };
    await writeFile(statePath, JSON.stringify(persisted));

    const changed = json(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 1,
          idempotencyKey: "change",
          ops: [
            {
              type: "group.update",
              id: "group-2",
              title: "updated",
              notes: [{ hunkId: second.id, text: "updated" }],
            },
            { type: "queue.set", itemIds: ["group-2", "group-1"] },
          ],
        }),
      ),
    );
    expect(changed.revision).toBe(2);
    expect(json(await gyst(cwd, ["session", "apply"], JSON.stringify(envelope)))).toEqual(status);
    expect(json(await gyst(cwd, ["session", "status"])).revision).toBe(2);

    const dissolved = json(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 2,
          idempotencyKey: "dissolve",
          ops: [
            { type: "group.dissolve", id: "group-1" },
            { type: "queue.set", itemIds: ["group-2"] },
          ],
        }),
      ),
    );
    expect(dissolved).toEqual(
      expect.objectContaining({
        groups: [expect.objectContaining({ id: "group-2", hunkIds: [second.id] })],
        queue: ["group-2"],
        queueSet: true,
        ready: false,
        cursor: { itemId: null, pane: "queue" },
      }),
    );
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("serializes concurrent mutations so revision checks prevent lost updates", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "concurrent-apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    const created = json(await gyst(cwd, ["session", "create"]));
    const hunkId = created.inbox[0].id;
    const batch = (idempotencyKey: string, title: string) =>
      JSON.stringify({
        revision: 0,
        idempotencyKey,
        ops: [
          { type: "group.create", id: "group-1", memberHunkIds: [hunkId], title, notes: [] },
          { type: "queue.set", itemIds: ["group-1"] },
        ],
      });

    const results = await Promise.all([
      gyst(cwd, ["session", "apply"], batch("concurrent-a", "first")),
      gyst(cwd, ["session", "apply"], batch("concurrent-b", "second")),
    ]);

    expect(results.map(({ exitCode }) => exitCode).sort((a, b) => a! - b!)).toEqual([0, 1]);
    expect(failed(results.find(({ exitCode }) => exitCode === 1)!).code).toBe("stale_revision");
    expect(json(await gyst(cwd, ["session", "status"])).revision).toBe(1);
    succeeded(await gyst(cwd, ["session", "close"]));
  }, 20_000);

  it("refreshes git and stdin snapshots while preserving only unchanged review work", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "refresh");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "second.txt"), "base\n");
    git(box, cwd, "add", ".");
    git(box, cwd, "commit", "-qm", "add second");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\nthree\n");
    await writeFile(join(cwd, "second.txt"), "base\nfirst change\n");
    const created = json(await gyst(cwd, ["session", "create"]));
    const first = created.inbox.find((hunk: { file: string }) => hunk.file === "tracked.txt");
    const second = created.inbox.find((hunk: { file: string }) => hunk.file === "second.txt");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const applied = json(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "fold",
          ops: [
            {
              type: "group.create",
              id: "group-1",
              title: "stable group",
              notes: [{ hunkId: first.id, text: "intent and behavior" }],
              memberHunkIds: [first.id],
            },
            {
              type: "group.create",
              id: "group-2",
              memberHunkIds: [second.id],
              title: "stale group",
              notes: [{ hunkId: second.id, text: "stale group" }],
            },
            { type: "queue.set", itemIds: ["group-1", "group-2"] },
          ],
        }),
      ),
    );

    await killDaemon(data);
    const statePath = join(data, `${applied.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups[0].accepted = true;
    await writeFile(statePath, JSON.stringify(state));

    await writeFile(join(cwd, "second.txt"), "base\nreplacement change\n");
    await writeFile(join(cwd, "new.txt"), "brand new\n");
    const refreshed = json(await gyst(cwd, ["session", "refresh"]));
    expect(refreshed.groups[0]).toEqual(
      expect.objectContaining({ id: "group-1", accepted: true, hunkIds: [first.id] }),
    );
    expect(refreshed.groups).toHaveLength(1);
    expect(refreshed.inbox).toHaveLength(2);
    expect(refreshed.queue).toEqual([
      "group-1",
      ...refreshed.inbox.map((hunk: { id: string }) => hunk.id),
    ]);
    expect(refreshed.queueSet).toBe(false);
    expect(refreshed.ready).toBe(false);

    const updated = json(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: refreshed.revision,
          idempotencyKey: "update-group",
          ops: [
            { type: "group.update", id: "group-1", title: "updated group" },
            { type: "queue.set", itemIds: ["group-1"] },
          ],
        }),
      ),
    );
    expect(updated.groups[0].accepted).toBe(false);
    succeeded(await gyst(cwd, ["session", "close"]));

    const stdinRepo = await repo(box, "refresh-stdin");
    const firstPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const secondPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+newer\n`;
    const stdinCreated = json(await gyst(stdinRepo, ["session", "create", "--stdin"], firstPatch));
    expect(failed(await gyst(stdinRepo, ["session", "refresh"])).code).toBe("bad_args");
    const stdinRefresh = json(
      await gyst(stdinRepo, ["session", "refresh", "--stdin"], secondPatch),
    );
    expect(stdinRefresh.inbox[0].id).not.toBe(stdinCreated.inbox[0].id);
    succeeded(await gyst(stdinRepo, ["session", "close"]));
  }, 20_000);

  it("skips undecodable saved sessions without reserving their repo or modifying their files", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "legacy");
    const ownData = await mkdtemp(join(box.root, "legacy-data-"));
    const path = join(ownData, "legacy.json");
    const content = JSON.stringify({ id: "legacy", repoRoot: cwd, groups: [{ tldr: "old" }] });
    await writeFile(path, content);
    for (const args of [["status"], ["status", "--session", "legacy"], ["close"]])
      expect(failed(await gyst(cwd, ["session", ...args], undefined, ownData)).code).toBe(
        "no_session",
      );
    succeeded(await gyst(cwd, ["session", "create"], undefined, ownData));
    expect(await readFile(path, "utf8")).toBe(content);
    succeeded(await gyst(cwd, ["session", "close"], undefined, ownData));
    expect(await readFile(path, "utf8")).toBe(content);
  }, 20_000);

  it("automatically replaces an older cooperative daemon without changing saved review state", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "automatic-upgrade");
    const ownData = await mkdtemp(join(box.root, "automatic-upgrade-data-"));
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const initial = json(await gyst(cwd, ["session", "create"], undefined, ownData));
    const hunkId = initial.inbox[0].id;
    const status = json(
      await gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "before-upgrade",
          ops: [
            {
              type: "group.create",
              id: "group",
              memberHunkIds: [hunkId],
              title: "Review",
              notes: [{ hunkId, text: "Keep this note." }],
            },
            { type: "queue.set", itemIds: ["group"] },
          ],
        }),
        ownData,
      ),
    );
    const savedPath = join(ownData, `${status.session.id}.json`);
    const saved = await readFile(savedPath, "utf8");
    await killDaemon(ownData, "SIGTERM");
    expect(existsSync(join(ownData, "daemon.pid"))).toBe(false);
    const fake = await fakeDaemon(ownData, (message) => {
      if (message.command !== "daemon.restart")
        return { ok: true, value: { version: "0.0.0", instanceId: "old" } };
      // A cooperative old daemon exits once it has agreed to restart.
      setTimeout(() => void fake.stop(), 5);
      return { ok: true, value: { restarting: true } };
    });
    const results = await Promise.all([
      gyst(cwd, ["session", "status"], undefined, ownData),
      gyst(cwd, ["session", "status"], undefined, ownData),
    ]);
    for (const result of results) expect(json(result)).toEqual(status);
    expect(await readFile(savedPath, "utf8")).toBe(saved);
    expect(fake.commands).toContain("daemon.restart");
    expect(
      fake.commands.every((command) => ["daemon.info", "daemon.restart"].includes(command)),
    ).toBe(true);
    succeeded(await gyst(cwd, ["session", "close"], undefined, ownData));
  }, 20_000);

  it("bounds recovery when an older daemon stays busy or never answers the handshake", async () => {
    const box = await sandbox();
    for (const mode of ["busy", "silent"] as const) {
      const ownData = await mkdtemp(join(box.root, `${mode}-upgrade-`));
      const fake = await fakeDaemon(ownData, (message) =>
        mode === "silent"
          ? undefined
          : {
              ok: true,
              value:
                message.command === "daemon.info"
                  ? { version: "0.0.0", instanceId: "busy" }
                  : { restarting: false },
            },
      );
      const started = performance.now();
      const error = failed(await box.gyst(box.root, ["session", "create"], undefined, ownData));
      expect(error.message).toContain(mode === "busy" ? "busy" : "timed out");
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(
        fake.commands.every((command) => ["daemon.info", "daemon.restart"].includes(command)),
      ).toBe(true);
    }
  }, 20_000);

  it("never retries a mutation when its reply is lost after a successful handshake", async () => {
    const box = await sandbox();
    const ownData = await mkdtemp(join(box.root, "lost-mutation-reply-"));
    const fake = await fakeDaemon(ownData, (message) =>
      message.command === "daemon.info"
        ? { ok: true, value: { version: daemonVersion, instanceId: "same" } }
        : null,
    );
    const error = failed(await box.gyst(box.root, ["session", "create"], undefined, ownData));
    expect(error.code).toBe("daemon_unreachable");
    expect(fake.commands.filter((command) => command !== "daemon.info")).toEqual(["create"]);
  }, 20_000);

  it("blocks legacy, newer and incompatible daemons before sending a mutation", async () => {
    const box = await sandbox();
    for (const mode of ["legacy", "newer", "incompatible"] as const) {
      const ownData = await mkdtemp(join(box.root, `${mode}-daemon-`));
      const saved = JSON.stringify({ id: "old", spotlight: [] });
      await writeFile(join(ownData, "old.json"), saved);
      const fake = await fakeDaemon(ownData, () => ({
        ok: true,
        value:
          mode === "legacy"
            ? { spotlight: [] }
            : { version: mode === "newer" ? "999.0.0" : "0.0.0", instanceId: mode },
      }));
      const error = failed(await box.gyst(box.root, ["session", "create"], undefined, ownData));
      expect(error.code).toBe("daemon_unreachable");
      expect(`${error.message} ${error.detail}`).toContain(
        mode === "legacy" ? "compatibility" : mode === "newer" ? "newer" : "incompatible",
      );
      expect(fake.commands).toEqual(["daemon.info"]);
      expect(await readFile(join(ownData, "old.json"), "utf8")).toBe(saved);
    }
  }, 20_000);

  it("rejects malformed success replies visibly", async () => {
    const box = await sandbox();
    const ownData = await mkdtemp(join(box.root, "mismatched-reply-"));
    await fakeDaemon(ownData, (message) => ({
      ok: true,
      value:
        message.command === "daemon.info"
          ? { version: daemonVersion, instanceId: "fake" }
          : { sessionId: "invalid", revision: 0 },
    }));
    const result = await box.gyst(box.root, ["session", "diff"], undefined, ownData);
    expect(failed(result)).toMatchObject({
      code: "daemon_unreachable",
      message: expect.stringContaining("invalid daemon reply"),
    });
    expect(result.stdout).toBe("");
  }, 20_000);
});
