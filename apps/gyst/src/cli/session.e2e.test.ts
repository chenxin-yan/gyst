import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    // #17 will author groups through apply; seed persisted state here to exercise this ticket's read selector.
    const statePath = join(data, `${status.session.id}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.groups = [{ id: "group-1", tldr: "same edit", exemplarHunkId: hunkId, hunkIds: [hunkId] }];
    await writeFile(statePath, JSON.stringify(state));
    const restored = await gyst(cwd, ["session", "status"]);
    expect(restored.exitCode).toBe(0);
    expect(JSON.parse(restored.stdout).session.id).toBe(status.session.id);
    expect(JSON.parse(restored.stdout).groups[0].count).toBe(1);
    expect(JSON.parse((await gyst(cwd, ["session", "diff", "--group", "group-1"])).stdout).hunks).toHaveLength(1);

    const outsider = join(root, "outside");
    await Bun.$`mkdir -p ${outsider}`.quiet();
    const override = await gyst(outsider, ["session", "status", "--session", status.session.id]);
    expect(override.exitCode).toBe(0);

    const closed = await gyst(cwd, ["session", "close"]);
    expect(JSON.parse(closed.stdout)).toEqual({ closed: true, sessionId: status.session.id });
  }, 20_000);

  it("supports replayable git arguments, stdin patches, and no sole-session fallback", async () => {
    const argsRepo = await repo("args");
    await writeFile(join(argsRepo, "tracked.txt"), "two\n");
    git(argsRepo, "commit", "-am", "second", "-q");
    const argsCreated = await gyst(argsRepo, ["session", "create", "--", "HEAD~1", "HEAD"]);
    expect(argsCreated.exitCode).toBe(0);
    expect(JSON.parse(argsCreated.stdout).session.source).toEqual({ kind: "git", args: ["HEAD~1", "HEAD"] });

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
