import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import {
  applyHumanAction,
  statusOf,
  type DiffPayload,
  type HumanAction,
  type StatusPayload,
} from "@gyst/core";
import { Result } from "effect";
import type { ScrollBoxRenderable } from "@opentui/core";
import { App } from "./app.tsx";
import { TuiClientError, type TuiClient } from "./client.ts";

const patch = (file: string, from: string, to: string) => ({
  id: file,
  file,
  header: "-1 +1",
  contentHash: file,
  patch: `@@ -1 +1 @@\n-${from}\n+${to}`,
});

function fixture() {
  const actions: HumanAction[] = [];
  let acceptHistory: string[] = [];
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
    cursor: { itemId: "group", pane: "queue" },
    groups: [
      {
        id: "group",
        title: "rename old to new",
        overview: "Rename entry point and caller together.",
        hunkIds: ["b.ts", "a.ts"],
        count: 2,
        accepted: false,
      },
      {
        id: "cache",
        hunkIds: ["c.ts"],
        count: 1,
        title: "cache behavior changed",
        overview: "Refresh cached values.",
        accepted: false,
      },
    ],
    inbox: [{ id: "d.ts", file: "d.ts" }],
    queue: ["group", "cache"],
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
    check: async () => ({
      sessionId: status.session.id,
      revision: status.revision,
      state: "unchanged",
      checkedAt: "now",
    }),
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
      const next = Result.getOrThrow(
        applyHumanAction(
          {
            ...status.session,
            revision: status.revision,
            seq: status.seq,
            cursor: status.cursor,
            hunks: diff.hunks,
            groups: status.groups,
            queue: status.queue,
            queueSet: status.queueSet,
            acceptHistory,
            receiptOverviews: [],
            applyReceipts: [],
          },
          action,
          "now",
        ),
      );
      acceptHistory = [...next.acceptHistory];
      status = statusOf(next);
      return structuredClone(status);
    },
  };
  return {
    client,
    actions,
    status: () => status,
    setStatus: (next: StatusPayload) => {
      status = next;
      acceptHistory = next.groups.filter((item) => item.accepted).map((item) => item.id);
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

// Native Markdown waits for its asynchronous Tree-sitter styling before drawing prose.
async function markdownFrame(tui: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await tui.renderOnce();
    const frame = tui.captureCharFrame();
    if (frame.includes(text)) return frame;
    await Bun.sleep(10);
  }
  assert.fail(`Markdown did not render ${text}:\n${tui.captureCharFrame()}`);
}

// The group list shows only while browsing; reading replaces it with the diff.
const browsing = (tui: Awaited<ReturnType<typeof testRender>>) =>
  (tui.renderer.root.findDescendantById("group-list") as ScrollBoxRenderable | undefined)
    ?.visible === true;

function emptyStatus(base: StatusPayload): StatusPayload {
  const empty = structuredClone(base) as any;
  empty.session.source = { kind: "git", args: ["HEAD"], cwd: "/repo", patchHash: "snapshot" };
  empty.groups = [];
  empty.inbox = [];
  empty.queue = [];
  empty.files = [];
  empty.cursor = { itemId: null, pane: "queue" };
  return empty;
}

describe("TUI", () => {
  it("captures the editor target, gates every input and poll, and recovers without refreshing", async () => {
    const state = fixture();
    let reads = 0;
    let refreshes = 0;
    let quits = 0;
    const requests: unknown[] = [];
    const release = Promise.withResolvers<void>();
    const client: TuiClient = {
      ...state.client,
      status: async () => {
        reads++;
        return state.client.status();
      },
      refresh: async () => {
        refreshes++;
        return state.client.refresh();
      },
    };
    const tui = await testRender(
      () => (
        <App
          client={client}
          pollInterval={5}
          onQuit={() => {
            quits++;
          }}
          onEdit={async (request) => {
            requests.push(request);
            await release.promise;
            throw new Error("editor failed");
          }}
        />
      ),
      { width: 120, height: 30, exitOnCtrlC: false },
    );
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "o");
      assert.equal(requests.length, 0, "browse does not edit");
      await press(tui, "RETURN");
      await press(tui, "TAB");
      await press(tui, "o");
      await tui.waitFor(() => requests.length === 1);
      assert.deepEqual(requests[0], {
        sessionId: "session",
        revision: 0,
        repoRoot: "/repo",
        file: "b.ts",
        cursor: { itemId: "group", pane: "overview", hunkId: "b.ts" },
      });
      const before = reads;
      for (const key of ["o", "j", "a", "u", "r", "?", "1", "TAB", "q"]) await press(tui, key);
      await press(tui, "c", { ctrl: true });
      await press(tui, "d", { ctrl: true });
      await Bun.sleep(25);
      assert.equal(reads, before, "polling is gated throughout the callback");
      assert.equal(quits, 0);
      assert.equal(requests.length, 1);
      assert.equal(state.actions.length, 2);
      release.resolve();
      await tui.waitForFrame((frame) => frame.includes("editor failed"));
      await Bun.sleep(25);
      await tui.renderOnce();
      assert(tui.captureCharFrame().includes("harness"), "stdin guidance survives polls");
      assert.equal(refreshes, 0);
      await press(tui, "ESCAPE");
      await press(tui, "j");
      assert.equal(state.status().cursor.itemId, "cache", "rejection did not poison inputs");
      await press(tui, "q");
      assert.equal(quits, 1);
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  it("does not retarget an edit queued behind navigation, and synchronizes a successful return", async () => {
    const state = fixture();
    state.setStatus({
      ...state.status(),
      cursor: { itemId: "group", pane: "diff", hunkId: "b.ts" },
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: string[] = [];
    let refreshes = 0;
    let delay = true;
    const client: TuiClient = {
      ...state.client,
      action: async (action) => {
        if (delay) {
          delay = false;
          started.resolve();
          await release.promise;
        }
        return state.client.action(action);
      },
      refresh: async () => {
        refreshes++;
        return state.client.refresh();
      },
    };
    const tui = await testRender(
      () => (
        <App
          client={client}
          pollInterval={60_000}
          onEdit={async (request) => {
            requests.push(request.file);
            const next = structuredClone(state.status()) as any;
            next.groups[0].title = "Updated while editing";
            next.revision++;
            next.seq++;
            state.setStatus(next);
          }}
        />
      ),
      { width: 120, height: 30 },
    );
    try {
      await tui.waitForFrame((frame) => frame.includes("▍diff"));
      await tui.mockInput.pressKey("]");
      await started.promise;
      await press(tui, "o");
      release.resolve();
      await tui.waitForFrame((frame) => frame.includes("edit target changed"));
      assert.deepEqual(requests, []);
      await press(tui, "o");
      await tui.waitForFrame((frame) => frame.includes("Updated while editing"));
      assert.deepEqual(requests, ["a.ts"]);
      assert.equal(refreshes, 0);
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  for (const change of ["session", "revision", "cursor"] as const) {
    it(`rejects an editor target when shared ${change} changes before dequeue`, async () => {
      const state = fixture();
      state.setStatus({
        ...state.status(),
        cursor: { itemId: "group", pane: "diff", hunkId: "b.ts" },
      });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      let edits = 0;
      const client: TuiClient = {
        ...state.client,
        status: async () => {
          if (++reads === 2) {
            started.resolve();
            await release.promise;
          }
          return state.client.status();
        },
      };
      const tui = await testRender(
        () => (
          <App
            client={client}
            pollInterval={5}
            onEdit={async () => {
              edits++;
            }}
          />
        ),
        { width: 120, height: 30 },
      );
      try {
        await tui.waitForFrame((frame) => frame.includes("▍diff"));
        await started.promise;
        await press(tui, "o");
        const next = structuredClone(state.status()) as any;
        if (change === "session") next.session.id = "replacement";
        if (change === "revision") {
          next.revision++;
          next.seq++;
        }
        if (change === "cursor") {
          next.cursor.hunkId = "a.ts";
          next.seq++;
        }
        state.setStatus(next);
        release.resolve();
        await tui.waitForFrame((frame) => frame.includes("edit target changed"));
        assert.equal(edits, 0, "must not edit either stale or newly selected file");
      } finally {
        release.resolve();
        tui.renderer.destroy();
      }
    });
  }

  it("walks groups, verdicts, layouts, help, inbox guard and stale verdicts from the keyboard", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("rename old to new"));
    let frame = tui.captureCharFrame();
    assert(browsing(tui));
    assert(frame.split("\n")[0]!.startsWith(" stdin"), "browse header names the scope, once");
    assert.equal(
      (frame.match(/stdin/g) ?? []).length,
      2,
      "scope in the header and the source notice only",
    );
    assert(frame.includes("enter review · ? help"), "browse hint");
    assert(frame.includes("· rename old to new") && frame.includes("· cache behavior changed"));
    assert(frame.includes("1/3 · 0/2 done"), "header shows position and progress");
    assert(!frame.includes("GROUP") && !frame.includes("QUEUE"), "no chrome labels");
    assert(!frame.includes("old()"), "narrow browse shows the list, not the diff");
    assert(!frame.includes("Rename entry point"), "narrow browse has no room for the overview");
    assert(frame.includes("! d.ts"), "inbox is visibly distinct");

    await press(tui, "e");
    assert.equal(state.actions.length, 0, "fold control is removed");
    await press(tui, "a");
    frame = tui.captureCharFrame();
    assert(frame.includes("✓ rename"));
    assert(frame.includes("1/2 done"));
    assert(frame.includes("cache behavior changed"), "accept advances atomically");
    assert.equal(state.status().revision, 1, "verdict bumps revision");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "verdict.toggle", itemId: "group", sessionId: "session", revision: 0 },
      "verdict carries the frame seen at keypress",
    );
    const seqBeforeMove = state.status().seq;
    await press(tui, "j");
    assert.equal(state.status().cursor.itemId, "d.ts");
    assert(tui.captureCharFrame().includes("! d.ts"));
    assert.equal(state.status().seq, seqBeforeMove + 1, "cursor bumps seq once");
    await press(tui, "u");
    assert(
      tui.captureCharFrame().includes("· rename old to new"),
      "undo returns to the item and clears its verdict",
    );
    assert(!tui.captureCharFrame().includes("✓ rename"), "undo clears verdict");

    await press(tui, "RETURN");
    assert(!browsing(tui), "Enter replaces the list with the diff");
    frame = tui.captureCharFrame();
    assert(
      frame.includes("const old = 1") && frame.includes("old()"),
      "all members render in publication order",
    );
    assert(frame.indexOf("old()") < frame.indexOf("const old = 1"));
    assert(frame.includes("hunk 1/2"), "header shows the hunk position");
    const paired = (value: string) =>
      value
        .split("\n")
        .some((line) => line.includes("const old = 1") && line.includes("const new = 1"));
    assert(!paired(tui.captureCharFrame()), "auto stacks at width 100");
    await press(tui, "1");
    assert(paired(tui.captureCharFrame()), "split pairs deletion/addition");
    await press(tui, "0");
    tui.resize(240, 30);
    await tui.renderOnce();
    await tui.renderOnce();
    assert(paired(tui.captureCharFrame()), "auto splits when the diff pane has 120 columns");
    await press(tui, "s");
    assert(!browsing(tui) && paired(tui.captureCharFrame()), "obsolete s is inert");
    await press(tui, "?");
    assert(tui.captureCharFrame().includes("undo the last verdict"), "? opens help");
    assert(tui.captureCharFrame().includes("^d / ^u"), "help lists the scroll keys");
    assert(tui.captureCharFrame().includes("[ / ]"), "help lists the hunk keys");
    await press(tui, "j");
    assert(tui.captureCharFrame().includes("undo the last verdict"), "help blocks navigation");
    await press(tui, "q");
    assert(!tui.captureCharFrame().includes("undo the last verdict"), "q closes help");
    await press(tui, "ESCAPE");
    assert(browsing(tui), "Esc returns to the list");
    await press(tui, "j");
    await press(tui, "j");
    assert.equal(state.status().cursor.itemId, "d.ts");
    await press(tui, "RETURN");
    assert(
      tui.captureCharFrame().includes("d.ts · unprepared"),
      "reading header names the inbox hunk",
    );
    assert(tui.captureCharFrame().includes("no verdict (inbox) · tab pane · ? help"), "inbox hint");
    await press(tui, "TAB");
    await markdownFrame(tui, "Unprepared hunk");
    assert.deepEqual(state.status().cursor, { itemId: "d.ts", pane: "overview", hunkId: "d.ts" });
    const actionsBeforeInboxAccept = state.actions.length;
    await press(tui, "a");
    assert.equal(
      state.actions.length,
      actionsBeforeInboxAccept,
      "inbox cannot dispatch a verdict action",
    );
    assert.equal(state.status().revision, 2, "inbox cannot receive a verdict");
    await press(tui, "ESCAPE");
    await press(tui, "r");
    assert(tui.captureCharFrame().includes("stdin session — refresh it from the harness"));

    // The harness moves the revision on without the TUI polling; the next verdict names the old frame.
    await press(tui, "k");
    await press(tui, "k");
    assert(tui.captureCharFrame().includes(" rename old to new "));
    const moved = structuredClone(state.status()) as any;
    moved.groups[0].title = "rename old to new (reworded)";
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

  it("opens the diff with Enter, jumps hunks with [ / ], groups with p / n, and leaves with Esc", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("rename old to new"));
    await press(tui, "]");
    await press(tui, "TAB");
    assert.equal(state.actions.length, 0, "hunk and pane keys are inert while browsing");
    await press(tui, "RETURN");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "b.ts" },
      "Enter focuses the group's first member",
    );
    let frame = tui.captureCharFrame();
    assert(frame.includes("old()") && frame.includes("const old = 1"), "all members render");
    assert(frame.includes("▍diff") && !frame.includes("j/k to step"), "no instruction chrome");
    await press(tui, "]");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "group",
      pane: "diff",
      hunkId: "a.ts",
    });
    assert(tui.captureCharFrame().includes("hunk 2/2"));
    await press(tui, "]");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "b.ts" },
      "] wraps",
    );
    await press(tui, "[");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "a.ts" },
      "[ steps back",
    );
    assert(tui.captureCharFrame().includes(" rename old to new "), "stepping hunks keeps the item");
    const revisionBefore = state.status().revision;
    await press(tui, "n");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "cache", pane: "diff", hunkId: "c.ts" },
      "n opens the next group without a verdict",
    );
    await press(tui, "p");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "b.ts" },
      "p returns to the previous group's first hunk",
    );
    assert.equal(state.status().revision, revisionBefore, "navigation never verdicts");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "group",
      pane: "queue",
    });
    assert(browsing(tui), "leaving shows the list");
    await press(tui, "j");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.move", itemId: "cache" },
      "j moves items again",
    );
    await press(tui, "RETURN");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "cache",
      pane: "diff",
      hunkId: "c.ts",
    });
    const before = state.actions.length;
    await press(tui, "]");
    await press(tui, "[");
    assert.equal(state.actions.length, before, "a lone hunk has nothing to step through");
    frame = tui.captureCharFrame();
    assert(!frame.includes("hunk 1/1"), "a lone hunk shows no hunk position");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "cache",
      pane: "queue",
    });
    tui.renderer.destroy();
  });

  for (const width of [80, 120, 200]) {
    it(`zooms, switches panes and preserves independent scrolling at ${width} columns and on resize`, async () => {
      const state = fixture();
      const next = structuredClone(state.status()) as any;
      next.groups[0].overview =
        "# Intent\n\n" +
        Array.from({ length: 80 }, (_, i) => `Paragraph ${i} explains this change.\n`).join("\n");
      state.setStatus(next);
      const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={5} />, {
        width,
        height: 30,
      });
      const pane = (id: string) => tui.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
      try {
        await tui.waitForFrame((frame) => frame.includes("rename old to new"));
        assert(browsing(tui) && !tui.captureCharFrame().includes("first_0"));
        if (width >= 120) await markdownFrame(tui, "Intent");
        else assert(!tui.captureCharFrame().includes("Intent"), "narrow browse is the list");
        await press(tui, "TAB");
        assert.equal(state.actions.length, 0, "Tab in the list is inert");
        await press(tui, "RETURN");
        await tui.waitForFrame((frame) => frame.includes("▍diff") && frame.includes("first_0"));
        assert(!browsing(tui));
        if (width >= 120) await markdownFrame(tui, "Intent");
        else assert(!tui.captureCharFrame().includes("Intent"));
        await press(tui, "d", { ctrl: true });
        const diffTop = pane("diff-pane").scrollTop;
        assert(diffTop > 0);
        assert(
          tui.captureCharFrame().split("\n")[0]!.startsWith(" rename old to new "),
          "scrolling cannot paint over the compact header",
        );
        await press(tui, "TAB");
        await tui.waitForFrame((frame) => frame.includes("▍overview"));
        assert.deepEqual(state.status().cursor, {
          itemId: "group",
          pane: "overview",
          hunkId: "b.ts",
        });
        const markdown = pane("overview-pane").findDescendantById("overview-markdown");
        await press(tui, "j");
        assert.equal(pane("overview-pane").scrollTop, 1);
        await press(tui, "k");
        assert.equal(pane("overview-pane").scrollTop, 0);
        await press(tui, "d", { ctrl: true });
        const overviewTop = pane("overview-pane").scrollTop;
        assert(overviewTop > 0);
        await press(tui, "\u001b[Z"); // Shift+Tab
        assert.equal(state.status().cursor.pane, "diff");
        assert.equal(pane("diff-pane").scrollTop, diffTop, "Tab does not reveal the hunk again");
        await press(tui, "TAB");
        assert.equal(pane("overview-pane").scrollTop, overviewTop);
        await Bun.sleep(35);
        await tui.renderOnce();
        assert.equal(pane("overview-pane").scrollTop, overviewTop, "poll keeps overview scroll");
        assert.equal(
          pane("overview-pane").findDescendantById("overview-markdown"),
          markdown,
          "poll retains Markdown identity",
        );
        const published = structuredClone(state.status()) as any;
        published.groups.push({
          id: "arrival",
          hunkIds: ["d.ts"],
          count: 1,
          title: "Arrival",
          overview: "Complete item",
          accepted: false,
        });
        published.inbox = [];
        published.queue.push("arrival");
        published.revision++;
        published.seq++;
        published.ready = true;
        state.setStatus(published);
        await Bun.sleep(15);
        await tui.waitForFrame((frame) => frame.includes("0/3 done"));
        assert(
          !tui.captureCharFrame().includes("awaiting preparation"),
          "an empty inbox needs no readiness line",
        );
        assert.equal(state.status().cursor.pane, "overview");
        assert.equal(pane("overview-pane").scrollTop, overviewTop);
        assert.equal(pane("diff-pane").scrollTop, diffTop);
        for (const columns of [200, 80, 120]) {
          tui.resize(columns, 30);
          await tui.renderOnce();
          await tui.renderOnce();
          assert.equal(state.status().cursor.pane, "overview");
          assert.equal(pane("overview-pane").scrollTop, overviewTop);
          assert(!browsing(tui));
        }
        await press(tui, "z");
        assert(!pane("diff-pane").visible, "z expands the focused overview");
        assert.equal(pane("overview-pane").scrollTop, overviewTop, "expansion keeps the position");
        await press(tui, "ESCAPE");
        assert(!browsing(tui), "Esc restores the split before leaving");
        assert(pane("diff-pane").visible);
        assert.equal(pane("overview-pane").scrollTop, overviewTop, "restoring keeps the position");
        assert.equal(pane("diff-pane").scrollTop, diffTop, "the hidden pane keeps its position");
        await press(tui, "ESCAPE");
        assert(browsing(tui));
        assert(!tui.captureCharFrame().includes("first_"), "the list replaces the diff");
        await press(tui, "RETURN");
        assert.equal(state.status().cursor.hunkId, "b.ts");
        assert.equal(pane("overview-pane").scrollTop, 0);
      } finally {
        tui.renderer.destroy();
      }
    });
  }

  it("uses actual diff width for automatic split, including resize while zoomed", async () => {
    const errors = spyOn(console, "error");
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 200,
      height: 30,
    });
    const paired = () =>
      tui
        .captureCharFrame()
        .split("\n")
        .some((line) => line.includes("const old = 1") && line.includes("const new = 1"));
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("const old = 1"));
      assert(!paired(), "200-column reading diff is less than 120 usable columns");
      await press(tui, "1");
      assert(paired(), "explicit split overrides narrow pane");
      await press(tui, "2");
      assert(!paired());
      await press(tui, "0");
      tui.resize(240, 30);
      await tui.waitForFrame(() => paired());
      tui.resize(120, 30);
      await tui.waitForFrame(() => !paired());
      tui.resize(130, 30);
      await tui.renderOnce();
      await tui.renderOnce();
      assert(!paired(), "a 130-column split pane is still narrow");
      await press(tui, "z");
      await tui.waitForFrame(() => paired()); // expanding the diff to full width splits it
      await press(tui, "z");
      await tui.waitForFrame(() => !paired());
      const finiteGeometry = (node: any) => {
        if (typeof node.width === "number") assert(Number.isFinite(node.width), node.id);
        if (typeof node.height === "number") assert(Number.isFinite(node.height), node.id);
        for (const child of node.getChildren()) finiteGeometry(child);
      };
      for (const width of [80, 120, 200, 240, 80, 200]) {
        tui.resize(width, 30);
        await tui.renderOnce();
        finiteGeometry(tui.renderer.root);
        await tui.renderOnce();
        finiteGeometry(tui.renderer.root);
      }
      assert.equal(errors.mock.calls.length, 0, "renderer must not swallow a geometry/FFI error");
    } finally {
      tui.renderer.destroy();
      errors.mockRestore();
    }
  });

  it("keeps queued verdicts on the seen item and never retargets a delayed acceptance", async () => {
    const state = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delay = true;
    const client: TuiClient = {
      ...state.client,
      action: async (action) => {
        if (delay && action.type === "verdict.toggle") {
          delay = false;
          started.resolve();
          await release.promise;
        }
        return state.client.action(action);
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={60_000} />, {
      width: 120,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await tui.mockInput.pressKey("a");
      await started.promise;
      await tui.mockInput.pressKey("a");
      // Another TUI moved only the shared cursor: the verdict revision remains valid.
      const moved = structuredClone(state.status());
      state.setStatus({
        ...moved,
        seq: moved.seq + 1,
        cursor: { itemId: "cache", pane: "overview", hunkId: "c.ts" },
      });
      release.resolve();
      await tui.waitForFrame((frame) => frame.includes("snapshot changed, re-read"));
      assert(state.status().groups[0]!.accepted);
      assert(!state.status().groups[1]!.accepted, "unseen destination cannot be accepted");
      assert.deepEqual(state.status().cursor, {
        itemId: "cache",
        pane: "overview",
        hunkId: "c.ts",
      });
      assert.deepEqual(
        state.actions.map((action) => action.type === "verdict.toggle" && action.itemId),
        ["group", "group"],
      );
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  it("resets both panes for a replacement session with the same item ids", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].overview = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}\n`).join("\n");
    state.setStatus(next);
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={5} />, {
      width: 120,
      height: 30,
    });
    const pane = (id: string) => tui.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await markdownFrame(tui, "Paragraph 0");
      await press(tui, "d", { ctrl: true });
      await press(tui, "TAB");
      await press(tui, "d", { ctrl: true });
      assert(pane("diff-pane").scrollTop > 0 && pane("overview-pane").scrollTop > 0);
      const oldMarkdown = pane("overview-pane").findDescendantById("overview-markdown");
      const replacement = structuredClone(state.status()) as any;
      replacement.session.id = "replacement";
      replacement.groups[0].title = "Replacement session";
      state.setStatus(replacement);
      await Bun.sleep(15);
      await tui.waitForFrame((frame) => frame.includes("Replacement session"));
      assert.equal(pane("overview-pane").scrollTop, 0);
      assert(
        pane("diff-pane").scrollTop < 10,
        "new session reveals first hunk, not old scroll target",
      );
      assert.notEqual(pane("overview-pane").findDescendantById("overview-markdown"), oldMarkdown);
    } finally {
      tui.renderer.destroy();
    }
  });

  it("renders sanitized native Markdown and source fences, with long content reachable", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].overview =
      "# Intent\n\n- **Behavior** and *evidence* with `inline` code\n- [Reference](https://example.invalid)\n\n| Before | After |\n| --- | --- |\n| old | new |\n\n```typescript\nconst value = 1;\n```\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n" +
      "long ".repeat(100) +
      "END_OF_PROSE\n\n```text\n" +
      "code ".repeat(100) +
      "END_OF_CODE\n```\n\n\u001b[2JSAFE\u0007";
    state.setStatus(next);
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 80,
      height: 40,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await press(tui, "TAB");
      const first = await markdownFrame(tui, "Intent");
      for (const text of [
        "Intent",
        "Behavior",
        "Reference",
        "Before",
        "After",
        "const value",
        "graph LR",
        "A --> B",
      ])
        assert(first.includes(text), text);
      let seen = first;
      for (let i = 0; i < 12; i++) {
        await press(tui, "d", { ctrl: true });
        seen += tui.captureCharFrame();
      }
      assert(seen.includes("END_OF_PROSE"));
      assert(seen.includes("END_OF_CODE"));
      assert(seen.includes("SAFE"));
      assert(!seen.includes("\u001b"));
    } finally {
      tui.renderer.destroy();
    }
  });

  it("retains zoom and the current view on completion, without jumping to later arrivals", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={state.client} pollInterval={5} />, {
      width: 120,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await press(tui, "TAB");
      await press(tui, "a");
      assert.deepEqual(state.status().cursor, { itemId: "cache", pane: "diff", hunkId: "c.ts" });
      await press(tui, "TAB");
      await press(tui, "a");
      assert.equal(state.status().cursor.pane, "overview");
      assert(tui.captureCharFrame().includes("reviewed everything prepared so far"));
      await markdownFrame(tui, "Refresh cached values");
      const next = structuredClone(state.status()) as any;
      next.groups.push({
        id: "arrival",
        hunkIds: ["d.ts"],
        count: 1,
        title: "Arrival",
        overview: "New item",
        accepted: false,
      });
      next.inbox = [];
      next.queue.push("arrival");
      next.revision++;
      next.seq++;
      next.ready = true;
      state.setStatus(next);
      await Bun.sleep(15);
      await tui.waitForFrame((frame) => frame.includes("2/3 done"));
      assert(!tui.captureCharFrame().includes("awaiting preparation"));
      assert.equal(state.status().cursor.itemId, "cache");
      assert.equal(state.status().cursor.pane, "overview");
      await press(tui, "ESCAPE");
      await press(tui, "j");
      await press(tui, "RETURN");
      await press(tui, "a");
      assert(tui.captureCharFrame().includes("review complete \u2014 3/3 done"));
      await markdownFrame(tui, "New item");
      assert(!browsing(tui));
      await press(tui, "u");
      assert.equal(state.status().cursor.pane, "diff");
      assert(!tui.captureCharFrame().includes("review complete"));
    } finally {
      tui.renderer.destroy();
    }
  });

  // The group's first member is 60 lines, so its second member starts below the viewport.
  function tallGroup(state: ReturnType<typeof fixture>): TuiClient {
    const longLines = Array.from({ length: 60 }, (_, index) => `+first_${index}`).join("\n");
    return {
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
  }

  it("gives a long hunk the whole diff pane height on a tall terminal", async () => {
    // The ScrollBox root must keep OpenTUI's row layout: a column root parks the vertical scrollbar
    // below the viewport, shortening it and leaving blank rows above the footer.
    const state = fixture();
    const focused = structuredClone(state.status()) as any;
    focused.cursor = { itemId: "cache", pane: "diff", hunkId: "c.ts" };
    state.setStatus(focused);
    const lines = Array.from({ length: 263 }, (_, i) => `+export const line_${i} = ${i};`).join(
      "\n",
    );
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "c.ts" ? { ...hunk, patch: `@@ -0,0 +1,263 @@\n${lines}` } : hunk,
          ),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={60_000} />, {
      width: 200,
      height: 60,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("line_0"));
      await tui.renderOnce();
      const pane = tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
      // The pane's only chrome is its one-row caption border.
      assert.equal(pane.viewport.height, pane.height - 1, "viewport spans the pane");
      assert.equal(pane.verticalScrollBar.height, pane.viewport.height, "scrollbar is beside");
      const rows = tui.captureCharFrame().split("\n");
      const last = rows.findLastIndex((row) => row.includes("line_"));
      const footer = rows.findIndex((row, index) => index > last && row.trim().length > 0);
      assert.equal(
        footer,
        last + 1,
        `blank rows between the diff and the footer:\n${rows.join("\n")}`,
      );
      assert(rows.filter((row) => row.includes("line_")).length >= pane.height - 4);
    } finally {
      tui.renderer.destroy();
    }
  });

  it("scrolls the focused member into view", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("rename old to new"));
    await press(tui, "RETURN");
    await tui.waitForFrame((frame) => frame.includes("first_0"));
    assert(
      !tui.captureCharFrame().includes("const old = 1"),
      "the second member starts off-screen",
    );
    await press(tui, "]");
    await tui.waitForFrame((frame) => frame.includes("const old = 1"));
    await press(tui, "[");
    await tui.waitForFrame((frame) => frame.includes("first_0"));
    tui.renderer.destroy();
  });

  it("moves the shared focus to the hunk heading the viewport while scrolling, without snapping", async () => {
    const state = fixture();
    // Both members are taller than the viewport, so either can head it.
    const tall = (prefix: string) =>
      `@@ -1 +1,60 @@\n${Array.from({ length: 60 }, (_, i) => `+${prefix}_${i}`).join("\n")}`;
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "b.ts"
              ? { ...hunk, patch: tall("first") }
              : hunk.id === "a.ts"
                ? { ...hunk, patch: tall("second") }
                : hunk,
          ),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    const settled = async () => {
      for (let i = 0; i < 6; i++) {
        await tui.renderOnce();
        await Bun.sleep(10);
      }
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      // j scrolls one line; the 60-line first member still heads the viewport.
      for (let i = 0; i < 5; i++) await press(tui, "j");
      await settled();
      assert.equal(pane().scrollTop, 5);
      assert.equal(state.status().cursor.hunkId, "b.ts");
      assert.equal(state.status().revision, 0, "scrolling never verdicts");
      // Scroll past the first member: the second heads the viewport and becomes the shared focus.
      for (let i = 0; i < 6; i++) await press(tui, "d", { ctrl: true });
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settled();
      const top = pane().scrollTop;
      assert(top > 60, `viewport stays where the human scrolled (${top})`);
      assert(tui.captureCharFrame().includes("hunk 2/2"), "header follows the focus");
      assert(!tui.captureCharFrame().includes("▌a.ts"), "the heading scrolled off; no snap back");
      await Bun.sleep(40);
      await settled();
      assert.equal(pane().scrollTop, top, "polls and the derived focus do not move the viewport");
      const focusActions = state.actions.filter(
        (action) => action.type === "cursor.focus" && action.hunkId === "a.ts",
      );
      assert.equal(focusActions.length, 1, "the derived focus is sent once, not in a loop");
      assert.deepEqual(state.status().cursor, { itemId: "group", pane: "diff", hunkId: "a.ts" });
      // Mouse wheel scrolling back up follows the same rule.
      const before = pane().scrollTop;
      await tui.mockMouse.scroll(20, 15, "up");
      await tui.renderOnce();
      assert(pane().scrollTop < before, "the wheel scrolls the diff pane");
      while (pane().scrollTop > 40) await tui.mockMouse.scroll(20, 15, "up");
      await tui.waitFor(() => state.status().cursor.hunkId === "b.ts");
      await settled();
      assert(pane().scrollTop <= 40, "wheel-derived focus does not snap the viewport");
      // An explicit jump still reveals its target from the header.
      await press(tui, "]");
      await tui.waitForFrame((frame) => frame.includes("second_0"));
      assert.equal(state.status().cursor.hunkId, "a.ts");
      assert(tui.captureCharFrame().includes("▌a.ts"), "the jump reveals the header");
      // Overview scrolling never moves the diff focus.
      await press(tui, "TAB");
      await press(tui, "d", { ctrl: true });
      await press(tui, "j");
      await settled();
      assert.equal(state.status().cursor.hunkId, "a.ts");
    } finally {
      tui.renderer.destroy();
    }
  });

  // Three members: A and B are 60 lines each so either can head the viewport; C is short and last.
  function threeTall(state: ReturnType<typeof fixture>): TuiClient {
    const tall = (prefix: string) =>
      `@@ -1 +1,60 @@\n${Array.from({ length: 60 }, (_, i) => `+${prefix}_${i}`).join("\n")}`;
    const next = structuredClone(state.status()) as any;
    next.groups[0].hunkIds = ["b.ts", "a.ts", "c.ts"];
    next.groups[0].count = 3;
    next.groups.splice(1, 1);
    next.queue = ["group"];
    next.cursor = { itemId: "group", pane: "diff", hunkId: "b.ts" };
    state.setStatus(next);
    return {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) =>
            hunk.id === "b.ts"
              ? { ...hunk, patch: tall("first") }
              : hunk.id === "a.ts"
                ? { ...hunk, patch: tall("second") }
                : hunk,
          ),
        };
      },
    };
  }

  it("discards a scroll-derived focus queued behind a blocked poll once an explicit jump lands", async () => {
    const state = fixture();
    const base = threeTall(state);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    let failing = false;
    let failures = 0;
    const client: TuiClient = {
      ...base,
      status: async () => {
        if (++reads === 2) {
          started.resolve();
          await release.promise;
        }
        return base.status();
      },
      action: async (action) => {
        if (failing && action.type === "cursor.focus" && action.hunkId === "b.ts") {
          failures++;
          throw new TuiClientError({ code: "internal_error", message: "daemon hiccup" });
        }
        return base.action(action);
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    const settled = async () => {
      for (let i = 0; i < 8; i++) {
        await tui.renderOnce();
        await Bun.sleep(10);
      }
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await started.promise;
      // Queued behind the blocked poll: an explicit wrap to C, then a scroll that makes B head the view.
      await tui.mockInput.pressKey("[");
      for (let i = 0; i < 6; i++) await press(tui, "d", { ctrl: true });
      assert(pane().scrollTop > 60, "B heads the viewport while the poll is blocked");
      assert.equal(state.status().cursor.hunkId, "b.ts", "nothing landed yet");
      release.resolve();
      await tui.waitFor(() => state.status().cursor.hunkId === "c.ts");
      await settled();
      assert.equal(
        state.status().cursor.hunkId,
        "c.ts",
        "the stale tracker must not overwrite the jump",
      );
      assert(tui.captureCharFrame().includes("\u258cc.ts"), "the jump target is revealed");
      assert(
        !state.actions.some((action) => action.type === "cursor.focus" && action.hunkId === "a.ts"),
        "no derived focus for B was sent",
      );
      // The tracker still works afterwards; a derived action the daemon rejects leaves no trace that
      // could later swallow an explicit jump to the same hunk.
      await press(tui, "u", { ctrl: true });
      await press(tui, "u", { ctrl: true });
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settled();
      failing = true;
      for (let i = 0; i < 6; i++) await press(tui, "u", { ctrl: true });
      await settled();
      assert(failures > 0, "the tracker tried to follow the scroll to A");
      assert(failures <= 6, `at most one attempt per scroll step (${failures})`);
      assert.equal(
        state.status().cursor.hunkId,
        "a.ts",
        "a rejected derived action changes nothing",
      );
      // Nothing changed: unchanged frames, error renders and successful polls must not retry.
      const latched = failures;
      for (let i = 0; i < 3; i++) {
        await Bun.sleep(30);
        await settled();
      }
      assert(reads > 5, "polls kept landing meanwhile");
      assert.equal(failures, latched, "no retry from unchanged frames or polls");
      // Deliberate scrolling re-arms exactly one attempt for the new position.
      await press(tui, "u", { ctrl: true });
      await settled();
      assert.equal(failures, latched + 1, "one retry per meaningful scroll");
      failing = false;
      for (let i = 0; i < 5; i++) await press(tui, "d", { ctrl: true });
      await settled();
      assert(!tui.captureCharFrame().includes("first_0"), "A's header is off-screen again");
      assert.equal(state.status().cursor.hunkId, "a.ts");
      await press(tui, "[");
      await tui.waitFor(() => state.status().cursor.hunkId === "b.ts");
      await tui.waitForFrame((frame) => frame.includes("first_0"));
    } finally {
      release.resolve();
      tui.renderer.destroy();
    }
  });

  it("keeps the reading position across expand/restore when wrapping content reflows", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].overview = Array.from(
      { length: 40 },
      (_, i) => `P_${i} ${"long words ".repeat(12)}end.`,
    ).join("\n\n");
    state.setStatus(next);
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 130,
      height: 30,
    });
    const pane = (id: string) => tui.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
    const settle = async () => {
      for (let i = 0; i < 6; i++) await tui.renderOnce();
    };
    const firstMarker = () => {
      const match = tui.captureCharFrame().match(/P_\d+/);
      assert(match, "a paragraph heads the overview");
      return match[0];
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await press(tui, "TAB");
      await markdownFrame(tui, "P_0");
      // 11 half pages: near the bottom, short of the trailing rows the pinned Markdown measures but
      // never draws for this wrapped content.
      for (let i = 0; i < 11; i++) await press(tui, "d", { ctrl: true });
      await settle();
      const narrowTop = pane("overview-pane").scrollTop;
      const marker = firstMarker();
      assert(
        marker !== "P_0" && narrowTop > 100,
        `scrolled near the bottom (${marker}, ${narrowTop})`,
      );
      await press(tui, "z");
      await settle();
      assert(!pane("diff-pane").visible);
      // Wider prose wraps into fewer rows; the paragraph stays on screen even when it is now on the last page.
      assert(tui.captureCharFrame().includes(marker), "expansion keeps the paragraph being read");
      assert(
        pane("overview-pane").scrollTop < narrowTop,
        "the offset was clamped by the shorter content (the pre-fix failure mode)",
      );
      // Up two rows and back: the expanded offset is untouched, so restoring is exact.
      await press(tui, "k");
      await press(tui, "k");
      await press(tui, "j");
      await press(tui, "j");
      await settle();
      await press(tui, "ESCAPE");
      await settle();
      assert(pane("diff-pane").visible, "Esc restores the split");
      assert.equal(
        pane("overview-pane").scrollTop,
        narrowTop,
        "restoring returns the exact position",
      );
      assert.equal(firstMarker(), marker);
      await press(tui, "z");
      await settle();
      await press(tui, "u", { ctrl: true });
      await settle();
      const read = firstMarker();
      await press(tui, "z");
      await settle();
      const restored: string[] = tui.captureCharFrame().match(/P_\d+/g) ?? [];
      assert(restored.includes(read), "reading while expanded carries over to the restored pane");
      assert(
        Number(restored[0]!.slice(2)) <= Number(read.slice(2)),
        `nothing after ${read} took the top (${restored[0]})`,
      );
    } finally {
      tui.renderer.destroy();
    }
  });

  it("keeps the focused hunk in place across diff expansion that switches unified and split", async () => {
    const state = fixture();
    // Twenty replaced lines: 40 unified rows, 20 split rows, no wrapping.
    const replaced = (prefix: string) =>
      `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `-${prefix}_old_${i}`).join("\n")}\n${Array.from({ length: 20 }, (_, i) => `+${prefix}_new_${i}`).join("\n")}`;
    const next = structuredClone(state.status()) as any;
    next.groups[0].hunkIds = ["b.ts", "a.ts", "c.ts"];
    next.groups[0].count = 3;
    next.groups.splice(1, 1);
    next.queue = ["group"];
    state.setStatus(next);
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) => ({
            ...hunk,
            patch: replaced(hunk.id.replace(".ts", "")),
          })),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={5} />, {
      width: 130,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    const paired = () =>
      tui
        .captureCharFrame()
        .split("\n")
        .some((line) => line.includes("_old_") && line.includes("_new_"));
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await tui.renderOnce();
        await Bun.sleep(10);
      }
    };
    // First diff row (below header, hint and caption), diff-pane columns only.
    const topLine = () =>
      tui.captureCharFrame().split("\n")[3]!.slice(0, 76).replace(/\s+/g, " ").trim();
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("b_old_0"));
      assert(!paired(), "a 78-column pane stacks");
      for (let i = 0; i < 4; i++) await press(tui, "d", { ctrl: true });
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settle();
      const before = { top: pane().scrollTop, line: topLine() };
      assert(before.line.includes("a_old_"), `reading inside the second hunk (${before.line})`);
      const focusActions = () =>
        state.actions.filter((action) => action.type === "cursor.focus").length;
      const sent = focusActions();
      await press(tui, "z");
      await settle();
      assert(paired(), "the expanded pane splits");
      assert(
        topLine().includes("a_old_") || topLine().includes("\u258ca.ts"),
        `the same hunk still heads the view when split (${topLine()})`,
      );
      assert(pane().scrollTop < before.top, "the split layout is shorter, so the offset moved");
      await press(tui, "ESCAPE");
      await settle();
      assert(!paired());
      assert.equal(pane().scrollTop, before.top, "restore returns the unified position");
      assert.equal(topLine(), before.line);
      assert.equal(state.status().cursor.hunkId, "a.ts");
      assert.equal(focusActions(), sent, "reflow produced no derived focus traffic");
    } finally {
      tui.renderer.destroy();
    }
  });

  it("retains the expanded pane owner after a hunk jump before switching panes", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].hunkIds = ["b.ts", "a.ts", "c.ts"];
    next.groups[0].count = 3;
    next.groups.splice(1, 1);
    next.queue = ["group"];
    state.setStatus(next);
    const client: TuiClient = {
      ...state.client,
      diff: async () => {
        const value = await state.client.diff();
        return {
          ...value,
          hunks: value.hunks.map((hunk) => ({
            ...hunk,
            patch: `@@ -1,60 +1,60 @@\n${["-", "+"]
              .flatMap((sign) => Array.from({ length: 60 }, (_, i) => `${sign}${hunk.id}_${i}`))
              .join("\n")}`,
          })),
        };
      },
    };
    const tui = await testRender(() => <App client={client} pollInterval={5} />, {
      width: 130,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await tui.renderOnce();
        await Bun.sleep(10);
      }
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await press(tui, "z");
      await settle();
      assert(pane().width > 100, "the expanded diff uses the split layout");
      await press(tui, "]");
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settle();
      await press(tui, "TAB");
      await settle();
      assert(pane().visible && pane().width < 100, "switching panes restores the unified diff");
      assert.equal(state.status().cursor.hunkId, "a.ts", "the selected member survives reflow");
      assert(tui.captureCharFrame().split("\n")[3]!.includes("a.ts"));
    } finally {
      tui.renderer.destroy();
    }
  });

  it("collapses an expanded pane when Tab switches focus, restoring its own position", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].overview = Array.from(
      { length: 40 },
      (_, i) => `P_${i} ${"long words ".repeat(12)}end.`,
    ).join("\n\n");
    state.setStatus(next);
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={60_000} />, {
      width: 130,
      height: 30,
    });
    const pane = (id: string) => tui.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
    const settle = async () => {
      for (let i = 0; i < 8; i++) await tui.renderOnce();
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await markdownFrame(tui, "P_0");
      // Independent nonzero offsets in both panes.
      for (let i = 0; i < 2; i++) await press(tui, "d", { ctrl: true });
      await press(tui, "TAB");
      for (let i = 0; i < 11; i++) await press(tui, "d", { ctrl: true });
      await settle();
      const diffTop = pane("diff-pane").scrollTop;
      const overviewTop = pane("overview-pane").scrollTop;
      assert(diffTop > 0 && overviewTop > 100);
      // Expand the overview (it reflows and clamps), then Tab away and back.
      await press(tui, "z");
      await settle();
      assert(!pane("diff-pane").visible && pane("overview-pane").scrollTop < overviewTop);
      await press(tui, "\u001b[Z"); // Shift+Tab → diff
      await settle();
      assert.equal(state.status().cursor.pane, "diff");
      assert(
        pane("diff-pane").visible && pane("overview-pane").visible,
        "Tab collapses the expansion",
      );
      assert.equal(
        pane("overview-pane").scrollTop,
        overviewTop,
        "the overview keeps its own position",
      );
      assert.equal(pane("diff-pane").scrollTop, diffTop, "the diff was never touched");
      // Reverse: expand the diff, Tab to the overview.
      await press(tui, "z");
      await settle();
      assert(!pane("overview-pane").visible);
      await press(tui, "TAB");
      await settle();
      assert.equal(state.status().cursor.pane, "overview");
      assert(pane("diff-pane").visible && pane("overview-pane").visible);
      assert.equal(pane("diff-pane").scrollTop, diffTop, "the diff returns to its own position");
      assert.equal(pane("overview-pane").scrollTop, overviewTop, "the overview was never touched");
      await press(tui, "ESCAPE");
      assert(browsing(tui), "with nothing expanded, Esc returns to the list");
    } finally {
      tui.renderer.destroy();
    }
  });

  it("lets an explicit jump or remote focus during expansion restore win over the stale restore", async () => {
    const state = fixture();
    const client = threeTall(state);
    const tui = await testRender(() => <App client={client} pollInterval={5} />, {
      width: 130,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    const settled = async () => {
      for (let i = 0; i < 10; i++) {
        await tui.renderOnce();
        await Bun.sleep(10);
      }
    };
    try {
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      for (let i = 0; i < 6; i++) await press(tui, "d", { ctrl: true });
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settled();
      const scrolled = pane().scrollTop;
      await press(tui, "z");
      await settled();
      // Collapse and jump before the restoration frames finish.
      await tui.mockInput.pressKey("z");
      await tui.mockInput.pressKey("]");
      await tui.waitFor(() => state.status().cursor.hunkId === "c.ts");
      await settled();
      await Bun.sleep(40);
      await settled();
      assert.equal(
        state.status().cursor.hunkId,
        "c.ts",
        "the explicit jump keeps the shared focus",
      );
      assert(tui.captureCharFrame().includes("\u258cc.ts"), "the jump target stays revealed");
      assert.notEqual(
        pane().scrollTop,
        scrolled,
        "the stale restore did not reapply the old offset",
      );
      // A remote focus change (another TUI) during a restore is just as authoritative.
      await press(tui, "[");
      await tui.waitFor(() => state.status().cursor.hunkId === "a.ts");
      await settled();
      await press(tui, "z");
      await settled();
      await tui.mockInput.pressKey("z");
      const moved = structuredClone(state.status()) as any;
      moved.seq++;
      moved.cursor = { itemId: "group", pane: "diff", hunkId: "b.ts" };
      state.setStatus(moved);
      await tui.waitFor(() => state.status().cursor.hunkId === "b.ts" && pane().scrollTop === 0);
      await Bun.sleep(40);
      await settled();
      assert.equal(state.status().cursor.hunkId, "b.ts");
      assert(tui.captureCharFrame().includes("first_0"), "the remote target stays revealed");
    } finally {
      tui.renderer.destroy();
    }
  });

  it("reveals a persisted focus on attach and keeps manual scrolling across unchanged polls", async () => {
    const state = fixture();
    const focused = structuredClone(state.status()) as any;
    focused.cursor = { itemId: "group", pane: "diff", hunkId: "a.ts" };
    state.setStatus(focused);
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    await tui.waitForFrame((frame) => frame.includes("const old = 1"));
    await press(tui, "u", { ctrl: true });
    await tui.waitForFrame((frame) => !frame.includes("const old = 1"));
    // Several polls return a fresh copy of the same status; none of them may snap the viewport back.
    await Bun.sleep(40);
    await tui.renderOnce();
    await tui.renderOnce();
    assert(
      !tui.captureCharFrame().includes("const old = 1"),
      "an unchanged poll must not scroll the focused member back into view",
    );
    assert.equal(state.status().cursor.hunkId, "b.ts", "focus follows the member heading the view");
    tui.renderer.destroy();
  });

  it("reveals a focus that a narrow overview hid once the diff pane shows, without re-revealing on Tab", async () => {
    const state = fixture();
    const focused = structuredClone(state.status()) as any;
    focused.cursor = { itemId: "group", pane: "overview", hunkId: "a.ts" };
    state.setStatus(focused);
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={5} />, {
      width: 80,
      height: 30,
    });
    const pane = () => tui.renderer.root.findDescendantById("diff-pane") as ScrollBoxRenderable;
    try {
      await tui.waitForFrame((frame) => frame.includes("▍overview"));
      assert(!pane().visible, "a narrow overview hides the diff");
      await press(tui, "TAB");
      await tui.waitForFrame((frame) => frame.includes("const old = 1"));
      assert.deepEqual(state.status().cursor, { itemId: "group", pane: "diff", hunkId: "a.ts" });
      await press(tui, "u", { ctrl: true });
      const manual = pane().scrollTop;
      assert(manual > 0 && !tui.captureCharFrame().includes("const old = 1"));
      await press(tui, "TAB");
      await press(tui, "\u001b[Z"); // Shift+Tab
      assert.equal(state.status().cursor.pane, "diff");
      assert.equal(pane().scrollTop, manual, "Tab round trip keeps the manual scroll");
      await press(tui, "TAB");
      await tui.waitFor(() => state.status().cursor.pane === "overview");
      // Another TUI moves the shared hunk while this narrow overview hides the diff; widening shows it.
      const moved = structuredClone(state.status()) as any;
      moved.seq++;
      moved.cursor = { itemId: "group", pane: "overview", hunkId: "a.ts" };
      state.setStatus(moved);
      await tui.waitForFrame((frame) => frame.includes("hunk 2/2"));
      assert(!tui.captureCharFrame().includes("const old = 1"));
      tui.resize(120, 30);
      await tui.waitForFrame((frame) => frame.includes("const old = 1"));
    } finally {
      tui.renderer.destroy();
    }
  });

  it("preserves cursor and manual scroll when another complete item is published", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={5} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("rename old to new"));
      await press(tui, "RETURN");
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await press(tui, "d", { ctrl: true });
      // Diff text only: the scrollbar column redraws, and the pane grows a row once the inbox empties.
      const shown = () =>
        tui
          .captureCharFrame()
          .split("\n")
          .filter((line) => line.includes("first_"))
          .map((line) => line.slice(0, 40));
      const before = shown();
      assert(!before.some((line) => line.includes("first_0")));
      const next = structuredClone(state.status()) as any;
      next.groups.push({
        id: "arrival",
        hunkIds: ["d.ts"],
        count: 1,
        title: "Newly published",
        overview: "Independent change",
        accepted: false,
      });
      next.inbox = [];
      next.queue.push("arrival");
      next.revision++;
      next.seq++;
      next.ready = true;
      state.setStatus(next);
      await tui.waitForFrame((frame) => frame.includes("0/3 done"));
      assert.deepEqual(state.status().cursor, { itemId: "group", pane: "diff", hunkId: "b.ts" });
      assert.deepEqual(shown().slice(0, before.length), before);
    } finally {
      tui.renderer.destroy();
    }
  });

  it("scrolls a long group list to the selection and keeps the overview at the same width when reading", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    const long = `Reject expired credentials ${"with a deliberately very long title ".repeat(3)}CUT`;
    next.groups = Array.from({ length: 40 }, (_, i) => ({
      id: `g${i}`,
      title: i === 0 ? long : `Group ${i}`,
      overview: `Overview ${i}. ${"long words ".repeat(20)}end.`,
      hunkIds: [i === 0 ? "a.ts" : "b.ts"],
      count: 1,
      accepted: i % 3 === 0,
    }));
    next.queue = next.groups.map((group: any) => group.id);
    next.cursor = { itemId: "g0", pane: "queue" };
    state.setStatus(next);
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 160,
      height: 24,
    });
    const pane = (id: string) => tui.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
    try {
      await tui.waitForFrame((frame) => frame.includes("Reject expired"));
      const frame = await markdownFrame(tui, "Overview 0");
      const rows = frame.split("\n");
      assert(rows[0]!.startsWith(" stdin"), "browse header shows the scope");
      assert.equal((frame.match(/Reject expired/g) ?? []).length, 1, "the title appears once");
      assert(!frame.includes("CUT"), "the title is cut to the list width");
      assert(
        rows[3]!.slice(0, 96).includes("very long title with"),
        "but keeps most of the 60% column",
      );
      const overviewLeft = pane("overview-pane").x;
      assert.equal(overviewLeft, Math.round(160 * 0.6), "overview takes 40% beside the list");
      assert.equal(
        pane("group-list").viewport.height,
        pane("group-list").height,
        "list root keeps the row layout",
      );
      assert(!frame.includes("Group 30"), "the long list is clipped, not stacked");
      for (let i = 0; i < 30; i++) await press(tui, "j");
      await tui.waitForFrame((value) => value.includes("Group 30"));
      assert.equal(state.status().cursor.itemId, "g30");
      assert(pane("group-list").scrollTop > 0, "the list scrolled to reveal the selection");
      await press(tui, "RETURN");
      await markdownFrame(tui, "Overview 30");
      assert.equal(
        pane("overview-pane").x,
        overviewLeft,
        "opening the diff does not reflow the overview",
      );
      assert(
        tui.captureCharFrame().includes("a unmark · tab pane · ? help"),
        `reading hint for an accepted lone hunk: ${tui.captureCharFrame().split("\n")[1]}`,
      );
      await press(tui, "ESCAPE");
      await tui.waitForFrame((value) => value.includes("Group 30"));
      assert(browsing(tui), "back in the list at the selection");
    } finally {
      tui.renderer.destroy();
    }
  });

  it("distinguishes reviewed prepared work from completion while the inbox remains", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].accepted = true;
    next.groups[1].accepted = true;
    state.setStatus(next);
    const tui = await testRender(() => <App client={state.client} pollInterval={60_000} />, {
      width: 100,
      height: 30,
    });
    try {
      await tui.waitForFrame((frame) => frame.includes("reviewed everything prepared so far"));
      assert(tui.captureCharFrame().includes("1 hunks awaiting preparation"));
      assert(!tui.captureCharFrame().includes("review complete"));
    } finally {
      tui.renderer.destroy();
    }
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
    await unreadyTui.waitForFrame((value) => value.includes("rename old to new"));
    await press(unreadyTui, "a");
    await press(unreadyTui, "u");
    assert(
      unreadyTui.captureCharFrame().includes("review queue is not set"),
      "unready session shows the verdict guard",
    );
    assert.equal(unreadyState.actions.length, 0, "unready session dispatches no verdict");
    await press(unreadyTui, "j");
    assert(
      unreadyTui.captureCharFrame().includes("cache behavior changed"),
      "navigation stays available",
    );
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
    await waitingTui.waitForFrame((value) => value.includes("rename old to new"));
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
      await drainTui.waitForFrame((value) => value.includes("rename old to new"));
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
    await rapidTui.waitForFrame((value) => value.includes("rename old to new"));
    await rapidTui.mockInput.pressKey("j");
    await rapidTui.mockInput.pressKey("j");
    await Bun.sleep(5);
    await rapidTui.renderOnce();
    assert(
      rapidState.status().cursor.itemId === "d.ts" &&
        rapidTui.captureCharFrame().includes("! d.ts"),
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
    assert(
      emptyTui.captureCharFrame().split("\n")[0]!.startsWith(" HEAD"),
      "header names the git scope",
    );
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
      patchHash: "snapshot",
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
    await readyEmptyTui.waitForFrame((value) => value.includes("review complete — 0/0 done"));
    assert(
      readyEmptyTui.captureCharFrame().split("\n")[0]!.startsWith(" working tree"),
      "header names the bare scope",
    );
    readyEmptyTui.renderer.destroy();
  });

  it("scrolls a single-hunk group with Ctrl+D/Ctrl+U and snaps back on the next group", async () => {
    const longState = fixture();
    const long = structuredClone(longState.status()) as any;
    long.cursor = { itemId: "cache", pane: "diff", hunkId: "c.ts" };
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
    await press(longTui, "n");
    assert.deepEqual(
      longState.status().cursor,
      { itemId: "d.ts", pane: "diff", hunkId: "d.ts" },
      "n visits the unverdicted inbox hunk too",
    );
    await press(longTui, "p");
    assert.deepEqual(longState.status().cursor, { itemId: "cache", pane: "diff", hunkId: "c.ts" });
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
    await tui.waitForFrame((frame) => frame.includes("rename old to new"));
    await press(tui, "j");
    await press(tui, "RETURN");
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
    await tui.waitForFrame((frame) => frame.includes("rename old to new"));
    await press(tui, "j");
    await press(tui, "RETURN");
    await tui.waitForFrame(
      (frame) => frame.includes("cache behavior changed") && frame.includes("1 - stale"),
    );
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
    await resetTui.waitForFrame((value) => value.includes("✓ rename"));
    const reset = structuredClone(resetState.status()) as any;
    reset.groups[0].accepted = false;
    reset.revision = 2;
    resetState.setStatus(reset);
    await Bun.sleep(15);
    await resetTui.waitForFrame((value) => !value.includes("✓ rename"));
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
    await reattachedTui.waitForFrame((value) => value.includes("✓ rename"));
    await press(reattachedTui, "u");
    assert(
      !reattachedTui.captureCharFrame().includes("✓ rename"),
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
    await mismatchedTui.waitForFrame((value) => value.includes("cache behavior changed"));
    assert(
      !mismatchedTui.captureCharFrame().includes("rename old to new"),
      "groups absent from a non-atomic diff read are omitted",
    );
    mismatchedTui.renderer.destroy();
  });
});
