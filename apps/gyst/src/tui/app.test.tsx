import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import type { DiffPayload, HumanAction, StatusPayload } from "@gyst/core";
import { App } from "./app.tsx";
import { TuiClientError, type TuiClient } from "./client.ts";

const patch = (file: string, from: string, to: string) => ({
  id: file,
  file,
  header: "-1 +1",
  contentHash: file,
  accepted: false,
  patch: `@@ -1 +1 @@\n-${from}\n+${to}`,
});

function fixture() {
  const actions: HumanAction[] = [];
  let status: StatusPayload = {
    session: {
      id: "session",
      repoRoot: "/repo",
      source: { kind: "stdin" },
      createdAt: "now",
      updatedAt: "now",
    },
    revision: 0,
    seq: 0,
    cursor: { itemId: "group", expanded: false },
    groups: [
      {
        id: "group",
        tldr: "rename old to new",
        exemplarHunkId: "a.ts",
        hunkIds: ["b.ts", "a.ts"],
        count: 2,
        accepted: false,
      },
    ],
    spotlight: [{ id: "c.ts", file: "c.ts", tldr: "cache behavior changed", accepted: false }],
    inbox: [{ id: "d.ts", file: "d.ts" }],
    queue: ["group", "c.ts"],
    // Finalized queue with an inbox item left: verdicts are allowed, the session is not yet ready.
    queueSet: true,
    ready: false,
    files: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, hunkCount: 1 })),
  };
  let diff: DiffPayload = {
    sessionId: "session",
    revision: 0,
    hunks: [
      patch("a.ts", "const old = 1", "const new = 1"),
      patch("b.ts", "old()", "new()"),
      patch("c.ts", "stale", "fresh"),
      patch("d.ts", "before", "after"),
    ],
  };
  const client: TuiClient = {
    status: async () => structuredClone(status),
    diff: async () => ({
      ...structuredClone(diff),
      sessionId: status.session.id,
      revision: status.revision,
    }),
    refresh: async () => structuredClone(status),
    action: async (action: HumanAction) => {
      actions.push(action);
      if (
        (action.type === "verdict.toggle" || action.type === "verdict.undo") &&
        (action.sessionId !== status.session.id || action.revision !== status.revision)
      )
        throw new TuiClientError({
          code: "stale_revision",
          message: "verdict targets a stale snapshot",
        });
      const next = structuredClone(status) as any;
      if (action.type === "cursor.move") {
        next.cursor = { itemId: action.itemId, expanded: false };
        next.seq++;
      }
      if (action.type === "expand.toggle") {
        next.cursor.expanded = !next.cursor.expanded;
        next.seq++;
      }
      if (action.type === "cursor.focus") {
        next.cursor =
          action.hunkId === null
            ? { itemId: next.cursor.itemId, expanded: next.cursor.expanded }
            : { itemId: next.cursor.itemId, expanded: true, hunkId: action.hunkId };
        next.seq++;
      }
      if (action.type === "verdict.toggle") {
        const item =
          next.groups.find((value: { id: string }) => value.id === action.itemId) ??
          next.spotlight.find((value: { id: string }) => value.id === action.itemId);
        item.accepted = !item.accepted;
        next.revision++;
        next.seq++;
      }
      if (action.type === "verdict.undo") {
        const item = [...next.groups, ...next.spotlight].findLast(
          (value: { accepted: boolean }) => value.accepted,
        );
        if (!item) throw new Error("nothing to undo");
        item.accepted = false;
        next.cursor = { itemId: item.id, expanded: false };
        next.revision++;
        next.seq++;
      }
      status = next;
      return structuredClone(status);
    },
  };
  return {
    client,
    actions,
    status: () => status,
    setStatus: (next: StatusPayload) => {
      status = next;
    },
    setDiff: (map: (hunk: DiffPayload["hunks"][number]) => DiffPayload["hunks"][number]) => {
      diff = { ...diff, hunks: diff.hunks.map(map) };
    },
  };
}

async function press(
  tui: Awaited<ReturnType<typeof testRender>>,
  key: string,
  modifiers?: { ctrl?: boolean },
) {
  await tui.mockInput.pressKey(key, modifiers);
  // A lone ESC is held back until the stdin parser's sequence timeout (20ms) rules out a longer sequence.
  if (key === "ESCAPE") await Bun.sleep(30);
  await tui.renderOnce();
  await Promise.resolve();
  await tui.renderOnce();
}

