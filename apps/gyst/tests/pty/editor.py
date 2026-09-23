#!/usr/bin/env python3
"""Linux real-PTY regression: python3 tests/pty/editor.py --evidence /outside/repo/path.
Requires Bun and Vim on PATH. Uses only stdlib, isolated sessions, continuous drain,
and bounded cleanup. It does not claim macOS/Windows runtime coverage.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


def screen(data):
    cells = [[" "] * 240 for _ in range(40)]
    row = col = 0
    for match in re.finditer(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|[P_].*?\x1b\\)|[^\x1b]", data.decode(errors="ignore"), re.S):
        token = match.group()
        if token.startswith("\x1b["):
            cmd = token[-1]
            values = [int(n) if n.isdigit() else 0 for n in token[2:-1].split(";")]
            first = values[0] or 1
            if cmd in "Hf": row, col = first - 1, (values[1] or 1) - 1 if len(values) > 1 else 0
            elif cmd == "A": row -= first
            elif cmd == "B": row += first
            elif cmd == "C": col += first
            elif cmd == "D": col -= first
            elif cmd == "G": col = first - 1
            elif cmd == "d": row = first - 1
            elif cmd == "J" and values[0] in [2, 3]: cells = [[" "] * 240 for _ in range(40)]
            elif cmd == "K" and 0 <= row < 40:
                for c in range(0 if values[0] in [1, 2] else max(0, col), 240 if values[0] in [0, 2] else min(240, col + 1)): cells[row][c] = " "
        elif token.startswith("\x1b"): pass
        elif token == "\r": col = 0
        elif token == "\n": row += 1
        elif token >= " ":
            if 0 <= row < 40 and 0 <= col < 240: cells[row][col] = token
            col += 1
    return "\n".join("".join(line) for line in cells)


def run_case(name, evidence, bun, vim):
    with tempfile.TemporaryDirectory(prefix="gyst editor pty ") as directory:
        root = Path(directory)
        target = root / "target with spaces.txt"
        target.write_text("before\n")
        log = root / "events.jsonl"
        child_log = root / "child.json"
        editor = root / "editor with spaces"
        if name.startswith("vim"):
            # An explicit executable wrapper is the supported way to supply flags.
            editor.write_text(f"#!{sys.executable}\nimport os,json\nfrom pathlib import Path\nPath({str(child_log)!r}).write_text(json.dumps({{'pid':os.getpid()}}))\nos.execv({vim!r}, [{vim!r}, '-N', '-u', 'NONE', '-i', 'NONE', '-n', *os.sys.argv[1:]])\n")
        else:
            editor.write_text(f'''#!{sys.executable}
import json,os,signal,sys,time,termios,subprocess
from pathlib import Path
mode={name!r}
descendant = None
if mode.startswith('descendant'):
    descendant = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    def end(sig, _frame):
        descendant.send_signal(sig)
        descendant.wait(timeout=2)
        sys.exit(128 + sig)
    signal.signal(signal.SIGTERM, end)
    signal.signal(signal.SIGINT, end)
if mode in ['ignore-term', 'ignore-int']:
    signal.signal(signal.SIGTERM if mode == 'ignore-term' else signal.SIGINT, lambda *_: None)
Path({str(child_log)!r}).write_text(json.dumps({{'pid':os.getpid(),'argv':sys.argv[1:],'cwd':os.getcwd(),'tty':all(os.isatty(i) for i in [0,1,2]),'canonical':bool(termios.tcgetattr(0)[3] & termios.ICANON),'pgrp':os.getpgrp(),'foreground':os.tcgetpgrp(0),'descendant':descendant.pid if descendant else None}}))
if mode == 'nonzero': sys.exit(7)
if mode == 'noop': sys.exit(0)
if mode in ['ignore-term','ignore-int','descendant-int','descendant-term']:
    while True: time.sleep(.1)
try: sys.stdin.readline()
except KeyboardInterrupt: sys.exit(130)
if mode == 'backlog': time.sleep(.2)
if mode == 'save': Path(sys.argv[1]).write_text('saved by fake editor\\n')
''')
        editor.chmod(0o755)
        env = dict(os.environ, EDITOR=str(editor), TERM="xterm-256color", GYST_PTY_LOG=str(log), GYST_PTY_MODE=name,
                   GYST_PTY_SOURCE="stdin" if name == "stdin" else "git", HOME=str(root), XDG_CONFIG_HOME=str(root / "config"))
        if name == "missing": env["EDITOR"] = "gyst-no-such-editor"
        if name == "unset": env.pop("EDITOR", None)
        master, slave = os.openpty()
        baseline = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
        def terminal_session():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            os.tcsetpgrp(0, os.getpgrp())
        app = Path(__file__).resolve().parents[2]
        process = subprocess.Popen([bun, "--preload", str(app / "node_modules/@opentui/solid/scripts/preload.js"), str(Path(__file__).with_name("editor-driver.tsx").resolve())],
                                   cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal_session)
        captured = bytearray()
        stop = threading.Event()
        def drain():
            while not stop.is_set():
                if select.select([master], [], [], .025)[0]:
                    try:
                        data = os.read(master, 65536)
                        if not data: break
                        captured.extend(data)
                    except OSError: break
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        child = None
        def events():
            if not log.exists(): return []
            return [json.loads(line) for line in log.read_text().splitlines() if line.endswith("}")]
        def event(kind): return [e for e in events() if e["event"] == kind]
        def wait(predicate, description, timeout=8):
            end = time.monotonic() + timeout
            while not predicate():
                assert time.monotonic() < end, (name, description, process.poll(), events(), bytes(captured)[-1000:])
                time.sleep(.025)
        def send(value): os.write(master, value)
        def resize(width):
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)
        try:
            wait(lambda: event("mounted"), "mount")
            wait(lambda: "[diff]" in screen(bytes(captured)), "initial frame")
            send(b"o")
            if name not in ["missing", "unset", "suspend"]:
                wait(child_log.exists, "editor start")
                child = json.loads(child_log.read_text())
                if not name.startswith("vim"):
                    assert child["argv"] == [str(target)] and child["cwd"] == str(root)
                    assert child["tty"] and child["canonical"]
                    assert child["pgrp"] == child["foreground"], "child retains terminal foreground group"
                if name in ["term", "hup", "quit-signal", "ignore-term", "descendant-term", "abrt", "pipe", "bus"]:
                    os.kill(process.pid, {"term": signal.SIGTERM, "hup": signal.SIGHUP, "quit-signal": signal.SIGQUIT, "ignore-term": signal.SIGTERM, "descendant-term": signal.SIGTERM, "abrt": signal.SIGABRT, "pipe": signal.SIGPIPE, "bus": signal.SIGBUS}[name])
                elif name == "destroy": os.kill(process.pid, signal.SIGUSR1)
                elif name in ["ctrl-c", "ignore-int", "descendant-int"]: send(b"\x03")
                elif name.startswith("vim"):
                    wait(lambda: "before" in screen(bytes(captured)), "Vim file")
                    for width in [80, 200, 120]: resize(width); time.sleep(.08)
                    if name == "vim-save": send(b"GoREAL_EDITOR_SAVE\x1b:wq\r")
                    elif name == "vim-term": os.kill(process.pid, signal.SIGTERM)
                    else:
                        send(b"\x03")
                        time.sleep(.1)
                        send(b":q!\r")
                elif name not in ["nonzero", "noop"]:
                    for width in [80, 200, 120]: resize(width); time.sleep(.05)
                    send(b"x\n")
                    if name == "backlog": send(b"q\n")
            shutting_down = name in ["term", "hup", "quit-signal", "ignore-term", "destroy", "resume", "vim-term", "descendant-term", "abrt", "pipe", "bus"]
            wait(lambda: event("returned"), "handoff return")
            returned = event("returned")[0]
            assert returned["refreshes"] == 0
            assert returned["reads"] == event("edit")[0]["reads"], "no polls during handoff"
            if shutting_down:
                wait(lambda: process.poll() is not None, "terminated app")
                assert not event("resumed"), "shutdown never resumes"
                expected = {"term":143, "hup":129, "quit-signal":131, "ignore-term":143, "vim-term":143, "descendant-term":143, "abrt":134, "pipe":141, "bus":135}.get(name, 0)
                assert process.returncode == expected, (name, process.returncode)
            else:
                assert returned["listeners"] == returned["before"], "handoff listeners removed"
                assert returned["raw"] and not returned["destroyed"]
                assert len(event("resumed")) == (0 if name in ["missing", "unset"] else 1)
                guidance = "stdin snapshot unchanged" if name == "stdin" else "snapshot unchanged"
                wait(lambda: guidance in screen(bytes(captured)), "snapshot guidance")
                time.sleep(.1)
                assert process.poll() is None and not event("quit"), "no replay of editor keystrokes"
                send(b"q")
                wait(lambda: process.poll() is not None, "normal quit")
                assert process.returncode == 0
            wait(lambda: event("finished"), "outer finalizer")
            assert event("finished")[0]["refreshes"] == 0
            assert event("finished")[0]["listeners"] == event("finished")[0]["initialListeners"]
            assert termios.tcgetattr(slave)[3] & termios.ICANON, "canonical terminal restored"
            assert bool(termios.tcgetattr(slave)[3] & termios.ECHO) == bool(baseline[3] & termios.ECHO)
            assert bytes(captured).count(b"\x1b[?1049h") == bytes(captured).count(b"\x1b[?1049l"), "alternate screen balanced"
            assert not any(e.get("destroyed") for e in event("resuming")), "no resume after destroy"
            if child:
                for pid in [child["pid"], child.get("descendant")]:
                    if pid is None: continue
                    try: os.kill(pid, 0)
                    except ProcessLookupError: pass
                    else: raise AssertionError((name, "child not reaped", child))
            if name == "save": assert target.read_text() == "saved by fake editor\n"
            if name == "vim-save": assert "REAL_EDITOR_SAVE" in target.read_text()
            print(f"PASS {name}: exit={process.returncode}, resumes={len(event('resumed'))}, terminal restored, child reaped", flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            if child:
                for pid in [child["pid"], child.get("descendant")]:
                    if pid is None: continue
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            time.sleep(.05)
            stop.set()
            reader.join(timeout=1)
            (evidence / f"{name}.terminal.bin").write_bytes(captured)
            (evidence / f"{name}.events.json").write_text(json.dumps(events(), indent=2))
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    assert sys.platform == "linux", "This harness verifies Linux; request other runtime access separately."
    bun, vim = shutil.which("bun"), shutil.which("vim")
    assert bun and vim, "Bun and real Vim are required; do not silently skip editor verification."
    args.evidence.mkdir(parents=True, exist_ok=True)
    for case in ["noop", "save", "stdin", "nonzero", "missing", "unset", "ctrl-c", "ignore-int", "backlog", "term", "hup", "quit-signal", "ignore-term", "abrt", "pipe", "bus", "descendant-int", "descendant-term", "destroy", "suspend", "resume", "vim-noop", "vim-save", "vim-term"]:
        run_case(case, args.evidence, bun, vim)
