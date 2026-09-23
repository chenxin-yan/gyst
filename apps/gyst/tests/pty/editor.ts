// Linux real-PTY regression; requires the pinned Bun runtime and Vim. Evidence stays outside the repo.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

function screen(data: Buffer) {
  let cells = Array.from({ length: 40 }, () => Array<string>(240).fill(" "));
  let row = 0;
  let col = 0;
  // OSC terminates at BEL or ST, never at a BEL in a later frame.
  const tokens = data.toString().matchAll(
    // eslint-disable-next-line no-control-regex -- Interpret actual terminal control sequences.
    /\x1b\[[0-?]*[ -/]*[@-~]|\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_].*?\x1b\\)|[^\x1b]/gs,
  );
  for (const [token] of tokens) {
    if (token.startsWith("\x1b[")) {
      const cmd = token.at(-1)!;
      const values = token
        .slice(2, -1)
        .split(";")
        .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
      const first = values[0] || 1;
      if (cmd === "H" || cmd === "f") {
        row = first - 1;
        col = (values[1] || 1) - 1;
      } else if (cmd === "A") row -= first;
      else if (cmd === "B") row += first;
      else if (cmd === "C") col += first;
      else if (cmd === "D") col -= first;
      else if (cmd === "G") col = first - 1;
      else if (cmd === "d") row = first - 1;
      else if (cmd === "J" && [2, 3].includes(values[0]!))
        cells = Array.from({ length: 40 }, () => Array<string>(240).fill(" "));
      else if (cmd === "K" && cells[row]) {
        const start = [1, 2].includes(values[0]!) ? 0 : Math.max(0, col);
        const end = [0, 2].includes(values[0]!) ? 240 : Math.min(240, col + 1);
        cells[row]!.fill(" ", start, end);
      }
    } else if (token.startsWith("\x1b")) continue;
    else if (token === "\r") col = 0;
    else if (token === "\n") row++;
    else if (token >= " ") {
      if (cells[row] && col >= 0 && col < 240) cells[row]![col] = token;
      col++;
    }
  }
  return cells.map((line) => line.join("")).join("\n");
}

type Event = { event: string; [key: string]: unknown };
type Child = {
  pid: number;
  argv?: string[];
  cwd?: string;
  tty?: boolean;
  canonical?: boolean;
  pgrp?: number;
  foreground?: number;
  descendant?: number;
};
const termination: Record<string, NodeJS.Signals> = {
  term: "SIGTERM",
  hup: "SIGHUP",
  "quit-signal": "SIGQUIT",
  "ignore-term": "SIGTERM",
  "descendant-term": "SIGTERM",
  abrt: "SIGABRT",
  pipe: "SIGPIPE",
  bus: "SIGBUS",
  "vim-term": "SIGTERM",
};
// Linux termios c_lflag bits; this harness deliberately claims Linux runtime coverage only.
const ICANON = 0x2;
const ECHO = 0x8;

