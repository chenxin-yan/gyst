import {
  applyHumanAction,
  SessionSchema,
  SourceCheckPayloadSchema,
  StatusPayloadSchema,
  statusOf,
} from "@gyst/core";
import { Result, Schema } from "effect";
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
const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(SessionSchema));

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
  it("checks recorded scopes across restart without replacing snapshots", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "source-check");
    const nested = join(cwd, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "inside.txt"), "base\n");
    git(box, cwd, "add", ".");
    git(box, cwd, "commit", "-qm", "nested file");
    await writeFile(join(nested, "inside.txt"), "captured\n");
    const { session } = json(await gyst(nested, ["session", "open"]));
    const pinned = ["--session", session.id];
    const captured = json(await gyst(cwd, ["session", "status", ...pinned]));
    const savedPath = join(data, `${session.id}.json`);
    const saved = await readFile(savedPath, "utf8");
    const check = async (id: string) =>
      Schema.decodeUnknownSync(SourceCheckPayloadSchema)(
        json(await gyst(box.root, ["session", "check", "--session", id])),
      );
    expect((await check(session.id)).state).toBe("unchanged");
    await writeFile(join(nested, "inside.txt"), "changed after capture\n");
    await killDaemon(data);
    expect((await check(session.id)).state).toBe("changed");
    expect(json(await gyst(box.root, ["session", "status", ...pinned]))).toEqual(captured);
    expect(await readFile(savedPath, "utf8")).toBe(saved);
    succeeded(await gyst(box.root, ["session", "refresh", ...pinned]));
    expect((await check(session.id)).state).toBe("unchanged");
    // Uncommitted scope covers untracked files, from the repository root.
    await writeFile(join(cwd, "new-untracked.txt"), "new\n");
    const recaptured = json(await gyst(box.root, ["session", "refresh", ...pinned]));
    expect(recaptured.files.map(({ path }: { path: string }) => path)).toEqual([
      "nested/inside.txt",
      "new-untracked.txt",
    ]);

    // A committed range ignores the working tree; both scopes coexist.
    const range = json(await gyst(cwd, ["session", "open", "HEAD~1..HEAD"])).session;
    expect(range.scope).toEqual({ kind: "range", range: "HEAD~1..HEAD" });
    await writeFile(join(nested, "inside.txt"), "working tree is not the fixed range\n");
    expect((await check(range.id)).state).toBe("unchanged");
    for (const id of [session.id, range.id])
      succeeded(await gyst(cwd, ["session", "delete", "--session", id, "--request-id", id]));
  }, 20_000);

  it("maps open scopes and exact-id selectors from the command line", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "operands");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    git(box, cwd, "add", "other.txt");
    const failure = async (args: string[]) => failed(await gyst(cwd, ["session", ...args]));
    const opened = json(await gyst(cwd, ["session", "open"]));
    expect(opened.session.scope).toEqual({ kind: "uncommitted" });
    expect(opened.launch).toEqual({ argv: ["gyst", "--session", opened.session.id] });
    const range = json(await gyst(cwd, ["session", "open", "HEAD..HEAD"]));
    expect(range.session.scope).toEqual({ kind: "range", range: "HEAD..HEAD" });
    expect(json(await gyst(cwd, ["session", "open", "--session", range.session.id]))).toEqual(
      range.created ? { ...range, created: false } : range,
    );

    expect(await failure(["open", "HEAD"])).toMatchObject({
      code: "bad_args",
      message: "expected a Git range such as main...feature or main..feature",
    });
    expect(await failure(["open", "--", "--output=x..HEAD"])).toEqual({
      code: "bad_args",
      message: "session open takes at most one Git range",
    });
    expect(await failure(["open", "HEAD..HEAD", "--session", opened.session.id])).toEqual({
      code: "bad_args",
      message: "choose a Git range or --session, not both",
    });
    expect(await failure(["open", "--stdin"])).toMatchObject({ code: "bad_args" });
    expect(await failure(["status"])).toEqual({
      code: "bad_args",
      message: 'Missing required flag "--session"',
    });
    expect(await failure(["open", "HEAD..no-such-rev"])).toEqual({
      code: "bad_args",
      message: "unknown revision in range: no-such-rev",
    });

    const hunks = async (args: string[]) =>
      json(await gyst(box.root, ["session", "diff", ...args])).hunks.map(
        ({ file }: { file: string }) => file,
      );
    expect(await hunks(["--session", opened.session.id])).toEqual(["other.txt", "tracked.txt"]);
    expect(await hunks(["--session", opened.session.id, "--file", "other.txt"])).toEqual([
      "other.txt",
    ]);
    expect(await hunks(["--session", range.session.id])).toEqual([]);
    expect(
      await failure(["diff", "--session", opened.session.id, "--hunk", "x", "--file", "other.txt"]),
    ).toEqual({ code: "bad_args", message: "choose only one diff selector" });
    expect(await failure(["status", "--session", "missing"])).toEqual({
      code: "no_session",
      message: "no session with id missing",
    });
    for (const { session } of [opened, range])
      succeeded(
        await gyst(cwd, ["session", "delete", "--session", session.id, "--request-id", session.id]),
      );
  }, 20_000);

  it("passes inline string flag values that start with a dash to the operation unchanged", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "inline-flags");
    await writeFile(join(cwd, "-name.txt"), "dash\n");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    git(box, cwd, "add", "--", "-name.txt");
    const { session } = json(await gyst(cwd, ["session", "open"]));
    expect(failed(await gyst(cwd, ["session", "status", "--session=--missing"]))).toEqual({
      code: "no_session",
      message: "no session with id --missing",
    });
    const selected = json(
      await gyst(cwd, ["session", "diff", `--session=${session.id}`, "--file=-name.txt"]),
    );
    expect(selected.hunks.map(({ file }: { file: string }) => file)).toEqual(["-name.txt"]);
    succeeded(
      await gyst(cwd, ["session", "delete", `--session=${session.id}`, "--request-id=-cleanup"]),
    );
  }, 20_000);

  it("serializes concurrent startup and opens so one scope gets one session", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "concurrent-open");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");

    const results = (
      await Promise.all([gyst(cwd, ["session", "open"]), gyst(cwd, ["session", "open"])])
    ).map(json);
    expect(results[0].session).toEqual(results[1].session);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect((await readdir(data)).filter((file) => file.endsWith(".json"))).toEqual([
      `${results[0].session.id}.json`,
    ]);
    succeeded(
      await gyst(cwd, [
        "session",
        "delete",
        "--session",
        results[0].session.id,
        "--request-id",
        "cleanup",
      ]),
    );
  }, 20_000);

  it("reuses a range after its refs move without refreshing, beside other scopes", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "moving-range");
    git(box, cwd, "branch", "-M", "main");
    git(box, cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "feature.txt"), "feature\n");
    git(box, cwd, "add", ".");
    git(box, cwd, "commit", "-qm", "feature");
    await writeFile(join(cwd, "tracked.txt"), "uncommitted\n");
    const open = async (...args: string[]) => json(await gyst(cwd, ["session", "open", ...args]));
    const threeDot = await open("main...feature");
    const twoDot = await open("main..feature");
    const uncommitted = await open();
    // Equal resolved diffs, different recorded scopes: separate sessions.
    expect(twoDot.session.snapshotId).toBe(threeDot.session.snapshotId);
    expect(new Set([threeDot, twoDot, uncommitted].map(({ session }) => session.id)).size).toBe(3);
    const id = threeDot.session.id;
    const hunkId = json(await gyst(cwd, ["session", "status", "--session", id])).inbox[0].id;
    const prepared = json(
      await gyst(
        cwd,
        ["session", "apply", "--session", id],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "prepare",
          ops: [
            {
              type: "group.create",
              id: "feature",
              memberHunkIds: [hunkId],
              title: "Add the feature",
              notes: [{ hunkId, text: "Guidance that reopening must keep." }],
            },
            { type: "queue.set", itemIds: ["feature"] },
          ],
        }),
      ),
    );

    await writeFile(join(cwd, "tracked.txt"), "one\n");
    await writeFile(join(cwd, "feature.txt"), "feature moved\n");
    git(box, cwd, "commit", "-qam", "move feature");
    await killDaemon(data);
    // Reopened from another directory of the checkout, after a daemon restart.
    await mkdir(join(cwd, "elsewhere"));
    const reopened = json(
      await gyst(join(cwd, "elsewhere"), ["session", "open", "main...feature"]),
    );
    expect(reopened).toEqual({ ...threeDot, session: prepared.session, created: false });
    expect(reopened.session.snapshotId).toBe(threeDot.session.snapshotId);
    expect(json(await gyst(cwd, ["session", "status", "--session", id]))).toEqual(prepared);
    expect(json(await gyst(cwd, ["session", "check", "--session", id])).state).toBe("changed");
    const listed = json(await gyst(box.root, ["session", "list"])).sessions;
    expect(new Set(listed.map(({ id }: { id: string }) => id))).toEqual(
      new Set([threeDot, twoDot, uncommitted].map(({ session }) => session.id)),
    );
    for (const { session } of [threeDot, twoDot, uncommitted])
      succeeded(
        await gyst(cwd, ["session", "delete", "--session", session.id, "--request-id", session.id]),
      );
  }, 20_000);

  it("opens uncommitted snapshots, respawns from persistence, and shuts down after the last delete", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "bare");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");

    const { session } = json(await gyst(cwd, ["session", "open"]));
    const pinned = ["--session", session.id];
    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(
      json(await gyst(cwd, ["session", "status", ...pinned])),
    );
    expect(status.inbox.length).toBe(2);
    expect(status.session).toEqual(session);
    expect(status.session.scope).toEqual({ kind: "uncommitted" });
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
    const restoredStatus = json(await gyst(cwd, ["session", "status", ...pinned]));
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

    expect(json(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "last"]))).toEqual(
      { deleted: true, sessionId: status.session.id },
    );
    await waitFor(
      () => !isAlive(respawned) && !existsSync(join(data, "daemon.pid")),
      `daemon ${respawned} to exit after the last delete`,
    );
    expect((await readdir(data)).sort()).toEqual(["corrupt.json", "delete-receipts"]);
  }, 20_000);

  it("keeps failed persistence from exposing an opened or hiding a deleted session", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "persist-failure");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    expect(json(await gyst(cwd, ["session", "list"]))).toEqual({ sessions: [] });
    await chmod(data, 0o500);
    const failedOpen = await gyst(cwd, ["session", "open"]);
    await chmod(data, 0o700);
    expect(failed(failedOpen).code).toBe("daemon_unreachable");
    expect(json(await gyst(cwd, ["session", "list"]))).toEqual({ sessions: [] });

    const { session } = json(await gyst(cwd, ["session", "open"]));
    const saved = await readFile(join(data, `${session.id}.json`), "utf8");
    const remove = ["session", "delete", "--session", session.id, "--request-id", "remove"];
    await chmod(data, 0o500);
    const failedDelete = await gyst(cwd, remove);
    await chmod(data, 0o700);
    expect(failed(failedDelete).code).toBe("daemon_unreachable");
    expect(existsSync(join(data, "delete-receipts"))).toBe(false);
    expect(await readFile(join(data, `${session.id}.json`), "utf8")).toBe(saved);
    expect(json(await gyst(cwd, ["session", "status", "--session", session.id])).session).toEqual(
      session,
    );
    // Retrying the unrecorded request performs the deletion.
    expect(json(await gyst(cwd, remove))).toEqual({ deleted: true, sessionId: session.id });
  }, 20_000);

  it("replays deletions after restart and file removal, and protects other sessions", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "delete-replay");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const doomed = json(await gyst(cwd, ["session", "open"])).session;
    const kept = json(await gyst(cwd, ["session", "open", "HEAD..HEAD"])).session;
    const keptFile = await readFile(join(data, `${kept.id}.json`), "utf8");
    const remove = (id: string, requestId: string) =>
      gyst(box.root, ["session", "delete", "--session", id, "--request-id", requestId]);
    const deleted = json(await remove(doomed.id, "delete-doomed"));
    expect(deleted).toEqual({ deleted: true, sessionId: doomed.id });
    expect(existsSync(join(data, `${doomed.id}.json`))).toBe(false);

    await killDaemon(data);
    // A lost acknowledgement retried against a fresh daemon: same answer, nothing else touched.
    expect(json(await remove(doomed.id, "delete-doomed"))).toEqual(deleted);
    expect(failed(await remove(kept.id, "delete-doomed"))).toMatchObject({
      code: "validation_failed",
      message: "request id reused with a different payload",
    });
    expect(failed(await remove(doomed.id, "another-request")).code).toBe("no_session");
    expect(failed(await gyst(box.root, ["session", "open", "--session", doomed.id])).code).toBe(
      "no_session",
    );
    expect(await readFile(join(data, `${kept.id}.json`), "utf8")).toBe(keptFile);
    expect(json(await gyst(box.root, ["session", "list"])).sessions).toEqual([kept]);
    // Reopening the deleted scope is a new session, not the deleted one.
    const reopened = json(await gyst(cwd, ["session", "open"]));
    expect(reopened.created).toBe(true);
    expect(reopened.session.id).not.toBe(doomed.id);
    for (const { id } of [kept, reopened.session]) succeeded(await remove(id, `cleanup-${id}`));
  }, 20_000);

  it("keeps a replacement session alive during final-session shutdown", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const first = await repo(box, "shutdown-first");
    const replacement = await repo(box, "shutdown-replacement");
    await writeFile(join(first, "tracked.txt"), "first changed\n");
    await writeFile(join(replacement, "tracked.txt"), "replacement changed\n");
    const { session } = json(await gyst(first, ["session", "open"]));

    // Independent processes: the replacement may reach the first daemon or, after its idle exit, a
    // new one. Either way a daemon must keep serving it. server.test.ts pins the overlapping order.
    const [deleted, opened] = await Promise.all([
      gyst(first, ["session", "delete", "--session", session.id, "--request-id", "first"]),
      gyst(replacement, ["session", "open"]),
    ]);
    succeeded(deleted);
    const pinned = ["--session", json(opened).session.id];
    // Wait past the 20 ms idle debounce so a wrongful idle exit is likely to show; this cannot
    // prove its absence.
    await sleep(100);
    const pid = await daemonPid(data);
    expect(isAlive(pid)).toBe(true);
    succeeded(await gyst(replacement, ["session", "status", ...pinned]));
    // Served by that daemon, not a respawn from persistence.
    expect(await daemonPid(data)).toBe(pid);
    succeeded(await gyst(replacement, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("preserves split UTF-8 input at the socket boundary", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "utf8-café");
    await writeFile(join(cwd, "tracked.txt"), "café\n");
    // Start the daemon without opening a session, then write one request in deliberately split byte chunks.
    expect(json(await gyst(cwd, ["session", "list"]))).toEqual({ sessions: [] });
    const hello = JSON.parse(await socketRequest(data, { command: "daemon.info" }));
    const request = new TextEncoder().encode(
      `${JSON.stringify({ ...hello.value, request: { command: "open", cwd, scope: { kind: "uncommitted" } } })}\n`,
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
    const opened = JSON.parse(reply);
    expect(opened.value.session.repoRoot).toBe(cwd);
    const pinned = ["--session", opened.value.session.id];
    const diff = json(await gyst(cwd, ["session", "diff", ...pinned]));
    expect(diff.hunks[0].patch).toContain("café");
    succeeded(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("moves large requests and replies through the socket completely", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "large");
    const line = "x".repeat(2_000_000);
    await writeFile(join(cwd, "tracked.txt"), `${line}\n`);
    const { session } = json(await gyst(cwd, ["session", "open"]));
    const pinned = ["--session", session.id];
    const diff = json(await gyst(cwd, ["session", "diff", ...pinned]));
    expect(diff.hunks[0].patch.endsWith(line)).toBe(true);
    // Trailing whitespace is valid JSON: a 2 MB batch that must arrive whole to validate.
    const batch = `${JSON.stringify({ revision: 0, idempotencyKey: "large", ops: [] })}${" ".repeat(2_000_000)}`;
    expect(json(await gyst(cwd, ["session", "apply", ...pinned], batch)).revision).toBe(1);
    succeeded(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("reclaims a dead daemon's socket under concurrent starts", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "reclaim");
    expect(json(await gyst(cwd, ["session", "list"]))).toEqual({ sessions: [] });
    const pid = await killDaemon(data);
    expect(await readdir(data)).toContain("daemon.sock");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => gyst(cwd, ["session", "list"])),
    );
    expect(results.map(json)).toEqual(Array.from({ length: 4 }, () => ({ sessions: [] })));
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
    const { session } = json(await gyst(cwd, ["session", "open"]));
    const pinned = ["--session", session.id];
    const created = json(await gyst(cwd, ["session", "status", ...pinned]));
    const [first, second] = created.inbox;

    const invalidError = failed(
      await gyst(
        cwd,
        ["session", "apply", ...pinned],
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
    expect(json(await gyst(cwd, ["session", "status", ...pinned])).groups).toEqual([]);

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
      json(await gyst(cwd, ["session", "apply", ...pinned], JSON.stringify(envelope))),
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
        ["session", "apply", ...pinned],
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
    expect(
      json(await gyst(cwd, ["session", "apply", ...pinned], JSON.stringify(envelope))),
    ).toEqual(status);
    expect(json(await gyst(cwd, ["session", "status", ...pinned])).revision).toBe(2);

    const dissolved = json(
      await gyst(
        cwd,
        ["session", "apply", ...pinned],
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
    succeeded(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("serializes concurrent mutations so revision checks prevent lost updates", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "concurrent-apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    const { session } = json(await gyst(cwd, ["session", "open"]));
    const pinned = ["--session", session.id];
    const hunkId = json(await gyst(cwd, ["session", "status", ...pinned])).inbox[0].id;
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
      gyst(cwd, ["session", "apply", ...pinned], batch("concurrent-a", "first")),
      gyst(cwd, ["session", "apply", ...pinned], batch("concurrent-b", "second")),
    ]);

    expect(results.map(({ exitCode }) => exitCode).sort((a, b) => a! - b!)).toEqual([0, 1]);
    expect(failed(results.find(({ exitCode }) => exitCode === 1)!).code).toBe("stale_revision");
    expect(json(await gyst(cwd, ["session", "status", ...pinned])).revision).toBe(1);
    succeeded(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("refreshes the recorded scope while preserving only unchanged review work", async () => {
    const box = await sandbox();
    const { data, gyst } = box;
    const cwd = await repo(box, "refresh");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "second.txt"), "base\n");
    git(box, cwd, "add", ".");
    git(box, cwd, "commit", "-qm", "add second");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\nthree\n");
    await writeFile(join(cwd, "second.txt"), "base\nfirst change\n");
    const { session } = json(await gyst(cwd, ["session", "open"]));
    const pinned = ["--session", session.id];
    const created = json(await gyst(cwd, ["session", "status", ...pinned]));
    const first = created.inbox.find((hunk: { file: string }) => hunk.file === "tracked.txt");
    const second = created.inbox.find((hunk: { file: string }) => hunk.file === "second.txt");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const applied = json(
      await gyst(
        cwd,
        ["session", "apply", ...pinned],
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
    const refreshed = json(await gyst(cwd, ["session", "refresh", ...pinned]));
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
        ["session", "apply", ...pinned],
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
    succeeded(await gyst(cwd, ["session", "delete", ...pinned, "--request-id", "cleanup"]));
  }, 20_000);

  it("skips undecodable saved sessions without reserving their scope or modifying their files", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "legacy");
    const ownData = await mkdtemp(join(box.root, "legacy-data-"));
    const path = join(ownData, "legacy.json");
    const content = JSON.stringify({ id: "legacy", repoRoot: cwd, groups: [{ tldr: "old" }] });
    await writeFile(path, content);
    for (const args of [
      ["status", "--session", "legacy"],
      ["open", "--session", "legacy"],
      ["delete", "--session", "legacy", "--request-id", "legacy"],
    ])
      expect(failed(await gyst(cwd, ["session", ...args], undefined, ownData)).code).toBe(
        "no_session",
      );
    expect(json(await gyst(cwd, ["session", "list"], undefined, ownData))).toEqual({
      sessions: [],
    });
    const { session } = json(await gyst(cwd, ["session", "open"], undefined, ownData));
    expect(await readFile(path, "utf8")).toBe(content);
    succeeded(
      await gyst(
        cwd,
        ["session", "delete", "--session", session.id, "--request-id", "cleanup"],
        undefined,
        ownData,
      ),
    );
    expect(await readFile(path, "utf8")).toBe(content);
  }, 20_000);

  it("automatically replaces an older cooperative daemon without changing saved review state", async () => {
    const box = await sandbox();
    const { gyst } = box;
    const cwd = await repo(box, "automatic-upgrade");
    const ownData = await mkdtemp(join(box.root, "automatic-upgrade-data-"));
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const { session: opened } = json(await gyst(cwd, ["session", "open"], undefined, ownData));
    const pinned = ["--session", opened.id];
    const hunkId = json(await gyst(cwd, ["session", "status", ...pinned], undefined, ownData))
      .inbox[0].id;
    const published = json(
      await gyst(
        cwd,
        ["session", "apply", ...pinned],
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
    const savedPath = join(ownData, `${published.session.id}.json`);
    await killDaemon(ownData, "SIGTERM");
    expect(existsSync(join(ownData, "daemon.pid"))).toBe(false);
    // No command records human work any more: accept the group with the pure reducer and save it
    // as the store does, so the upgrade must carry a non-default verdict and accept history.
    const session = decodeSession(await readFile(savedPath, "utf8"));
    const reviewed = Result.getOrThrow(
      applyHumanAction(
        session,
        { type: "verdict.toggle", itemId: "group", sessionId: session.id, revision: 1 },
        new Date().toISOString(),
      ),
    );
    const status = statusOf(reviewed);
    expect(status.groups[0]!.accepted).toBe(true);
    const saved = `${JSON.stringify(reviewed)}\n`;
    await writeFile(savedPath, saved);
    const fake = await fakeDaemon(ownData, (message) => {
      if (message.command !== "daemon.restart")
        return { ok: true, value: { version: "0.0.0", instanceId: "old" } };
      // A cooperative old daemon exits once it has agreed to restart.
      setTimeout(() => void fake.stop(), 5);
      return { ok: true, value: { restarting: true } };
    });
    const results = await Promise.all([
      gyst(cwd, ["session", "status", ...pinned], undefined, ownData),
      gyst(cwd, ["session", "status", ...pinned], undefined, ownData),
    ]);
    for (const result of results) expect(json(result)).toEqual(status);
    expect(await readFile(savedPath, "utf8")).toBe(saved);
    expect(fake.commands).toContain("daemon.restart");
    expect(
      fake.commands.every((command) => ["daemon.info", "daemon.restart"].includes(command)),
    ).toBe(true);
    succeeded(
      await gyst(
        cwd,
        ["session", "delete", ...pinned, "--request-id", "cleanup"],
        undefined,
        ownData,
      ),
    );
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
      const error = failed(await box.gyst(box.root, ["session", "open"], undefined, ownData));
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
    const error = failed(await box.gyst(box.root, ["session", "open"], undefined, ownData));
    expect(error.code).toBe("daemon_unreachable");
    expect(fake.commands.filter((command) => command !== "daemon.info")).toEqual(["open"]);
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
      const error = failed(await box.gyst(box.root, ["session", "open"], undefined, ownData));
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
    const result = await box.gyst(
      box.root,
      ["session", "diff", "--session", "x"],
      undefined,
      ownData,
    );
    expect(failed(result)).toMatchObject({
      code: "daemon_unreachable",
      message: expect.stringContaining("invalid daemon reply"),
    });
    expect(result.stdout).toBe("");
  }, 20_000);
});
