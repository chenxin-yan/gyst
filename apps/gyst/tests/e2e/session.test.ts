import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatusPayloadSchema } from "@gyst/core";
import { Schema } from "effect";

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
    expect(status.session.source).toEqual({ kind: "git", args: ["HEAD"], cwd });
    const hunkId = status.inbox[0]!.id;

    const pid = await daemonPid();
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    // #17 will author groups and tldrs through apply; seed persisted state here to exercise this ticket's reads.
    const statePath = join(data, `${status.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups = [
      { id: "group-1", tldr: "same edit", exemplarHunkId: hunkId, hunkIds: [hunkId] },
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
