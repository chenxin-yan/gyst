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
    queueSet: false,
    ready: false,
    files: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, hunkCount: 1 })),
  };
  const diff: DiffPayload = {
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
      const next = structuredClone(status) as any;
      if (action.type === "cursor.move") {
        next.cursor = { itemId: action.itemId, expanded: false };
        next.seq++;
      }
      if (action.type === "expand.toggle") {
        next.cursor.expanded = !next.cursor.expanded;
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
  };
}

async function press(tui: Awaited<ReturnType<typeof testRender>>, key: string) {
  await tui.mockInput.pressKey(key);
  await tui.renderOnce();
  await Promise.resolve();
  await tui.renderOnce();
}

const state = fixture();
const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
  width: 100,
  height: 30,
});
await tui.waitForFrame((frame) => frame.includes("REVIEW QUEUE"));
let frame = tui.captureCharFrame();
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
tui.renderer.destroy();

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
assert.deepEqual(
  await waitingState.client.status(),
  waitingState.status(),
  "detach does not close session",
);
waitingTui.renderer.destroy();

const rapidState = fixture();
const rapidTui = await testRender(() => <App client={rapidState.client} pollInterval={60_000} />, {
  width: 100,
  height: 30,
});
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

const emptyState = fixture();
const empty = structuredClone(emptyState.status()) as any;
empty.session.source = { kind: "git", args: ["HEAD"] };
empty.groups = [];
empty.spotlight = [];
empty.inbox = [];
empty.queue = [];
empty.files = [];
empty.cursor = { itemId: null, expanded: false };
emptyState.setStatus(empty);
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
await press(emptyTui, "r");
assert.equal(emptyRefreshes, 1, "refresh works when the snapshot has no review items");
emptyTui.renderer.destroy();

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

console.log(
  "TUI smoke OK — attach/wait, serialized navigation, verdict/undo/reattach, exemplar, inbox guard, expand, sidebar, layouts, help, empty refresh, reset and mismatched sync",
);
process.exit(0);