async function runCase(name: string, evidence: string, vim: string) {
  const root = mkdtempSync(join(tmpdir(), "gyst editor pty "));
  const target = join(root, "target with spaces.txt");
  const log = join(root, "events.jsonl");
  const childLog = join(root, "child.json");
  const editor = join(root, "editor with spaces");
  writeFileSync(target, "before\n");
  writeFileSync(
    editor,
    `#!${process.execPath}\nawait import(${JSON.stringify(join(import.meta.dir, "editor-fixture.ts"))});\n`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EDITOR: editor,
    TERM: "xterm-256color",
    GYST_PTY_LOG: log,
    GYST_PTY_CHILD: childLog,
    GYST_PTY_MODE: name,
    GYST_PTY_VIM: vim,
    GYST_PTY_SOURCE: name === "stdin" ? "stdin" : "git",
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
  };
  if (name === "missing") env.EDITOR = "gyst-no-such-editor";
  if (name === "unset") delete env.EDITOR;
  const captured: Buffer[] = [];
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 30,
    data: (_, data) => captured.push(Buffer.from(data)),
  });
  const baseline = terminal.localFlags;
  // Bun allocates the PTY; setsid assigns its controlling session for terminal-generated signals.
  const driver = Bun.spawn(
    [
      "setsid",
      "--ctty",
      process.execPath,
      "--preload",
      resolve(import.meta.dir, "../../node_modules/@opentui/solid/scripts/preload.js"),
      join(import.meta.dir, "editor-driver.tsx"),
    ],
    { cwd: root, env, terminal },
  );
  let child: Child | undefined;
  const bytes = () => Buffer.concat(captured);
  const events = (): Event[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.endsWith("}"))
          .map((line) => JSON.parse(line))
      : [];
  const event = (kind: string) => events().filter((entry) => entry.event === kind);
  const wait = async (predicate: () => boolean, description: string) => {
    const deadline = performance.now() + 8_000;
    while (!predicate()) {
      assert(
        performance.now() < deadline,
        JSON.stringify({
          name,
          description,
          exit: driver.exitCode,
          events: events(),
          output: bytes().toString().slice(-1000),
        }),
      );
      await Bun.sleep(25);
    }
  };
  const send = (value: string) => terminal.write(value);
  try {
    await wait(() => event("mounted").length > 0, "mount");
    await wait(() => screen(bytes()).includes("[diff]"), "initial frame");
    send("o");
    if (!["missing", "unset", "suspend"].includes(name)) {
      await wait(
        () => existsSync(childLog) && readFileSync(childLog, "utf8").trimEnd().endsWith("}"),
        "editor start",
      );
      child = JSON.parse(readFileSync(childLog, "utf8")) as Child;
      if (!name.startsWith("vim")) {
        assert.deepEqual(child.argv, [target]);
        assert.equal(child.cwd, root);
        assert(child.tty);
        assert(child.canonical, "editor receives canonical input");
        assert.equal(child.pgrp, child.foreground, "child retains terminal foreground group");
      }
      if (termination[name] && name !== "vim-term") driver.kill(termination[name]);
      else if (name === "destroy") driver.kill("SIGUSR1");
      else if (["ctrl-c", "ignore-int", "descendant-int"].includes(name)) send("\x03");
      else if (name.startsWith("vim")) {
        for (const width of [80, 200, 120]) {
          terminal.resize(width, 30);
          await Bun.sleep(80);
        }
        if (name === "vim-save") send("GoREAL_EDITOR_SAVE\x1b:wq\r");
        else if (name === "vim-term") driver.kill("SIGTERM");
        else {
          send("\x03");
          await Bun.sleep(100);
          assert.equal(
            event("returned").length,
            0,
            "Vim must own Ctrl+C; never type into the resumed TUI",
          );
          send(":q!\r");
        }
      } else if (!["nonzero", "noop"].includes(name)) {
        for (const width of [80, 200, 120]) {
          terminal.resize(width, 30);
          await Bun.sleep(50);
        }
        send("x\n");
        if (name === "backlog") send("q\n");
      }
    }
    const shuttingDown = Boolean(termination[name]) || ["destroy", "resume"].includes(name);
    await wait(() => event("returned").length > 0, "handoff return");
    const returned = event("returned")[0]!;
    assert.equal(returned.refreshes, 0);
    assert.equal(returned.reads, event("edit")[0]!.reads, "no polls during handoff");
    if (shuttingDown) {
      await wait(() => driver.exitCode !== null, "terminated app");
      assert.equal(event("resumed").length, 0, "shutdown never resumes");
      assert.equal(
        driver.exitCode,
        termination[name] ? 128 + constants.signals[termination[name]] : 0,
      );
    } else {
      assert.deepEqual(returned.listeners, returned.before, "handoff listeners removed");
      assert(returned.raw && !returned.destroyed);
      assert.equal(event("resumed").length, ["missing", "unset"].includes(name) ? 0 : 1);
      const guidance = name === "stdin" ? "stdin snapshot unchanged" : "snapshot unchanged";
      await wait(() => screen(bytes()).includes(guidance), "snapshot guidance");
      await Bun.sleep(100);
      assert(
        driver.exitCode === null && event("quit").length === 0,
        "no replay of editor keystrokes",
      );
      send("q");
      await wait(() => driver.exitCode !== null, "normal quit");
      assert.equal(driver.exitCode, 0);
    }
    await driver.exited;
    await wait(() => event("finished").length > 0, "outer finalizer");
    const finished = event("finished")[0]!;
    assert.equal(finished.refreshes, 0);
    assert.deepEqual(finished.listeners, finished.initialListeners);
    assert(terminal.localFlags & ICANON, "canonical terminal restored");
    assert.equal(terminal.localFlags & ECHO, baseline & ECHO, "echo restored");
    await Bun.sleep(50);
    const output = bytes().toString();
    assert.equal(
      output.split("\x1b[?1049h").length,
      output.split("\x1b[?1049l").length,
      "alternate screen balanced",
    );
    assert(!event("resuming").some((entry) => entry.destroyed), "no resume after destroy");
    for (const pid of [child?.pid, child?.descendant]) {
      if (pid !== undefined)
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "child reaped");
    }
    if (name === "save") assert.equal(readFileSync(target, "utf8"), "saved by fake editor\n");
    if (name === "vim-save") assert(readFileSync(target, "utf8").includes("REAL_EDITOR_SAVE"));
    console.log(
      `PASS ${name}: exit=${driver.exitCode}, resumes=${event("resumed").length}, terminal restored, child reaped`,
    );
  } finally {
    if (driver.exitCode === null) {
      driver.kill("SIGTERM");
      await Promise.race([driver.exited, Bun.sleep(2_000)]);
      if (driver.exitCode === null) {
        driver.kill("SIGKILL");
        await driver.exited;
      }
    }
    for (const pid of [child?.pid, child?.descendant]) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      }
    }
    try {
      writeFileSync(join(evidence, `${name}.terminal.bin`), bytes());
      writeFileSync(join(evidence, `${name}.events.json`), JSON.stringify(events(), null, 2));
    } finally {
      terminal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

assert.equal(
  process.platform,
  "linux",
  "This harness verifies Linux; request other runtime access separately.",
);
const { values } = parseArgs({ options: { evidence: { type: "string" } }, strict: true });
assert(values.evidence, "--evidence /path/outside/repo is required");
const vim = Bun.which("vim");
assert(
  vim && Bun.which("stty") && Bun.which("setsid"),
  "Vim, stty and setsid are required; do not silently skip editor verification.",
);
mkdirSync(values.evidence, { recursive: true });
for (const name of [
  "noop",
  "save",
  "stdin",
  "nonzero",
  "missing",
  "unset",
  "ctrl-c",
  "ignore-int",
  "backlog",
  "term",
  "hup",
  "quit-signal",
  "ignore-term",
  "abrt",
  "pipe",
  "bus",
  "descendant-int",
  "descendant-term",
  "destroy",
  "suspend",
  "resume",
  "vim-noop",
  "vim-save",
  "vim-term",
])
  await runCase(name, resolve(values.evidence), vim);
