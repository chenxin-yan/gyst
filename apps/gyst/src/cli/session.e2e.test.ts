import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorPayloadSchema, StatusPayloadSchema } from "@gyst/core";
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gyst-e2e-"));
  data = join(root, "data");
  const built = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--outfile", binary, "src/index.tsx"], {
    cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
});

afterAll(async () => {
  try {
    const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGTERM");
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
    expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 1]);
    expect(JSON.parse(results.find(({ exitCode }) => exitCode === 1)!.stderr).code).toBe("session_exists");
    const status = JSON.parse((await gyst(cwd, ["session", "status"])).stdout);
    expect((await readdir(data)).filter((file) => file.endsWith(".json"))).toEqual([`${status.session.id}.json`]);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("creates the default scope in a repository without HEAD", async () => {
    const cwd = join(root, "unborn");
    await Bun.$`mkdir -p ${cwd}`.quiet();
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");

    const created = await gyst(cwd, ["session", "create"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).inbox).toHaveLength(2);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("creates bare snapshots, respawns from persistence, selects diffs, and closes", async () => {
    const cwd = await repo("bare");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");

    const created = await gyst(cwd, ["session", "create"]);
    expect(created.exitCode).toBe(0);
    const status = Schema.decodeUnknownSync(StatusPayloadSchema)(JSON.parse(created.stdout));
    expect(status.inbox.length).toBe(2);
    expect(created.stdout).not.toContain("+two");
    const hunkId = status.inbox[0]!.id;

    const oneHunk = await gyst(cwd, ["session", "diff", "--hunk", hunkId]);
    expect(oneHunk.exitCode).toBe(0);
    const hunkPayload = JSON.parse(oneHunk.stdout);
    expect(hunkPayload.hunks).toHaveLength(1);
    expect(hunkPayload.hunks[0].patch).toContain("@@");
    const filePayload = JSON.parse((await gyst(cwd, ["session", "diff", "--file", status.inbox[0]!.file])).stdout);
    expect(filePayload.hunks.every((hunk: { file: string }) => hunk.file === status.inbox[0]!.file)).toBe(true);
    expect(JSON.parse((await gyst(cwd, ["session", "diff"])).stdout).hunks).toHaveLength(2);

    const duplicate = await gyst(cwd, ["session", "create"]);
    expect(duplicate.exitCode).toBe(1);
    expect(Schema.decodeUnknownSync(ErrorPayloadSchema)(JSON.parse(duplicate.stderr)).code).toBe("session_exists");

    const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    await Bun.sleep(50);
    // #17 will author groups and tldrs through apply; seed persisted state here to exercise this ticket's reads.
    const statePath = join(data, `${status.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups = [{ id: "group-1", tldr: "same edit", exemplarHunkId: hunkId, hunkIds: [hunkId], accepted: false }];
    const spotlightHunk = state.hunks.find((hunk: { id: string }) => hunk.id !== hunkId);
    spotlightHunk.tldr = "needs human review";
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(data, "corrupt.json"), "not json");
    const restored = await gyst(cwd, ["session", "status"]);
    expect(restored.exitCode).toBe(0);
    const restoredStatus = JSON.parse(restored.stdout);
    expect(restoredStatus.session.id).toBe(status.session.id);
    expect(restoredStatus.groups[0].count).toBe(1);
    expect(restoredStatus.spotlight).toEqual([{
      id: spotlightHunk.id,
      file: spotlightHunk.file,
      tldr: "needs human review",
      accepted: false,
    }]);
    expect(restoredStatus.inbox).toEqual([]);
    expect(JSON.parse((await gyst(cwd, ["session", "diff", "--group", "group-1"])).stdout).hunks).toHaveLength(1);

    const outsider = join(root, "outside");
    await Bun.$`mkdir -p ${outsider}`.quiet();
    const override = await gyst(outsider, ["session", "status", "--session", status.session.id]);
    expect(override.exitCode).toBe(0);

    const closed = await gyst(cwd, ["session", "close"]);
    expect(JSON.parse(closed.stdout)).toEqual({ closed: true, sessionId: status.session.id });
  }, 20_000);

  it("preserves hunk text and ids across multi-file, multi-hunk stdin snapshots", async () => {
    const cwd = await repo("multi-hunk");
    const patch = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-alpha
+ALPHA
 bravo
@@ -5,2 +5,2 @@
-echo
+ECHO
 foxtrot
diff --git a/b.txt b/b.txt
index 1234567..89abcde 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-xray
+XRAY
`;

    const first = JSON.parse((await gyst(cwd, ["session", "create", "--stdin"], patch)).stdout);
    const firstDiff = JSON.parse((await gyst(cwd, ["session", "diff"])).stdout);
    expect(first.inbox).toHaveLength(3);
    expect(firstDiff.hunks.map((hunk: { file: string }) => hunk.file)).toEqual(["a.txt", "a.txt", "b.txt"]);
    expect(firstDiff.hunks.map((hunk: { patch: string }) => hunk.patch)).toEqual([
      expect.stringContaining("-alpha"),
      expect.stringContaining("-echo"),
      expect.stringContaining("-xray"),
    ]);
    const ids = firstDiff.hunks.map((hunk: { id: string }) => hunk.id);
    expect(new Set(ids).size).toBe(3);

    await gyst(cwd, ["session", "close"]);
    const second = await gyst(cwd, ["session", "create", "--stdin"], patch);
    expect(second.exitCode).toBe(0);
    const secondDiff = JSON.parse((await gyst(cwd, ["session", "diff"])).stdout);
    expect(secondDiff.hunks.map((hunk: { id: string }) => hunk.id)).toEqual(ids);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("rejects file-only changes instead of silently omitting them", async () => {
    const cwd = await repo("file-only");
    const modeOnly = `diff --git a/tracked.txt b/tracked.txt
old mode 100644
new mode 100755
`;
    const rejected = await gyst(cwd, ["session", "create", "--stdin"], modeOnly);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stderr).code).toBe("bad_args");

    const valid = await gyst(cwd, ["session", "create", "--stdin"], `diff --git a/tracked.txt b/tracked.txt
--- a/tracked.txt
+++ b/tracked.txt
@@ -1 +1 @@
-one
+two
`);
    expect(valid.exitCode).toBe(0);
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("keeps failed persistence from exposing a session", async () => {
    const cwd = await repo("persist-failure");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
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
    const request = new TextEncoder().encode(`${JSON.stringify({ command: "create", cwd, args: ["--stdin"], stdin: patch })}\n`);
    const marker = new TextEncoder().encode("é");
    const markerStart = request.findIndex((byte, index) => byte === marker[0] && request[index + 1] === marker[1]);
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
          error(_socket, error) { reject(error); },
        },
      }).catch(reject);
    });
    expect(JSON.parse(reply).ok).toBe(true);
    const diff = JSON.parse((await gyst(cwd, ["session", "diff"])).stdout);
    expect(diff.hunks[0].patch).toContain("café");
    await gyst(cwd, ["session", "close"]);
  }, 20_000);

  it("applies batches atomically with revision, idempotency, and queue validation", async () => {
    const cwd = await repo("apply");
    await writeFile(join(cwd, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(cwd, "other.txt"), "new\n");
    const created = JSON.parse((await gyst(cwd, ["session", "create"])).stdout);
    const [first, second] = created.inbox;

    const invalid = await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: 0, idempotencyKey: "invalid-batch", ops: [
        { type: "group.create", id: "group-1", tldr: "mechanical", memberHunkIds: [first.id], exemplarHunkId: first.id },
        { type: "hunk.annotate", hunkId: "missing", tldr: "nope" },
      ],
    }));
    expect(invalid.exitCode).toBe(1);
    const invalidError = JSON.parse(invalid.stderr);
    expect(invalidError.code).toBe("validation_failed");
    expect(invalidError.detail).toEqual([expect.objectContaining({ opIndex: 1 })]);
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout).groups).toEqual([]);

    const incompleteQueue = await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: 0, idempotencyKey: "bad-queue", ops: [
        { type: "hunk.annotate", hunkId: first.id, tldr: "first" },
        { type: "hunk.annotate", hunkId: second.id, tldr: "second" },
        { type: "queue.set", itemIds: [first.id] },
      ],
    }));
    expect(incompleteQueue.exitCode).toBe(1);
    expect(JSON.parse(incompleteQueue.stderr).detail.at(-1).message).toContain("exactly once");

    const envelope = {
      revision: 0, idempotencyKey: "pre-pass", ops: [
        { type: "group.create", id: "group-1", tldr: "mechanical", memberHunkIds: [first.id], exemplarHunkId: first.id },
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

    const stale = await gyst(cwd, ["session", "apply"], JSON.stringify({ revision: 0, idempotencyKey: "stale", ops: [] }));
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stderr).code).toBe("stale_revision");

    const changed = await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: 1, idempotencyKey: "change", ops: [{ type: "hunk.annotate", hunkId: second.id, tldr: "updated" }],
    }));
    expect(JSON.parse(changed.stdout).revision).toBe(2);
    const replay = await gyst(cwd, ["session", "apply"], JSON.stringify(envelope));
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(status);
    expect(JSON.parse((await gyst(cwd, ["session", "status"])).stdout).revision).toBe(2);

    const dissolved = await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: 2, idempotencyKey: "dissolve", ops: [
        { type: "group.dissolve", id: "group-1" },
        { type: "queue.set", itemIds: [second.id] },
      ],
    }));
    expect(dissolved.exitCode).toBe(0);
    expect(JSON.parse(dissolved.stdout)).toEqual(expect.objectContaining({
      groups: [], queue: [second.id], queueSet: true, ready: false,
    }));
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
    const applied = JSON.parse((await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: 0, idempotencyKey: "fold", ops: [
        { type: "group.create", id: "group-1", tldr: "stable group", memberHunkIds: [first.id], exemplarHunkId: first.id },
        { type: "hunk.annotate", hunkId: second.id, tldr: "stale spotlight" },
        { type: "queue.set", itemIds: ["group-1", second.id] },
      ],
    }))).stdout);

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
    expect(refreshed.groups[0]).toEqual(expect.objectContaining({ id: "group-1", accepted: true, hunkIds: [first.id] }));
    expect(refreshed.spotlight).toEqual([]);
    expect(refreshed.inbox).toHaveLength(2);
    expect(refreshed.queue).toEqual(["group-1", ...refreshed.inbox.map((hunk: { id: string }) => hunk.id)]);
    expect(refreshed.queueSet).toBe(false);
    expect(refreshed.ready).toBe(false);

    const updated = await gyst(cwd, ["session", "apply"], JSON.stringify({
      revision: refreshed.revision, idempotencyKey: "update-group", ops: [
        { type: "group.update", id: "group-1", tldr: "updated group" },
        { type: "queue.set", itemIds: ["group-1"] },
      ],
    }));
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout).groups[0].accepted).toBe(false);
    await gyst(cwd, ["session", "close"]);

    const stdinRepo = await repo("refresh-stdin");
    const firstPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const secondPatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+newer\n`;
    const stdinCreated = JSON.parse((await gyst(stdinRepo, ["session", "create", "--stdin"], firstPatch)).stdout);
    const withoutPipe = await gyst(stdinRepo, ["session", "refresh"]);
    expect(withoutPipe.exitCode).toBe(1);
    expect(JSON.parse(withoutPipe.stderr).code).toBe("bad_args");
    const stdinRefresh = await gyst(stdinRepo, ["session", "refresh", "--stdin"], secondPatch);
    expect(stdinRefresh.exitCode).toBe(0);
    expect(JSON.parse(stdinRefresh.stdout).inbox[0].id).not.toBe(stdinCreated.inbox[0].id);
    await gyst(stdinRepo, ["session", "close"]);
  }, 20_000);

  it("supports replayable git arguments, stdin patches, and no sole-session fallback", async () => {
    const argsRepo = await repo("args");
    await writeFile(join(argsRepo, "tracked.txt"), "two\n");
    git(argsRepo, "commit", "-am", "second", "-q");
    const argsCreated = await gyst(argsRepo, ["session", "create", "--", "-p", "HEAD~1", "HEAD"]);
    expect(argsCreated.exitCode).toBe(0);
    expect(JSON.parse(argsCreated.stdout).session.source).toEqual({ kind: "git", args: ["-p", "HEAD~1", "HEAD"] });
    const argsRefreshed = await gyst(argsRepo, ["session", "refresh"]);
    expect(argsRefreshed.exitCode).toBe(0);
    expect(JSON.parse(argsRefreshed.stdout)).toEqual(expect.objectContaining({ revision: 1, inbox: expect.any(Array) }));

    const other = await repo("other");
    const noFallback = await gyst(other, ["session", "status"]);
    expect(noFallback.exitCode).toBe(1);
    expect(JSON.parse(noFallback.stderr).code).toBe("no_session");

    const badRevision = await gyst(other, ["session", "create", "--cached"]);
    expect(badRevision.exitCode).toBe(1);
    expect(JSON.parse(badRevision.stderr).code).toBe("bad_args");

    const patch = git(argsRepo, "diff", "HEAD~1", "HEAD");
    const stdinRepo = await repo("stdin");
    const stdinCreated = await gyst(stdinRepo, ["session", "create", "--stdin"], patch);
    expect(stdinCreated.exitCode).toBe(0);
    expect(JSON.parse(stdinCreated.stdout).session.source).toEqual({ kind: "stdin" });

    await gyst(argsRepo, ["session", "close"]);
    await gyst(stdinRepo, ["session", "close"]);
    for (let attempt = 0; attempt < 20 && await Bun.file(join(data, "daemon.pid")).exists(); attempt++) await Bun.sleep(20);
    expect(await Bun.file(join(data, "daemon.pid")).exists()).toBe(false);
  }, 20_000);
});
