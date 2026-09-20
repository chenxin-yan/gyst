import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { StatusPayloadSchema } from "@gyst/core";
import { ConfigProvider, Layer, ManagedRuntime, Schema } from "effect";
import { DaemonClient } from "../daemon/client.ts";
import { Paths } from "../daemon/paths.ts";
import { daemonTuiClient } from "../tui/client.ts";

const binary = join(tmpdir(), `gyst-e2e-${process.pid}`);
let root: string;
let data: string;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

async function repo(name: string): Promise<string> {
  const cwd = join(root, name);
  await Bun.$`mkdir -p ${cwd}`.quiet();
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@gyst.invalid");
  git(cwd, "config", "user.name", "Gyst Test");
  await writeFile(join(cwd, "tracked.txt"), "one\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  return cwd;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Result = { exitCode: number; stdout: string; stderr: string };
async function gyst(cwd: string, args: string[], stdin?: string): Promise<Result> {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: { ...process.env, GYST_DATA_DIR: data },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

const daemonPid = () => readFile(join(data, "daemon.pid"), "utf8").then(Number, () => Number.NaN);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gyst-e2e-"));
  data = join(root, "data");
  const built = Bun.spawnSync(
    ["bun", "build", "--compile", "--minify", "--outfile", binary, "src/index.tsx"],
    {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
});

afterAll(async () => {
  try {
    process.kill(await daemonPid(), "SIGTERM");
  } catch {}
  await rm(root, { recursive: true, force: true });
  await rm(binary, { force: true });
});

describe("gyst session CLI seam", () => {
  it("serializes concurrent startup and create for one repository", async () => {
    const cwd = await repo("concurrent-create");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");

    const results = await Promise.all([
      gyst(cwd, ["session", "create"]),
      gyst(cwd, ["session", "create"]),
    ]);
    expect(results.map(({ exitCode }) => exitCode).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(JSON.parse(results.find(({ exitCode }) => exitCode === 1)!.stderr).code).toBe(
      "session_exists",
    );
    const status = JSON.parse((await gyst(cwd, ["session", "status"])).stdout);
    expect((await readdir(data)).filter((file) => file.endsWith(".json"))).toEqual([
      `${status.session.id}.json`,
    ]);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("creates bare snapshots, respawns from persistence, and shuts down after the last close", async () => {
    const cwd = await repo("bare");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");

    const created = await gyst(cwd, ["session", "create"]);
    expect(created.exitCode).toBe(0);
    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(JSON.parse(created.stdout));
    expect(status.inbox.length).toBe(2);
    expect(status.session.source).toEqual({
      kind: "git",
      args: ["HEAD"],
      cwd,
      includeUntracked: true,
    });
    const hunkId = status.inbox[0]!.id;

    const pid = await daemonPid();
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    // Seed review state on disk: the respawned daemon must serve it, not the pre-kill snapshot.
    const statePath = join(data, `${status.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups = [
      {
        id: "group-1",
        tldr: "same edit",
        exemplarHunkId: hunkId,
        hunkIds: [hunkId],
        accepted: false,
      },
    ];
    const spotlightHunk = state.hunks.find((hunk: { id: string }) => hunk.id !== hunkId);
    spotlightHunk.tldr = "needs human review";
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(data, "corrupt.json"), "not json");
    const restored = await gyst(cwd, ["session", "status"]);
    expect(restored.exitCode).toBe(0);
    const restoredStatus = JSON.parse(restored.stdout);
    expect(restoredStatus.session.id).toBe(status.session.id);
    expect(restoredStatus.groups[0].count).toBe(1);
    expect(restoredStatus.spotlight).toEqual([
      {
        id: spotlightHunk.id,
        file: spotlightHunk.file,
        tldr: "needs human review",
        accepted: false,
      },
    ]);
    expect(restoredStatus.inbox).toEqual([]);
    expect(await daemonPid()).not.toBe(pid);

    const closed = await gyst(cwd, ["session", "close"]);
    expect(JSON.parse(closed.stdout)).toEqual({ closed: true, sessionId: status.session.id });
    for (
      let attempt = 0;
      attempt < 50 && (await Bun.file(join(data, "daemon.pid")).exists());
      attempt++
    )
      await Bun.sleep(20);
    expect(await readdir(data)).toEqual(["corrupt.json"]);
    await rm(join(data, "corrupt.json"));
  }, 20_000);

  it("keeps failed persistence from exposing a session", async () => {
    const cwd = await repo("persist-failure");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    expect((await gyst(cwd, ["session", "status"])).exitCode).toBe(1);
    await chmod(data, 0o500);
    const failed = await gyst(cwd, ["session", "create"]);
    await chmod(data, 0o700);
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stderr).code).toBe("daemon_unreachable");

    const retried = await gyst(cwd, ["session", "create"]);
    expect(retried.exitCode).toBe(0);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("keeps a replacement session alive during final-session shutdown", async () => {
    const first = await repo("shutdown-first");
    const replacement = await repo("shutdown-replacement");
    await writeFile(join(first, "tracked.txt"), "first changed\n");
    await writeFile(join(replacement, "tracked.txt"), "replacement changed\n");
    expect((await gyst(first, ["session", "create"])).exitCode).toBe(0);

    const [closed, created] = await Promise.all([
      gyst(first, ["session", "close"]),
      gyst(replacement, ["session", "create"]),
    ]);
    expect(closed.exitCode).toBe(0);
    expect(created.exitCode).toBe(0);
    await Bun.sleep(50);
    expect((await gyst(replacement, ["session", "status"])).exitCode).toBe(0);
    await gyst(replacement, ["session", "close"]);
  }, 20_000);

  it("preserves split UTF-8 input at the socket boundary", async () => {
    const cwd = await repo("utf8-socket");
    // Start the daemon without creating a session, then write one request in deliberately split byte chunks.
    expect((await gyst(cwd, ["session", "status"])).exitCode).toBe(1);
    const patch = `diff --git a/tracked.txt b/tracked.txt
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-one
+café
`;
    const request = new TextEncoder().encode(
      `${JSON.stringify({ command: "create", cwd, args: ["--stdin"], stdin: patch })}\n`,
    );
    const marker = new TextEncoder().encode("é");
    const markerStart = request.findIndex(
      (byte, index) => byte === marker[0] && request[index + 1] === marker[1],
    );
    expect(markerStart).toBeGreaterThan(0);
    const reply = await new Promise<string>((resolve, reject) => {
      let response = "";
      const decoder = new TextDecoder();
      void Bun.connect({
        unix: join(data, "daemon.sock"),
        socket: {
          open(socket) {
            socket.write(request.slice(0, markerStart + 1));
            setTimeout(() => socket.write(request.slice(markerStart + 1)), 5);
          },
          data(_socket, bytes) {
            response += decoder.decode(bytes, { stream: true });
            if (response.includes("\n")) resolve(response);
          },
          error(_socket, error) {
            reject(error);
          },
        },
      }).catch(reject);
    });
    expect(JSON.parse(reply).ok).toBe(true);
    const diff = JSON.parse((await gyst(cwd, ["session", "diff"])).stdout);
    expect(diff.hunks[0].patch).toContain("café");
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("moves large requests and replies through the socket completely", async () => {
    const cwd = await repo("large");
    const line = "x".repeat(2_000_000);
    const patch = `diff --git a/tracked.txt b/tracked.txt
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-one
+${line}
`;
    const created = await gyst(cwd, ["session", "create", "--stdin"], patch);
    expect(created.exitCode).toBe(0);
    const diff = JSON.parse((await gyst(cwd, ["session", "diff"])).stdout);
    expect(diff.hunks[0].patch.endsWith(line)).toBe(true);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("reclaims a dead daemon's socket under concurrent starts", async () => {
    const cwd = await repo("reclaim");
    expect((await gyst(cwd, ["session", "status"])).exitCode).toBe(1);
    const pid = await daemonPid();
    process.kill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 50 && isAlive(pid); attempt++) await Bun.sleep(10);
    expect(await readdir(data)).toContain("daemon.sock");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => gyst(cwd, ["session", "status"])),
    );
    expect(results.map(({ stderr }) => JSON.parse(stderr).code)).toEqual(
      Array(4).fill("no_session"),
    );
    const daemons = () =>
      Bun.spawnSync(["pgrep", "-f", `^${binary} daemon run`], { stdout: "pipe" })
        .stdout.toString()
        .trim()
        .split("\n");
    // Losers of the rename race notice within their 1 s inode check and exit.
    for (let attempt = 0; attempt < 60 && daemons().length > 1; attempt++) await Bun.sleep(50);
    const survivor = daemons()[0] ?? "";
    expect(daemons()).toEqual([survivor]);
    expect(Number(survivor)).not.toBe(pid);
    expect(isAlive(Number(survivor))).toBe(true);
    // The pid file may briefly name a loser; the owner rewrites it on its next inode check.
    for (let attempt = 0; attempt < 40 && (await daemonPid()) !== Number(survivor); attempt++)
      await Bun.sleep(50);
    const survivorPid = await daemonPid();
    expect(survivorPid).toBe(Number(survivor));
    expect(daemons()).toEqual([String(survivorPid)]);
    expect((await readdir(data)).sort()).toEqual(["daemon.pid", "daemon.sock"]);
  }, 20_000);

  it("exits 130 on SIGINT through crust's cancellation and releases the socket and pid file", async () => {
    const ownData = join(root, "sigint-data");
    const daemon = Bun.spawn([binary, "daemon", "run"], {
      cwd: root,
      env: { ...process.env, GYST_DATA_DIR: ownData },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    while (!(await readdir(ownData).catch((): string[] => [])).includes("daemon.pid")) {
      await Bun.sleep(20);
    }
    daemon.kill("SIGINT");
    const [exitCode, stderr] = await Promise.all([
      daemon.exited,
      new Response(daemon.stderr).text(),
    ]);
    expect(exitCode).toBe(130);
    expect(stderr).toBe("");
    expect(await readdir(ownData)).toEqual([]);
  }, 20_000);

  it("applies batches atomically and replays receipts across a daemon restart", async () => {
    const cwd = await repo("apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    const created = JSON.parse((await gyst(cwd, ["session", "create"])).stdout);
    const [first, second] = created.inbox;

    const invalid = await gyst(
      cwd,
      ["session", "apply"],
      JSON.stringify({
        revision: 0,
        idempotencyKey: "invalid-batch",
        ops: [
          {
            type: "group.create",
            id: "group-1",
            tldr: "mechanical",
            memberHunkIds: [first.id],
            exemplarHunkId: first.id,
          },
          { type: "hunk.annotate", hunkId: "missing", tldr: "nope" },
        ],
      }),
    );
    expect(invalid.exitCode).toBe(1);
    const invalidError = JSON.parse(invalid.stderr);
    expect(invalidError.code).toBe("validation_failed");
    expect(invalidError.detail).toEqual([expect.objectContaining({ opIndex: 1 })]);
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout).groups).toEqual([]);

    const envelope = {
      revision: 0,
      idempotencyKey: "pre-pass",
      ops: [
        {
          type: "group.create",
          id: "group-1",
          tldr: "mechanical",
          memberHunkIds: [first.id],
          exemplarHunkId: first.id,
        },
        { type: "hunk.annotate", hunkId: second.id, tldr: "read this" },
        { type: "queue.set", itemIds: [second.id, "group-1"] },
      ],
    };
    const applied = await gyst(cwd, ["session", "apply"], JSON.stringify(envelope));
    expect(applied.exitCode).toBe(0);
    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(JSON.parse(applied.stdout));
    expect(status.revision).toBe(1);
    expect(status.groups).toHaveLength(1);
    expect(status.spotlight).toHaveLength(1);
    expect(status.inbox).toEqual([]);
    expect(status.queue).toEqual([second.id, "group-1"]);
    expect(status.queueSet).toBe(true);
    expect(status.ready).toBe(true);

    const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    const statePath = join(data, `${status.session.id}.json`);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    persisted.cursor = { itemId: "group-1", expanded: true };
    await writeFile(statePath, JSON.stringify(persisted));

    const changed = await gyst(
      cwd,
      ["session", "apply"],
      JSON.stringify({
        revision: 1,
        idempotencyKey: "change",
        ops: [{ type: "hunk.annotate", hunkId: second.id, tldr: "updated" }],
      }),
    );
    expect(JSON.parse(changed.stdout).revision).toBe(2);
    const replay = await gyst(cwd, ["session", "apply"], JSON.stringify(envelope));
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(status);
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout).revision).toBe(2);

    const dissolved = await gyst(
      cwd,
      ["session", "apply"],
      JSON.stringify({
        revision: 2,
        idempotencyKey: "dissolve",
        ops: [
          { type: "group.dissolve", id: "group-1" },
          { type: "queue.set", itemIds: [second.id] },
        ],
      }),
    );
    expect(dissolved.exitCode).toBe(0);
    expect(JSON.parse(dissolved.stdout)).toEqual(
      expect.objectContaining({
        groups: [],
        queue: [second.id],
        queueSet: true,
        ready: false,
        cursor: { itemId: null, expanded: false },
      }),
    );
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("serializes concurrent mutations so revision checks prevent lost updates", async () => {
    const cwd = await repo("concurrent-apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    const created = JSON.parse((await gyst(cwd, ["session", "create"])).stdout);
    const hunkId = created.inbox[0].id;

    const results = await Promise.all([
      gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "concurrent-a",
          ops: [{ type: "hunk.annotate", hunkId, tldr: "first" }],
        }),
      ),
      gyst(
        cwd,
        ["session", "apply"],
        JSON.stringify({
          revision: 0,
          idempotencyKey: "concurrent-b",
          ops: [{ type: "hunk.annotate", hunkId, tldr: "second" }],
        }),
      ),
    ]);

    expect(results.map(({ exitCode }) => exitCode).sort((a, b) => a - b)).toEqual([0, 1]);
    const rejected = results.find(({ exitCode }) => exitCode === 1)!;
    expect(JSON.parse(rejected.stderr).code).toBe("stale_revision");
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout).revision).toBe(1);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("refreshes git and stdin snapshots while preserving only unchanged review work", async () => {
    const cwd = await repo("refresh");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "second.txt"), "base\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "add second");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\nthree\n");
    await writeFile(join(cwd, "second.txt"), "base\nfirst change\n");
    const created = JSON.parse((await gyst(cwd, ["session", "create"])).stdout);
    const first = created.inbox.find((hunk: { file: string }) => hunk.file === "tracked.txt");
    const second = created.inbox.find((hunk: { file: string }) => hunk.file === "second.txt");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const applied = JSON.parse(
      (
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
                tldr: "stable group",
                memberHunkIds: [first.id],
                exemplarHunkId: first.id,
              },
              { type: "hunk.annotate", hunkId: second.id, tldr: "stale spotlight" },
              { type: "queue.set", itemIds: ["group-1", second.id] },
            ],
          }),
        )
      ).stdout,
    );

    const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    const statePath = join(data, `${applied.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups[0].accepted = true;
    await writeFile(statePath, JSON.stringify(state));

    await writeFile(join(cwd, "second.txt"), "base\nreplacement change\n");
    await writeFile(join(cwd, "new.txt"), "brand new\n");
    const refresh = await gyst(cwd, ["session", "refresh"]);
    expect(refresh.exitCode).toBe(0);
    const refreshed = JSON.parse(refresh.stdout);
    expect(refreshed.groups[0]).toEqual(
      expect.objectContaining({ id: "group-1", accepted: true, hunkIds: [first.id] }),
    );
    expect(refreshed.spotlight).toEqual([]);
    expect(refreshed.inbox).toHaveLength(2);
    expect(refreshed.queue).toEqual([
      "group-1",
      ...refreshed.inbox.map((hunk: { id: string }) => hunk.id),
    ]);
    expect(refreshed.queueSet).toBe(false);
    expect(refreshed.ready).toBe(false);

    const updated = await gyst(
      cwd,
      ["session", "apply"],
      JSON.stringify({
        revision: refreshed.revision,
        idempotencyKey: "update-group",
        ops: [
          { type: "group.update", id: "group-1", tldr: "updated group" },
          { type: "queue.set", itemIds: ["group-1"] },
        ],
      }),
    );
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout).groups[0].accepted).toBe(false);
    await gyst(cwd, ["session", "close"]);

    const stdinRepo = await repo("refresh-stdin");
    const firstPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const secondPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+newer\n`;
    const stdinCreated = JSON.parse(
      (await gyst(stdinRepo, ["session", "create", "--stdin"], firstPatch)).stdout,
    );
    const withoutPipe = await gyst(stdinRepo, ["session", "refresh"]);
    expect(withoutPipe.exitCode).toBe(1);
    expect(JSON.parse(withoutPipe.stderr).code).toBe("bad_args");
    const stdinRefresh = await gyst(stdinRepo, ["session", "refresh", "--stdin"], secondPatch);
    expect(stdinRefresh.exitCode).toBe(0);
    expect(JSON.parse(stdinRefresh.stdout).inbox[0].id).not.toBe(stdinCreated.inbox[0].id);
    await gyst(stdinRepo, ["session", "close"]);
  }, 20_000);

  it("persists human cursor, expand state, and verdicts through the daemon", async () => {
    const cwd = await repo("human-actions");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    const created = JSON.parse((await gyst(cwd, ["session", "create"])).stdout);
    const [first, second] = created.inbox;
    // The TUI's runtime, pointed at this test's data dir; the daemon is already up, so nothing spawns.
    await using runtime = ManagedRuntime.make(
      DaemonClient.layer.pipe(
        Layer.provide(Paths.layer),
        Layer.provide(BunServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: data }))),
      ),
    );
    const client = daemonTuiClient(runtime, cwd);
    const frame = (revision: number) => ({ sessionId: created.session.id, revision });
    await expect(
      client.action({ type: "verdict.toggle", itemId: first.id, ...frame(0) }),
    ).rejects.toThrow("review queue is not set");
    await gyst(
      cwd,
      ["session", "apply"],
      JSON.stringify({
        revision: 0,
        idempotencyKey: "human-session",
        ops: [
          {
            type: "group.create",
            id: "group-1",
            tldr: "mechanical",
            memberHunkIds: [first.id],
            exemplarHunkId: first.id,
          },
          { type: "hunk.annotate", hunkId: second.id, tldr: "read this" },
          { type: "queue.set", itemIds: ["group-1", second.id] },
        ],
      }),
    );

    await expect(client.action({ type: "verdict.undo", ...frame(1) })).rejects.toThrow(
      "TUI action does not apply",
    );
    await client.action({ type: "cursor.move", itemId: "group-1" });
    await client.action({ type: "expand.toggle" });
    // The frame the human saw is stale once the pre-pass moved the revision on.
    await expect(
      client.action({ type: "verdict.toggle", itemId: "group-1", ...frame(0) }),
    ).rejects.toThrow("verdict targets a stale snapshot");
    const accepted = await client.action({
      type: "verdict.toggle",
      itemId: "group-1",
      ...frame(1),
    });
    expect(accepted.cursor).toEqual({ itemId: "group-1", expanded: true });
    expect(accepted.groups[0]!.accepted).toBe(true);
    expect(accepted.revision).toBe(2);
    expect(accepted.seq).toBe(4);
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout)).toEqual(accepted);

    const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    const restored = JSON.parse((await gyst(cwd, ["session", "status"])).stdout);
    expect(restored.cursor).toEqual({ itemId: "group-1", expanded: true });
    expect(restored.groups[0]!.accepted).toBe(true);
    const undone = await client.action({ type: "verdict.undo", ...frame(2) });
    expect(undone.cursor).toEqual({ itemId: "group-1", expanded: false });
    expect(undone.groups[0]!.accepted).toBe(false);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("starts the daemon when run from source under bun", async () => {
    const sourceData = join(root, "source-data");
    // From apps/gyst, as `bun run dev` is: bunfig.toml supplies the JSX preload.
    const child = Bun.spawn(["bun", "src/index.tsx", "session", "status"], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, GYST_DATA_DIR: sourceData },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).code).toBe("no_session");
    process.kill(Number(await readFile(join(sourceData, "daemon.pid"), "utf8")), "SIGTERM");
  }, 20_000);
});
