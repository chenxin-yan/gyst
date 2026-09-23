import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import type { DiffPayload, StatusPayload } from "@gyst/core";
import { App } from "./app.tsx";
import type { TuiClient } from "./client.ts";

function status(revision = 0, seq = revision, sessionId = "session"): StatusPayload {
  return {
    session: {
      id: sessionId,
      repoRoot: "/repo",
      source: { kind: "git", args: ["HEAD"], cwd: "/repo" },
      createdAt: "now",
      updatedAt: "now",
    },
    revision,
    seq,
    cursor: { itemId: "group", expanded: false },
    groups: [
      {
        id: "group",
        title: `review ${revision}`,
        overview: `Intent and evidence ${revision}`,
        hunkIds: [`hunk-${revision}`],
        count: 1,
        accepted: false,
      },
    ],
    spotlight: [],
    inbox: [],
    queue: ["group"],
    queueSet: true,
    ready: true,
    files: [{ path: "a.ts", hunkCount: 1 }],
  };
}
function diff(revision = 0, sessionId = "session"): DiffPayload {
  return {
    sessionId,
    revision,
    hunks: [
      {
        id: `hunk-${revision}`,
        file: "a.ts",
        header: "@@ -1 +1 @@",
        contentHash: `${revision}`,
        accepted: false,
        patch: `@@ -1 +1 @@\n-before\n+TEXT_${revision}`,
      },
    ],
  };
}

describe("TUI snapshot races", () => {
  it("poll/action overlap retains a matching diff and newer cursor", async () => {
    let state = status();
    let reads = 0;
    let diffs = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client: TuiClient = {
      status: async () => {
        if (++reads === 2) state = status(1);
        return structuredClone(state);
      },
      diff: async () => {
        if (++diffs === 2) {
          started.resolve();
          await release.promise;
        }
        return diff(state.revision);
      },
      action: async () => {
        state = {
          ...state,
          seq: state.seq + 1,
          cursor: { itemId: "group", expanded: true, hunkId: `hunk-${state.revision}` },
        };
        return structuredClone(state);
      },
      refresh: async () => structuredClone(state),
    };
    const tui = await testRender(() => <App client={client} pollInterval={20} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("TEXT_0"));
      await started.promise;
      await tui.mockInput.pressKey("RETURN");
      await tui.renderOnce();
      release.resolve();
      await tui.waitForFrame(
        (frame) => frame.includes("TEXT_1") && frame.includes("j/k to step, esc to leave"),
      );
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  it("refresh requested during a poll is retained without repeated polling", async () => {
    let reads = 0;
    let refreshes = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client: TuiClient = {
      status: async () => {
        if (++reads === 2) {
          started.resolve();
          await release.promise;
        }
        return status();
      },
      diff: async () => diff(),
      action: async () => status(),
      refresh: async () => {
        refreshes++;
        return status();
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={20} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("TEXT_0"));
      await started.promise;
      await tui.mockInput.pressKey("r");
      await tui.renderOnce();
      assert.equal(reads, 2, "blocked poll does not busy-wait");
      release.resolve();
      await tui.waitForFrame(() => refreshes === 1);
      assert.equal(refreshes, 1);
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  for (const replaceSession of [false, true]) {
    it(`refresh diff/status race stays coherent${replaceSession ? " across session replacement" : ""}`, async () => {
      let state = status();
      let diffReads = 0;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const client: TuiClient = {
        status: async () => structuredClone(state),
        diff: async () => {
          if (++diffReads === 2) {
            // Another harness refresh wins between independently requested snapshots.
            state = status(2);
            const captured = diff(2);
            started.resolve();
            await release.promise;
            state = status(3, 3, replaceSession ? "replacement" : "session");
            return captured;
          }
          return diff(state.revision, state.session.id);
        },
        refresh: async () => {
          state = status(1);
          return structuredClone(state);
        },
        action: async () => structuredClone(state),
      };
      const tui = await testRender(() => <App client={client} pollInterval={20} />, {
        width: 100,
        height: 30,
      });
      try {
        await tui.waitForFrame((frame) => frame.includes("TEXT_0"));
        await tui.mockInput.pressKey("r");
        await started.promise;
        release.resolve();
        await tui.waitForFrame((frame) => {
          assert(
            !frame.includes("no review items"),
            "never combine status with another diff revision/session",
          );
          return frame.includes("TEXT_3");
        });
        assert(diffReads >= 3, "retry uses actual cached diff identity, not status alone");
      } finally {
        release.resolve();
        tui.renderer.destroy();
      }
    });
  }

  it("refresh that finds no coherent frame says so instead of claiming success", async () => {
    // The refresh reply claims revision 1 while every other read still answers revision 0.
    const client: TuiClient = {
      status: async () => status(),
      diff: async () => diff(),
      refresh: async () => status(1),
      action: async () => status(),
    };
    const tui = await testRender(() => <App client={client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("TEXT_0"));
      await tui.mockInput.pressKey("r");
      const frame = await tui.waitForFrame((value) =>
        value.includes("refreshed; waiting for a coherent view"),
      );
      assert(frame.includes("TEXT_0"), "the last coherent frame stays on screen");
      assert(!frame.includes("snapshot refreshed"));
    } finally {
      tui.renderer.destroy();
    }
  });

  it("older same-session action and poll statuses cannot roll back the view", async () => {
    let stale = false;
    const current = {
      ...status(1, 5),
      cursor: { itemId: "group", expanded: true, hunkId: "hunk-1" },
    };
    const client: TuiClient = {
      status: async () => (stale ? status(1, 3) : current),
      diff: async () => diff(1),
      refresh: async () => current,
      action: async () => {
        stale = true;
        return status(1, 4);
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={20} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("j/k to step, esc to leave"));
      await tui.mockInput.pressKey("ESCAPE");
      await Bun.sleep(60);
      await tui.renderOnce();
      assert(tui.captureCharFrame().includes("j/k to step, esc to leave"));
    } finally {
      tui.renderer.destroy();
    }
  });
});
