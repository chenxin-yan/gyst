import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { DiffPayload, StatusPayload } from "@gyst/core";
import { App } from "./app.tsx";
import type { TuiClient } from "./client.ts";

function status(revision = 0, seq = revision, sessionId = "session"): StatusPayload {
  return {
    session: {
      id: sessionId,
      repoRoot: "/repo",
      source: { kind: "git", args: ["HEAD"], cwd: "/repo", patchHash: "snapshot" },
      createdAt: "now",
      updatedAt: "now",
    },
    revision,
    seq,
    cursor: { itemId: "group", pane: "queue", hunkId: `hunk-${revision}` },
    groups: [
      {
        id: "group",
        title: `review ${revision}`,
        notes: [{ hunkId: `hunk-${revision}`, text: `Intent and evidence ${revision}` }],
        hunkIds: [`hunk-${revision}`],
        count: 1,
        accepted: false,
      },
    ],
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
        patch: `@@ -1 +1 @@\n-before\n+TEXT_${revision}`,
      },
    ],
  };
}

const checked = (value = status()) => ({
  sessionId: value.session.id,
  revision: value.revision,
  state: "unchanged" as const,
  checkedAt: "now",
});

describe("TUI snapshot races", () => {
  for (const checkState of ["changed", "unavailable"] as const) {
    it(`shows ${checkState} source awareness without refreshing or changing review state`, async () => {
      let state = status();
      let refreshes = 0;
      const before = structuredClone(state);
      const client: TuiClient = {
        check: async () => ({
          ...checked(state),
          state: state.revision === 0 ? checkState : "unchanged",
        }),
        status: async () => structuredClone(state),
        diff: async () => diff(state.revision),
        action: async () => structuredClone(state),
        refresh: async () => {
          refreshes++;
          state = status(1);
          return state;
        },
      };
      const tui = await testRender(() => <App client={client} pollInterval={20} />, {
        width: 120,
        height: 30,
      });
      try {
        await tui.waitForFrame((frame) =>
          frame.includes(checkState === "changed" ? "source changed" : "source check unavailable"),
        );
        assert.deepEqual(state, before);
        assert.equal(refreshes, 0);
        await tui.mockInput.pressKey("r");
        await tui.waitForFrame(
          (frame) => frame.includes("review 1") && !frame.includes("snapshot unchanged"),
        );
        assert.equal(refreshes, 1);
      } finally {
        tui.renderer.destroy();
      }
    });
  }

  for (const replacement of [false, true]) {
    it(`ignores a delayed source check after ${replacement ? "session replacement" : "refresh"}`, async () => {
      let state = status();
      let checks = 0;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const client: TuiClient = {
        check: async () => {
          const captured = checked(state);
          if (++checks === 1) {
            started.resolve();
            await release.promise;
            return { ...captured, state: "changed" };
          }
          return captured;
        },
        status: async () => structuredClone(state),
        diff: async () => diff(state.revision, state.session.id),
        action: async () => structuredClone(state),
        refresh: async () => {
          state = status(1, 1, replacement ? "replacement" : "session");
          return state;
        },
      };
      const tui = await testRender(() => <App client={client} pollInterval={20} />, {
        width: 120,
        height: 30,
      });
      try {
        await started.promise;
        await tui.mockInput.pressKey("r");
        await tui.waitForFrame((frame) => frame.includes("review 1"));
        release.resolve();
        await tui.waitForFrame(() => checks === 2);
        await tui.renderOnce();
        assert(!tui.captureCharFrame().includes("source changed"));
      } finally {
        release.resolve();
        tui.renderer.destroy();
      }
    });
  }

  it("poll/action overlap retains a matching diff and newer cursor", async () => {
    let state = status();
    let reads = 0;
    let diffs = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client: TuiClient = {
      check: async () => checked(state),
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
          cursor: { itemId: "group", pane: "diff", hunkId: `hunk-${state.revision}` },
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
      await tui.waitForFrame((frame) => frame.includes("review 0"));
      await started.promise;
      await tui.mockInput.pressKey("RETURN");
      await tui.renderOnce();
      release.resolve();
      await tui.waitForFrame((frame) => frame.includes("TEXT_1") && frame.includes("▍diff"));
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  for (const to of ["diff", "queue"] as const) {
    const from = "diff";
    it(`does not retarget ${from} j/k to another shared ${to} view behind a poll`, async () => {
      let state: StatusPayload = {
        ...status(),
        cursor: { itemId: "group", pane: from, hunkId: "hunk-0" },
        groups: [
          status().groups[0]!,
          {
            ...status().groups[0]!,
            id: "other",
            title: "Other item",
            notes: [],
            hunkIds: ["other-1", "other-2"],
            count: 2,
          },
        ],
        queue: ["group", "other"],
      };
      let reads = 0;
      let actions = 0;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const client: TuiClient = {
        check: async () => checked(state),
        status: async () => {
          if (++reads === 2) {
            started.resolve();
            await release.promise;
          }
          return structuredClone(state);
        },
        diff: async () => ({
          ...diff(),
          hunks: [
            ...diff().hunks,
            ...["other-1", "other-2"].map((id) => ({ ...diff().hunks[0]!, id })),
          ],
        }),
        action: async () => {
          actions++;
          return structuredClone(state);
        },
        refresh: async () => structuredClone(state),
      };
      const tui = await testRender(() => <App client={client} pollInterval={20} />, {
        width: 120,
        height: 30,
      });
      try {
        await tui.waitForFrame((frame) => frame.includes(`▍${from}`));
        await started.promise;
        await tui.mockInput.pressKey("j");
        await tui.renderOnce();
        state = {
          ...state,
          seq: state.seq + 1,
          cursor: { itemId: "other", pane: to, hunkId: "other-1" },
        };
        release.resolve();
        await tui.waitForFrame((frame) => frame.includes("Other item") && reads >= 3);
        await tui.renderOnce();
        const pane = tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
        assert.equal(actions, 0, "a scroll key never becomes navigation on another item");
        assert.equal(pane.scrollTop, 0, "an old key never scrolls another item's diff");
      } finally {
        release.resolve();
        tui.renderer.destroy();
      }
    });
  }

  it("refresh requested during a poll is retained without repeated polling", async () => {
    let reads = 0;
    let refreshes = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client: TuiClient = {
      check: async () => checked(),
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
      await tui.waitForFrame((frame) => frame.includes("review 0"));
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
        check: async () => checked(state),
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
        await tui.waitForFrame((frame) => frame.includes("review 0"));
        await tui.mockInput.pressKey("r");
        await started.promise;
        release.resolve();
        await tui.waitForFrame((frame) => {
          assert(
            !frame.includes("no review items"),
            "never combine status with another diff revision/session",
          );
          return frame.includes("review 3");
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
      check: async () => checked(),
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
      await tui.waitForFrame((frame) => frame.includes("review 0"));
      await tui.mockInput.pressKey("r");
      const frame = await tui.waitForFrame((value) =>
        value.includes("refreshed; waiting for a coherent view"),
      );
      assert(frame.includes("review 0"), "the last coherent frame stays on screen");
      assert(!frame.includes("snapshot refreshed"));
    } finally {
      tui.renderer.destroy();
    }
  });

  it("older same-session action and poll statuses cannot roll back the view", async () => {
    let stale = false;
    const current = {
      ...status(1, 5),
      cursor: { itemId: "group", pane: "diff" as const, hunkId: "hunk-1" },
    };
    const client: TuiClient = {
      check: async () => checked(current),
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
      await tui.waitForFrame((frame) => frame.includes("▍diff"));
      await tui.mockInput.pressKey("ESCAPE");
      await Bun.sleep(60);
      await tui.renderOnce();
      assert(tui.captureCharFrame().includes("▍diff"));
    } finally {
      tui.renderer.destroy();
    }
  });
});