function emptyStatus(base: StatusPayload): StatusPayload {
  const empty = structuredClone(base) as any;
  empty.session.source = { kind: "git", args: ["HEAD"], cwd: "/repo" };
  empty.groups = [];
  empty.spotlight = [];
  empty.inbox = [];
  empty.queue = [];
  empty.files = [];
  empty.cursor = { itemId: null, expanded: false };
  return empty;
}

describe("TUI", () => {
  it("walks groups, verdicts, layouts, help, inbox guard and stale verdicts from the keyboard", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("REVIEW QUEUE"));
    let frame = tui.captureCharFrame();
    assert(frame.includes("  stdin"), "header names the stdin scope");
    assert(frame.includes("rename old to new"));
    assert(frame.includes("exemplar · 1 of 2"));
    assert(
      frame.includes("const old = 1"),
      "collapsed group renders the declared exemplar rather than its first member",
    );
    assert(frame.includes("! d.ts"), "inbox is visibly distinct");

    await press(tui, "e");
    assert(tui.captureCharFrame().includes("all 2 members"), "e expands a group");
    await press(tui, "e");
    assert(tui.captureCharFrame().includes("exemplar · 1 of 2"), "e folds a group");
    await press(tui, "a");
    frame = tui.captureCharFrame();
    assert(frame.includes("✓ accepted"));
    assert(frame.includes("exemplar · 1 of 2"), "accept does not advance");
    assert.equal(state.status().revision, 1, "verdict bumps revision");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "verdict.toggle", itemId: "group", sessionId: "session", revision: 0 },
      "verdict carries the frame seen at keypress",
    );
    const seqBeforeMove = state.status().seq;
    await press(tui, "j");
    assert(tui.captureCharFrame().includes("SPOTLIGHT"));
    assert.equal(state.status().seq, seqBeforeMove + 1, "cursor bumps seq once");
    await press(tui, "u");
    assert(tui.captureCharFrame().includes("exemplar · 1 of 2"), "undo returns to accepted item");
    assert(!tui.captureCharFrame().includes("✓ accepted"), "undo clears verdict");

    const paired = (value: string) =>
      value
        .split("\n")
        .some((line) => line.includes("const old = 1") && line.includes("const new = 1"));
    assert(!paired(tui.captureCharFrame()), "auto stacks at width 100");
    await press(tui, "1");
    assert(paired(tui.captureCharFrame()), "split pairs deletion/addition");
    await press(tui, "0");
    tui.resize(140, 30);
    await tui.renderOnce();
    assert(paired(tui.captureCharFrame()), "auto splits at width 140");
    await press(tui, "s");
    assert(!tui.captureCharFrame().includes("REVIEW QUEUE"), "s hides sidebar");
    await press(tui, "s");
    await press(tui, "?");
    assert(tui.captureCharFrame().includes("undo last accept"), "? opens help");
    assert(tui.captureCharFrame().includes("^d / ^u"), "help lists the scroll keys");
    await press(tui, "j");
    assert(tui.captureCharFrame().includes("undo last accept"), "help blocks navigation");
    await press(tui, "q");
    assert(!tui.captureCharFrame().includes("undo last accept"), "q closes help");
    await press(tui, "j");
    await press(tui, "j");
    assert(tui.captureCharFrame().includes("INBOX"));
    const actionsBeforeInboxAccept = state.actions.length;
    await press(tui, "a");
    assert.equal(
      state.actions.length,
      actionsBeforeInboxAccept,
      "inbox cannot dispatch a verdict action",
    );
    assert.equal(state.status().revision, 2, "inbox cannot receive a verdict");
    await press(tui, "r");
    assert(tui.captureCharFrame().includes("stdin session — refresh it from the harness"));

    // The harness moves the revision on without the TUI polling; the next verdict names the old frame.
    await press(tui, "k");
    await press(tui, "k");
    assert(tui.captureCharFrame().includes("▍GROUP"));
    const moved = structuredClone(state.status()) as any;
    moved.groups[0].tldr = "rename old to new (reworded)";
    moved.revision++;
    state.setStatus(moved);
    const actionsBeforeStale = state.actions.length;
    await press(tui, "a");
    await tui.waitForFrame((value) => value.includes("snapshot changed, re-read"));
    assert.equal(state.actions.length, actionsBeforeStale + 1, "stale verdict was sent once");
    assert(!state.status().groups[0]!.accepted, "stale verdict is not applied");
    assert(tui.captureCharFrame().includes("(reworded)"), "stale verdict re-syncs the view");
    tui.renderer.destroy();
  });

  it("enters the diff pane with Enter, steps a group's hunks with j/k, and leaves with Esc", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
    await press(tui, "RETURN");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", hunkId: "b.ts" },
      "Enter focuses the group's first member",
    );
    let frame = tui.captureCharFrame();
    assert(frame.includes("all 2 members"), "focusing a group expands it");
    assert(frame.includes("j/k to step, esc to leave"), "focused card names the pane keys");
    await press(tui, "j");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", hunkId: "a.ts" });
    await press(tui, "j");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", hunkId: "b.ts" }, "j wraps");
    await press(tui, "k");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", hunkId: "a.ts" },
      "k steps back",
    );
    assert(tui.captureCharFrame().includes("▍GROUP"), "stepping hunks keeps the item");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", hunkId: null });
    frame = tui.captureCharFrame();
    assert(frame.includes("all 2 members"), "leaving keeps the group expanded");
    assert(frame.includes("enter to step through"), "unfocused card offers Enter");
    await press(tui, "j");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.move", itemId: "c.ts" },
      "j moves items again",
    );
    await press(tui, "RETURN");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", hunkId: "c.ts" });
    const before = state.actions.length;
    await press(tui, "j");
    await press(tui, "k");
    assert.equal(state.actions.length, before, "a lone hunk has nothing to step through");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", hunkId: null });
    tui.renderer.destroy();
  });

  it("scrolls the focused member into view", async () => {
    const state = fixture();
    const longLines = Array.from({ length: 60 }, (_, index) => `+first_${index}`).join("\n");
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "b.ts" ? { ...hunk, patch: `@@ -1 +1,60 @@\n${longLines}` } : hunk,
          ),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
    await press(tui, "RETURN");
    await tui.waitForFrame((frame) => frame.includes("first_0"));
    assert(
      !tui.captureCharFrame().includes("const old = 1"),
      "the second member starts off-screen",
    );
    await press(tui, "j");
    await tui.waitForFrame((frame) => frame.includes("const old = 1"));
    await press(tui, "k");
    await tui.waitForFrame((frame) => frame.includes("first_0"));
    tui.renderer.destroy();
  });

  it("blocks verdict keys while the review queue is unset", async () => {
    // Verdict keys on an unfinalized queue never reach the daemon.
    const unreadyState = fixture();
    const unready = structuredClone(unreadyState.status()) as any;
    unready.queueSet = false;
    unreadyState.setStatus(unready);
    const unreadyTui = await testRender(
      () => <App client={unreadyState.client} pollInterval={60_000} />,
      { width: 100, height: 30 },
    );
    await unreadyTui.waitForFrame((value) => value.includes("▍GROUP"));
    await press(unreadyTui, "a");
    await press(unreadyTui, "u");
    assert(
      unreadyTui.captureCharFrame().includes("review queue is not set"),
      "unready session shows the verdict guard",
    );
    assert.equal(unreadyState.actions.length, 0, "unready session dispatches no verdict");
    await press(unreadyTui, "j");
    assert(unreadyTui.captureCharFrame().includes("SPOTLIGHT"), "navigation stays available");
    unreadyTui.renderer.destroy();
  });

  it("waits for a session, attaches when it appears and detaches on q", async () => {
    let available = false;
    let quit = false;
    const waitingState = fixture();
    const waiting: TuiClient = {
      ...waitingState.client,
      status: async () => {
        if (!available) throw new TuiClientError({ code: "no_session", message: "none" });
        return waitingState.client.status();
      },
    };
    const waitingTui = await testRender(
      () => (
        <App
          client={waiting}
          pollInterval={5}
          onQuit={() => {
            quit = true;
          }}
        />
      ),
      { width: 100, height: 30 },
    );
    await waitingTui.waitForFrame((value) => value.includes("no session for this repo — waiting…"));
    available = true;
    await Bun.sleep(15);
    await waitingTui.waitForFrame((value) => value.includes("REVIEW QUEUE"));
    await press(waitingTui, "q");
    assert(quit, "q detaches");
    waitingTui.renderer.destroy();
  });

  // Quitting drains the queued verdict before the renderer is destroyed; Ctrl+C reports a cancellation.
  for (const [cancel, label] of [
    [false, "q"],
    [true, "Ctrl+C"],
  ] as const) {
    it(`drains the queued verdict before ${label} quits`, async () => {
      const drainState = fixture();
      let release!: () => void;
      const slow: TuiClient = {
        ...drainState.client,
        action: async (action) => {
          await new Promise<void>((resolve) => (release = resolve));
          return drainState.client.action(action);
        },
      };
      let quitWith: boolean | undefined;
      const drainTui = await testRender(
        () => (
          <App
            client={slow}
            pollInterval={60_000}
            onQuit={(cancelled) => {
              quitWith = cancelled;
            }}
          />
        ),
        { width: 100, height: 30, exitOnCtrlC: false },
      );
      await drainTui.waitForFrame((value) => value.includes("▍GROUP"));
      drainTui.mockInput.pressKey("a");
      if (cancel) drainTui.mockInput.pressKey("c", { ctrl: true });
      else drainTui.mockInput.pressKey("q");
      drainTui.mockInput.pressKey("j");
      await Bun.sleep(5);
      assert.equal(quitWith, undefined, `${label} waits for the in-flight verdict`);
      release();
      await drainTui.waitFor(() => quitWith !== undefined);
      assert.equal(quitWith, cancel, `${label} reports cancellation=${cancel}`);
      assert(drainState.status().groups[0]!.accepted, `${label} landed the queued verdict`);
      assert.equal(drainState.actions.length, 1, `${label} admits no input after quit`);
      drainTui.renderer.destroy();
    });
  }

  it("derives each rapid navigation target after the prior action", async () => {
    const rapidState = fixture();
    const rapidTui = await testRender(
      () => <App client={rapidState.client} pollInterval={60_000} />,
      {
        width: 100,
        height: 30,
      },
    );
    await rapidTui.waitForFrame((value) => value.includes("▍GROUP"));
    await rapidTui.mockInput.pressKey("j");
    await rapidTui.mockInput.pressKey("j");
    await Bun.sleep(5);
    await rapidTui.renderOnce();
    assert(
      rapidTui.captureCharFrame().includes("INBOX"),
      "rapid navigation derives each target after the prior action",
    );
    rapidTui.renderer.destroy();
  });

  it("refreshes a snapshot with no review items and names the git scope", async () => {
    const emptyState = fixture();
    emptyState.setStatus(emptyStatus(emptyState.status()));
    let emptyRefreshes = 0;
    const emptyClient: TuiClient = {
      ...emptyState.client,
      refresh: async () => {
        emptyRefreshes++;
        return emptyState.client.status();
      },
    };
    const emptyTui = await testRender(() => <App client={emptyClient} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await emptyTui.waitForFrame((value) => value.includes("no review items"));
    assert(emptyTui.captureCharFrame().includes("  HEAD"), "header names the git scope");
    assert(
      !emptyTui.captureCharFrame().includes("review complete"),
      "an unready empty queue is not complete",
    );
    await press(emptyTui, "r");
    assert.equal(emptyRefreshes, 1, "refresh works when the snapshot has no review items");
    assert(emptyTui.captureCharFrame().includes("snapshot refreshed"), "coherent refresh confirms");
    emptyTui.renderer.destroy();
  });

  it("reports completion for a ready empty queue and names the bare scope", async () => {
    const readyEmptyState = fixture();
    const readyEmpty = emptyStatus(readyEmptyState.status()) as any;
    readyEmpty.session.source = {
      kind: "git",
      args: ["HEAD"],
      cwd: "/repo",
      includeUntracked: true,
    };
    readyEmpty.queueSet = true;
    readyEmpty.ready = true;
    readyEmptyState.setStatus(readyEmpty);
    const readyEmptyTui = await testRender(
      () => <App client={readyEmptyState.client} pollInterval={60_000} />,
      { width: 100, height: 30 },
    );
    await readyEmptyTui.waitForFrame((value) => value.includes("review complete — 0/0 accepted"));
    assert(
      readyEmptyTui.captureCharFrame().includes("  working tree"),
      "header names the bare scope",
    );
    readyEmptyTui.renderer.destroy();
  });

  it("scrolls a long spotlight with Ctrl+D/Ctrl+U and snaps back on the next item", async () => {
    // A long spotlight scrolls from the keyboard and snaps back to the top on the next item.
    const longState = fixture();
    const long = structuredClone(longState.status()) as any;
    long.cursor = { itemId: "c.ts", expanded: false };
    longState.setStatus(long);
    const longLines = Array.from({ length: 60 }, (_, index) => `+line_${index}`).join("\n");
    const longClient: TuiClient = {
      ...longState.client,
      diff: async () => {
        const value = await longState.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "c.ts" ? { ...hunk, patch: `@@ -1 +1,60 @@\n${longLines}` } : hunk,
          ),
        };
      },
    };
    const longTui = await testRender(() => <App client={longClient} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await longTui.waitForFrame((value) => value.includes("line_0"));
    assert(!longTui.captureCharFrame().includes("line_59"), "the tail starts off-screen");
    await press(longTui, "d", { ctrl: true });
    await longTui.waitForFrame((value) => !value.includes("line_0"));
    for (let presses = 0; presses < 5; presses++) await press(longTui, "d", { ctrl: true });
    await longTui.waitForFrame((value) => value.includes("line_59"));
    await press(longTui, "u", { ctrl: true });
    await longTui.waitForFrame((value) => !value.includes("line_59"));
    await press(longTui, "j");
    await press(longTui, "k");
    await longTui.waitForFrame((value) => value.includes("line_0"));
    await press(longTui, "\u001b[6~");
    await longTui.waitForFrame((value) => !value.includes("line_0"));
    await press(longTui, "\u001b[5~");
    await longTui.waitForFrame((value) => value.includes("line_0"));
    longTui.renderer.destroy();
  });

  it("wraps long diff lines instead of clipping them", async () => {
    const state = fixture();
    const tail = "TAIL_OF_A_VERY_LONG_LINE";
    const long = `+${"x".repeat(150)} ${tail}`;
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "c.ts" ? { ...hunk, patch: `@@ -1 +1 @@\n-short\n${long}` } : hunk,
          ),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
    await press(tui, "j");
    await tui.waitForFrame((frame) => frame.includes(tail));
    await press(tui, "1");
    await tui.waitForFrame((frame) => frame.includes(tail));
    tui.renderer.destroy();
  });

  it("re-renders a hunk whose line numbers moved under a preserved id", async () => {
    // refreshSession keeps a hunk's id when only its coordinates change; the view must follow the patch.
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
    await press(tui, "j");
    await tui.waitForFrame((frame) => frame.includes("SPOTLIGHT") && frame.includes("1 - stale"));
    const moved = structuredClone(state.status()) as any;
    moved.revision++;
    state.setStatus(moved);
    state.setDiff((hunk) =>
      hunk.id === "c.ts" ? { ...hunk, patch: "@@ -100 +100 @@\n-stale\n+fresh" } : hunk,
    );
    await tui.waitForFrame((frame) => frame.includes("100 - stale"));
    tui.renderer.destroy();
  });

  it("drops a verdict mark when the harness resets the group", async () => {
    const resetState = fixture();
    const accepted = structuredClone(resetState.status()) as any;
    accepted.groups[0].accepted = true;
    accepted.revision = 1;
    resetState.setStatus(accepted);
    const resetTui = await testRender(() => <App client={resetState.client} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    await resetTui.waitForFrame((value) => value.includes("✓ accepted"));
    const reset = structuredClone(resetState.status()) as any;
    reset.groups[0].accepted = false;
    reset.revision = 2;
    resetState.setStatus(reset);
    await Bun.sleep(15);
    await resetTui.waitForFrame((value) => !value.includes("✓ accepted"));
    resetTui.renderer.destroy();
  });

  it("keeps undo actionable after reattaching to an accepted item", async () => {
    const reattachedState = fixture();
    const reattached = structuredClone(reattachedState.status()) as any;
    reattached.groups[0].accepted = true;
    reattached.revision = 1;
    reattachedState.setStatus(reattached);
    const reattachedTui = await testRender(
      () => <App client={reattachedState.client} pollInterval={60_000} />,
      { width: 100, height: 30 },
    );
    await reattachedTui.waitForFrame((value) => value.includes("✓ accepted"));
    await press(reattachedTui, "u");
    assert(
      !reattachedTui.captureCharFrame().includes("✓ accepted"),
      "undo remains actionable after TUI reattachment",
    );
    reattachedTui.renderer.destroy();
  });

  it("omits groups whose members are missing from a mismatched diff", async () => {
    const mismatchedState = fixture();
    const mismatched = structuredClone(mismatchedState.status()) as any;
    mismatched.groups[0].hunkIds = ["missing-from-diff"];
    mismatched.groups[0].count = 1;
    mismatched.revision = 1;
    mismatchedState.setStatus(mismatched);
    const mismatchedTui = await testRender(
      () => <App client={mismatchedState.client} pollInterval={60_000} />,
      { width: 100, height: 30 },
    );
    await mismatchedTui.waitForFrame((value) => value.includes("SPOTLIGHT"));
    assert(
      !mismatchedTui.captureCharFrame().includes("▍GROUP"),
      "groups absent from a non-atomic diff read are omitted",
    );
    mismatchedTui.renderer.destroy();
  });
});
