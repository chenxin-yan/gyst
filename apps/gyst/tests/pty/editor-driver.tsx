// Real-terminal integration driver. Run through editor.py, never directly in a developer's terminal.
import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { runTui } from "@crustjs/tui";
import { destroyTreeSitterClient } from "@opentui/core";
import { render } from "@opentui/solid";
import { applyHumanAction, statusOf, type Session } from "@gyst/core";
import { Result } from "effect";
import { App } from "../../src/tui/app.tsx";
import { editorHandoff } from "../../src/tui/editor.ts";

const log = (event: string, data: object = {}) =>
  appendFileSync(
    process.env.GYST_PTY_LOG!,
    JSON.stringify({ event, raw: process.stdin.isRaw, ...data }) + "\n",
  );
const listeners = () =>
  ["SIGINT", "SIGTERM", "SIGQUIT", "SIGHUP", "SIGABRT", "SIGPIPE", "SIGBUS"].map((s) =>
    process.listenerCount(s),
  );
let state: Session = {
  formatVersion: 1,
  id: "pty",
  repoRoot: process.cwd(),
  createdAt: "now",
  updatedAt: "now",
  revision: 0,
  seq: 0,
  source:
    process.env.GYST_PTY_SOURCE === "stdin"
      ? { kind: "stdin" }
      : { kind: "git", args: ["HEAD"], cwd: process.cwd() },
  cursor: { itemId: "h", pane: "diff", hunkId: "h" },
  hunks: [
    {
      id: "h",
      file: "target with spaces.txt",
      header: "-1 +1",
      contentHash: "h",
      patch: "@@ -1 +1 @@\n-before\n+after",
      accepted: false,
      title: "Editor handoff",
      overview: "Working tree is separate from the snapshot.",
    },
  ],
  groups: [],
  queue: ["h"],
  queueSet: true,
  acceptHistory: [],
  receiptOverviews: [],
  applyReceipts: [],
};
let owner: ReturnType<typeof editorHandoff> | undefined;
let refreshes = 0;
let reads = 0;
const initialListeners = listeners();
try {
  await runTui(
    async (renderer) => {
      const handoff = (owner = editorHandoff(renderer, (signal) => {
        log("termination", { signal });
        process.exitCode = 128 + (constants.signals[signal] ?? 1);
      }));
      const suspend = renderer.suspend.bind(renderer);
      renderer.suspend = () => {
        suspend();
        log("suspended", { listeners: listeners() });
        if (process.env.GYST_PTY_MODE === "suspend") throw new Error("injected suspend failure");
      };
      const resume = renderer.resume.bind(renderer);
      renderer.resume = () => {
        log("resuming", { destroyed: renderer.isDestroyed });
        if (process.env.GYST_PTY_MODE === "resume") throw new Error("injected resume failure");
        resume();
        log("resumed");
      };
      const destroy = () => renderer.destroy();
      process.on("SIGUSR1", destroy);
      renderer.once("destroy", () => {
        process.off("SIGUSR1", destroy);
        log("destroyed");
      });
      await render(
        () => (
          <App
            pollInterval={20}
            client={{
              status: async () => {
                reads++;
                return statusOf(state);
              },
              diff: async () => ({
                formatVersion: 1,
                sessionId: state.id,
                revision: state.revision,
                hunks: state.hunks,
              }),
              refresh: async () => {
                refreshes++;
                return statusOf(state);
              },
              action: async (action) => {
                state = Result.getOrThrow(applyHumanAction(state, action, "now"));
                log("action", { action });
                return statusOf(state);
              },
            }}
            onEdit={async (request) => {
              const before = listeners();
              log("edit", { request, reads });
              try {
                await handoff.edit(request);
              } catch (error) {
                log("error", { message: String(error) });
                throw error;
              } finally {
                log("returned", {
                  reads,
                  before,
                  listeners: listeners(),
                  refreshes,
                  destroyed: renderer.isDestroyed,
                });
              }
            }}
            onQuit={(cancelled) => {
              log("quit", { cancelled });
              renderer.destroy();
            }}
          />
        ),
        renderer,
      );
      log("mounted");
    },
    { exitOnCtrlC: false },
  );
} finally {
  await owner?.shutdown();
  await destroyTreeSitterClient();
  log("finished", { refreshes, reads, initialListeners, listeners: listeners() });
}
