import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorHandoff, editorTarget, type EditRequest } from "./editor.ts";

class Terminal extends EventEmitter {
  isDestroyed = false;
  suspends = 0;
  resumes = 0;
  failSuspend = false;
  failResume = false;
  suspend() {
    this.suspends++;
    if (this.failSuspend) throw new Error("suspend failed");
  }
  resume() {
    assert(!this.isDestroyed);
    this.resumes++;
    if (this.failResume) throw new Error("resume failed");
  }
  destroy() {
    if (!this.isDestroyed) {
      this.isDestroyed = true;
      this.emit("destroy");
    }
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gyst editor "));
  const root = join(dir, "repo");
  await mkdir(root);
  const file = join(root, "target with spaces.txt");
  await writeFile(file, "before");
  const executable = join(dir, "editor with spaces");
  const log = join(dir, "child.json");
  const request: EditRequest = {
    sessionId: "s",
    revision: 0,
    repoRoot: root,
    file: "target with spaces.txt",
    cursor: { itemId: "h", pane: "diff", hunkId: "h" },
  };
  const script = async (code: string) => {
    await writeFile(executable, `#!${process.execPath}\n${code}\n`);
    await chmod(executable, 0o755);
  };
  await script(
    `await Bun.write(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));`,
  );
  return {
    dir,
    root,
    file,
    executable,
    log,
    request,
    script,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

async function recorded(path: string) {
  for (let i = 0; i < 200; i++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await Bun.sleep(5);
    }
  }
  assert.fail("child did not start");
}

const listeners = () =>
  ["SIGINT", "SIGTERM", "SIGQUIT", "SIGHUP", "SIGABRT", "SIGPIPE", "SIGBUS"].map((s) =>
    process.listenerCount(s),
  );

describe("editor handoff", () => {
  it("validates real containment, regular files and a single executable without shell parsing", async () => {
    const f = await fixture();
    try {
      assert.deepEqual(await editorTarget(f.request, f.executable), {
        root: f.root,
        file: f.file,
        executable: f.executable,
      });
      for (const editor of [
        "",
        "   ",
        "missing-gyst-editor",
        `${f.executable} --wait`,
        "$(touch shell-evaluated)",
      ])
        await assert.rejects(editorTarget(f.request, editor), /EDITOR/);
      await writeFile(join(f.dir, "outside"), "outside");
      await symlink(join(f.dir, "outside"), join(f.root, "escape"));
      await symlink(f.file, join(f.root, "inside"));
      assert.equal(
        (await editorTarget({ ...f.request, file: "inside" }, f.executable)).file,
        f.file,
      );
      for (const file of [
        "../outside",
        "sub/../target with spaces.txt",
        "escape",
        "missing",
        ".",
        f.dir,
      ])
        await assert.rejects(editorTarget({ ...f.request, file }, f.executable));
      await mkdir(join(f.root, "directory"));
      await assert.rejects(
        editorTarget({ ...f.request, file: "directory" }, f.executable),
        /regular file/,
      );
      await symlink(f.root, join(f.dir, "root-link"));
      assert.equal(
        (await editorTarget({ ...f.request, repoRoot: join(f.dir, "root-link") }, f.executable))
          .root,
        f.root,
      );
    } finally {
      await f.close();
    }
  });

  it("does not suspend on validation failure or destruction during validation", async () => {
    const f = await fixture();
    const old = process.env.EDITOR;
    const terminal = new Terminal();
    const handoff = editorHandoff(terminal, () => {});
    try {
      delete process.env.EDITOR;
      await assert.rejects(handoff.edit(f.request), /Set EDITOR/);
      assert.equal(terminal.suspends, 0);
      process.env.EDITOR = f.executable;
      const active = handoff.edit(f.request);
      terminal.destroy();
      await handoff.shutdown();
      await active;
      assert.equal(terminal.suspends, 0);
      assert.equal(terminal.resumes, 0);
    } finally {
      await handoff.shutdown();
      if (old === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = old;
      await f.close();
    }
  });

  for (const mode of ["success", "nonzero", "spawn", "suspend", "resume"] as const) {
    it(`restores exactly once and cleans listeners on ${mode}`, async () => {
      const f = await fixture();
      const old = process.env.EDITOR;
      const terminal = new Terminal();
      const before = listeners();
      const handoff = editorHandoff(terminal, () => assert.fail("unexpected termination"));
      let restoreSpawn: (() => void) | undefined;
      try {
        process.env.EDITOR = f.executable;
        if (mode === "nonzero") await f.script("process.exit(7);");
        if (mode === "spawn") {
          const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
            throw new Error("spawn failed");
          });
          restoreSpawn = () => spawn.mockRestore();
        }
        terminal.failSuspend = mode === "suspend";
        terminal.failResume = mode === "resume";
        if (mode === "success") {
          await handoff.edit(f.request);
          const child = await recorded(f.log);
          assert.deepEqual(child.argv, [f.file]);
          assert.equal(child.cwd, f.root);
          assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
        } else await assert.rejects(handoff.edit(f.request), /failed|exited 7/);
        assert.equal(terminal.suspends, 1);
        assert.equal(terminal.resumes, 1);
        assert.equal(terminal.isDestroyed, mode === "resume");
        assert.deepEqual(listeners(), before);
        assert.equal(terminal.listenerCount("destroy"), 0);
      } finally {
        restoreSpawn?.();
        await handoff.shutdown();
        if (old === undefined) delete process.env.EDITOR;
        else process.env.EDITOR = old;
        await f.close();
      }
    });
  }

  for (const destruction of [false, true]) {
    it(`bounds termination, reaps an ignoring child, and never resumes on ${destruction ? "destruction" : "outer teardown"}`, async () => {
      const f = await fixture();
      const old = process.env.EDITOR;
      const terminal = new Terminal();
      const before = listeners();
      const handoff = editorHandoff(terminal, () => {});
      try {
        process.env.EDITOR = f.executable;
        await f.script(
          `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(f.log)}, JSON.stringify({pid: process.pid})); setInterval(() => {}, 1000);`,
        );
        const active = handoff.edit(f.request);
        const child = await recorded(f.log);
        await assert.rejects(handoff.edit(f.request), /already active/);
        const started = Date.now();
        if (destruction) terminal.destroy();
        await handoff.shutdown();
        await active;
        assert(Date.now() - started < 2500, "bounded grace");
        assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
        assert.equal(terminal.resumes, 0);
        assert(terminal.isDestroyed);
        assert.deepEqual(listeners(), before);
        await assert.rejects(handoff.edit(f.request), /closing/);
      } finally {
        await handoff.shutdown();
        if (old === undefined) delete process.env.EDITOR;
        else process.env.EDITOR = old;
        await f.close();
      }
    });
  }
});
