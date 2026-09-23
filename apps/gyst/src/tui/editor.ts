import type { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CliRenderer } from "@opentui/core";
import type { StatusPayload } from "@gyst/core";

export type EditRequest = {
  sessionId: string;
  revision: number;
  repoRoot: string;
  file: string;
  cursor: StatusPayload["cursor"];
};

/** Validate before giving up the terminal; argv never passes through a shell. */
export async function editorTarget(request: EditRequest, editor = process.env.EDITOR) {
  if (!editor?.trim()) throw new Error("Set EDITOR to one executable (use a wrapper for flags).");
  if (!request.file || request.file.split(/[\\/]/).includes(".."))
    throw new Error("Cannot edit a traversing or empty file path.");
  const root = await realpath(request.repoRoot);
  const file = await realpath(resolve(root, request.file)).catch(() => {
    throw new Error("Cannot edit: working-tree file is missing or inaccessible.");
  });
  const within = relative(root, file);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("Cannot edit a file outside the repository.");
  if (!(await stat(file)).isFile()) throw new Error("Cannot edit: target is not a regular file.");
  const executable = Bun.which(editor, { cwd: root });
  if (!executable)
    throw new Error("EDITOR executable not found; use one executable path, not flags.");
  return { root, file, executable };
}

// Match OpenTUI's suspended exit-signal ownership. SIGBREAK exists only on Windows.
const signals: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGHUP",
  "SIGPIPE",
  ...(process.platform === "win32" ? ["SIGBREAK" as const] : ["SIGBUS" as const]),
];
const KILL_GRACE_MS = 750;
type Terminal = Pick<CliRenderer, "suspend" | "resume" | "destroy" | "isDestroyed"> &
  Pick<EventEmitter, "on" | "off">;

/** Owned by renderTui, whose teardown must await shutdown before disposing its runtime. */
export function editorHandoff(renderer: Terminal, onTerminate: (signal: NodeJS.Signals) => void) {
  let active: Promise<void> | undefined;
  let stopping = false;
  let cancel: (() => void) | undefined;

  async function run(request: EditRequest) {
    const target = await editorTarget(request);
    if (stopping || renderer.isDestroyed) return;
    let child: Bun.Subprocess | undefined;
    let reaped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted = false;
    let failure: unknown;
    const stopChild = (signal: NodeJS.Signals) => {
      if (!child || reaped) return;
      child.kill(signal);
      timer ??= setTimeout(() => {
        if (!reaped) child?.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const shutdown = () => {
      stopping = true;
      stopChild("SIGTERM");
    };
    const listeners = signals.map((signal) => {
      const listener = () => {
        if (signal === "SIGINT") interrupted = true;
        else {
          stopping = true;
          onTerminate(signal);
        }
        stopChild(signal);
      };
      process.on(signal, listener);
      return { signal, listener };
    });
    cancel = shutdown;
    renderer.on("destroy", shutdown);
    try {
      // Even a partially failed suspend needs exactly one recovery attempt.
      renderer.suspend();
      if (!stopping && !renderer.isDestroyed && !interrupted) {
        child = Bun.spawn([target.executable, target.file], {
          cwd: target.root,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        const code = await child.exited;
        reaped = true;
        if (!stopping && code !== 0)
          throw new Error(
            interrupted ? "Editor interrupted." : `Editor exited ${child.signalCode ?? code}.`,
          );
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (child && !reaped) {
          stopChild("SIGTERM");
          await child.exited;
          reaped = true;
        }
        if (stopping) renderer.destroy();
        else if (!renderer.isDestroyed) {
          try {
            renderer.resume();
          } catch (error) {
            renderer.destroy();
            failure = error;
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
        renderer.off("destroy", shutdown);
        for (const { signal, listener } of listeners) process.off(signal, listener);
        cancel = undefined;
      }
    }
    if (failure !== undefined) throw failure;
  }

  return {
    edit(request: EditRequest): Promise<void> {
      if (active) return Promise.reject(new Error("An editor is already active."));
      if (stopping || renderer.isDestroyed) return Promise.reject(new Error("TUI is closing."));
      active = run(request).finally(() => {
        active = undefined;
      });
      return active;
    },
    async shutdown(): Promise<void> {
      stopping = true;
      cancel?.();
      // App reports editor errors. Teardown still waits if runTui ended first.
      await active?.catch(() => {});
    },
  };
}
