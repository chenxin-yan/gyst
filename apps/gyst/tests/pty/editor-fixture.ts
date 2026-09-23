import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

const mode = process.env.GYST_PTY_MODE!;
const childLog = process.env.GYST_PTY_CHILD!;

if (mode.startsWith("vim")) {
  // Exercise the pre-exec window that previously let the harness send Ctrl+C too early.
  if (mode === "vim-noop") await Bun.sleep(500);
  const vim = process.env.GYST_PTY_VIM!;
  assert(
    typeof process.execve === "function",
    "The pinned Bun runtime must support process.execve",
  );
  const ready = `autocmd VimEnter * call writefile([json_encode({'pid': getpid()})], '${childLog.replaceAll("'", "''")}')`;
  // Only VimEnter proves that Vim owns input; the wrapper has not initialized the editor.
  process.execve(vim, [
    vim,
    "-N",
    "-u",
    "NONE",
    "-i",
    "NONE",
    "-n",
    "-c",
    ready,
    ...process.argv.slice(2),
  ]);
}

let descendant: Bun.Subprocess | undefined;
if (mode.startsWith("descendant")) {
  descendant = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      descendant!.kill(signal);
      void descendant!.exited.then(() => process.exit(128 + constants.signals[signal]));
    });
  }
}
if (mode === "ignore-term" || mode === "ignore-int") {
  process.on(mode === "ignore-term" ? "SIGTERM" : "SIGINT", () => {});
}

// Linux proc stat fields 5 and 8 are the process group and terminal foreground group.
const stat = readFileSync("/proc/self/stat", "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
const modes = Bun.spawnSync(["stty", "-a"], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
assert.equal(modes.exitCode, 0, modes.stderr.toString());
writeFileSync(
  childLog,
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    tty: process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
    canonical: /(?:^|\s)icanon(?:\s|$)/.test(modes.stdout.toString()),
    pgrp: Number(fields[2]),
    foreground: Number(fields[5]),
    descendant: descendant?.pid,
  }),
);

if (mode === "nonzero") process.exit(7);
if (mode === "noop") process.exit(0);
if (["ignore-term", "ignore-int", "descendant-int", "descendant-term"].includes(mode)) {
  await Bun.sleep(30_000);
} else {
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  process.stdin.pause();
  if (mode === "backlog") await Bun.sleep(200);
  if (mode === "save") writeFileSync(process.argv[2]!, "saved by fake editor\n");
}
