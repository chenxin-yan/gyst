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
  accepted: false,
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
    ],
    spotlight: [
      {
        id: "c.ts",
        file: "c.ts",
        title: "cache behavior changed",
        overview: "Refresh cached values.",
        accepted: false,
      },
    ],
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
      const next = Result.getOrThrow(
        applyHumanAction(
          {
            ...status.session,
            revision: status.revision,
            seq: status.seq,
            cursor: status.cursor,
            hunks: diff.hunks.map((hunk) => ({
              ...hunk,
              ...status.spotlight.find((item) => item.id === hunk.id),
            })),
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
      acceptHistory = [...next.groups, ...next.spotlight]
        .filter((item) => item.accepted)
        .map((item) => item.id);
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

function emptyStatus(base: StatusPayload): StatusPayload {
  const empty = structuredClone(base) as any;
  empty.session.source = { kind: "git", args: ["HEAD"], cwd: "/repo" };
  empty.groups = [];
  empty.spotlight = [];
  empty.inbox = [];
  empty.queue = [];
  empty.files = [];
  empty.cursor = { itemId: null, pane: "queue" };
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
    assert(frame.includes("all 2 members"));
    assert(
      frame.includes("const old = 1") && frame.includes("old()"),
      "all members render in publication order",
    );
    assert(frame.indexOf("old()") < frame.indexOf("const old = 1"));
    assert(!frame.includes("Rename entry point"), "browse does not render the overview");
    assert(frame.includes("! d.ts"), "inbox is visibly distinct");

    await press(tui, "e");
    assert.equal(state.actions.length, 0, "fold control is removed");
    await press(tui, "a");
    frame = tui.captureCharFrame();
    assert(frame.includes("✓ rename"));
    assert(frame.includes("SPOTLIGHT"), "accept advances atomically");
    assert.equal(state.status().revision, 1, "verdict bumps revision");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "verdict.toggle", itemId: "group", sessionId: "session", revision: 0 },
      "verdict carries the frame seen at keypress",
    );
    const seqBeforeMove = state.status().seq;
    await press(tui, "j");
    assert(tui.captureCharFrame().includes("INBOX"));
    assert.equal(state.status().seq, seqBeforeMove + 1, "cursor bumps seq once");
    await press(tui, "u");
    assert(tui.captureCharFrame().includes("all 2 members"), "undo returns to accepted item");
    assert(!tui.captureCharFrame().includes("✓ accepted"), "undo clears verdict");

    const paired = (value: string) =>
      value
        .split("\n")
        .some((line) => line.includes("const old = 1") && line.includes("const new = 1"));
    assert(!paired(tui.captureCharFrame()), "auto stacks at width 100");
    await press(tui, "1");
    assert(paired(tui.captureCharFrame()), "split pairs deletion/addition");
    await press(tui, "0");
    tui.resize(200, 30);
    await tui.renderOnce();
    await tui.renderOnce();
    assert(paired(tui.captureCharFrame()), "auto splits when the diff pane has 120 columns");
    await press(tui, "s");
    assert(tui.captureCharFrame().includes("REVIEW QUEUE"), "obsolete s is inert");
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
    await press(tui, "RETURN");
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
    assert(tui.captureCharFrame().includes("▍GROUP"));
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
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "b.ts" },
      "Enter focuses the group's first member",
    );
    let frame = tui.captureCharFrame();
    assert(frame.includes("all 2 members"), "focusing retains all members");
    assert(frame.includes("j/k to step, esc to leave"), "focused card names the pane keys");
    await press(tui, "j");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "group",
      pane: "diff",
      hunkId: "a.ts",
    });
    await press(tui, "j");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "b.ts" },
      "j wraps",
    );
    await press(tui, "k");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.focus", itemId: "group", pane: "diff", hunkId: "a.ts" },
      "k steps back",
    );
    assert(tui.captureCharFrame().includes("▍GROUP"), "stepping hunks keeps the item");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "group",
      pane: "queue",
    });
    frame = tui.captureCharFrame();
    assert(frame.includes("all 2 members"), "leaving retains all members");
    assert(frame.includes("enter to step through"), "unfocused card offers Enter");
    await press(tui, "j");
    assert.deepEqual(
      state.actions.at(-1),
      { type: "cursor.move", itemId: "c.ts" },
      "j moves items again",
    );
    await press(tui, "RETURN");
    assert.deepEqual(state.actions.at(-1), {
      type: "cursor.focus",
      itemId: "c.ts",
      pane: "diff",
      hunkId: "c.ts",
    });
    const before = state.actions.length;
    await press(tui, "j");
    await press(tui, "k");
    assert.equal(state.actions.length, before, "a lone hunk has nothing to step through");
    await press(tui, "ESCAPE");
    assert.deepEqual(state.actions.at(-1), { type: "cursor.focus", itemId: "c.ts", pane: "queue" });
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
        await tui.waitForFrame((frame) => frame.includes("first_0"));
        await press(tui, "TAB");
        assert.equal(state.actions.length, 0, "Tab in queue is inert");
        await press(tui, "RETURN");
        await tui.waitForFrame((frame) => frame.includes("[diff]"));
        assert(!tui.captureCharFrame().includes("REVIEW QUEUE"));
        if (width >= 120) await markdownFrame(tui, "Intent");
        else assert(!tui.captureCharFrame().includes("Intent"));
        await press(tui, "d", { ctrl: true });
        const diffTop = pane("diff-pane").scrollTop;
        assert(diffTop > 0);
        assert(
          tui.captureCharFrame().split("\n")[0]!.startsWith("rename old to new — b.ts"),
          "scrolling cannot paint over the compact header",
        );
        await press(tui, "TAB");
        await tui.waitForFrame((frame) => frame.includes("[overview]"));
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
        published.spotlight.push({
          id: "d.ts",
          file: "d.ts",
          title: "Arrival",
          overview: "Complete item",
          accepted: false,
        });
        published.inbox = [];
        published.queue.push("d.ts");
        published.revision++;
        published.seq++;
        published.ready = true;
        state.setStatus(published);
        await Bun.sleep(15);
        await tui.waitForFrame((frame) => frame.includes("0 hunks awaiting preparation"));
        assert.equal(state.status().cursor.pane, "overview");
        assert.equal(pane("overview-pane").scrollTop, overviewTop);
        assert.equal(pane("diff-pane").scrollTop, diffTop);
        for (const columns of [200, 80, 120]) {
          tui.resize(columns, 30);
          await tui.renderOnce();
          await tui.renderOnce();
          assert.equal(state.status().cursor.pane, "overview");
          assert.equal(pane("overview-pane").scrollTop, overviewTop);
          assert(!tui.captureCharFrame().includes("REVIEW QUEUE"));
        }
        await press(tui, "ESCAPE");
        assert(tui.captureCharFrame().includes("REVIEW QUEUE"));
        assert(!tui.captureCharFrame().includes("Paragraph"));
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
      await tui.waitForFrame(() => paired());
      await press(tui, "RETURN");
      await tui.renderOnce();
      assert(!paired(), "200-column zoom diff is less than 120 usable columns");
      await press(tui, "1");
      assert(paired(), "explicit split overrides narrow pane");
      await press(tui, "2");
      assert(!paired());
      await press(tui, "0");
      tui.resize(240, 30);
      await tui.waitForFrame(() => paired());
      tui.resize(120, 30);
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
      await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
      await tui.mockInput.pressKey("a");
      await started.promise;
      await tui.mockInput.pressKey("a");
      // Another TUI moved only the shared cursor: the verdict revision remains valid.
      const moved = structuredClone(state.status());
      state.setStatus({
        ...moved,
        seq: moved.seq + 1,
        cursor: { itemId: "c.ts", pane: "overview", hunkId: "c.ts" },
      });
      release.resolve();
      await tui.waitForFrame((frame) => frame.includes("snapshot changed, re-read"));
      assert(state.status().groups[0]!.accepted);
      assert(!state.status().spotlight[0]!.accepted, "unseen destination cannot be accepted");
      assert.deepEqual(state.status().cursor, { itemId: "c.ts", pane: "overview", hunkId: "c.ts" });
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
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await press(tui, "RETURN");
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
      await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
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
      await tui.waitForFrame((frame) => frame.includes("▍GROUP"));
      await press(tui, "RETURN");
      await press(tui, "TAB");
      await press(tui, "a");
      assert.deepEqual(state.status().cursor, { itemId: "c.ts", pane: "diff", hunkId: "c.ts" });
      await press(tui, "TAB");
      await press(tui, "a");
      assert.equal(state.status().cursor.pane, "overview");
      assert(tui.captureCharFrame().includes("reviewed everything prepared so far"));
      await markdownFrame(tui, "Refresh cached values");
      const next = structuredClone(state.status()) as any;
      next.spotlight.push({
        id: "d.ts",
        file: "d.ts",
        title: "Arrival",
        overview: "New item",
        accepted: false,
      });
      next.inbox = [];
      next.queue.push("d.ts");
      next.revision++;
      next.seq++;
      next.ready = true;
      state.setStatus(next);
      await Bun.sleep(15);
      await tui.waitForFrame((frame) => frame.includes("0 hunks awaiting preparation"));
      assert.equal(state.status().cursor.itemId, "c.ts");
      assert.equal(state.status().cursor.pane, "overview");
      await press(tui, "ESCAPE");
      await press(tui, "j");
      await press(tui, "RETURN");
      await press(tui, "a");
      assert(tui.captureCharFrame().includes("review complete"));
      await markdownFrame(tui, "New item");
      assert(!tui.captureCharFrame().includes("REVIEW QUEUE"));
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

  it("scrolls the focused member into view", async () => {
    const state = fixture();
    const tui = await testRender(() => <App client={tallGroup(state)} pollInterval={60_000} />, {
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
      await tui.waitForFrame((frame) => frame.includes("[overview]"));
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
      // Another TUI moves the shared hunk while this narrow overview hides the diff; widening shows it.
      const moved = structuredClone(state.status()) as any;
      moved.seq++;
      moved.cursor = { itemId: "group", pane: "overview", hunkId: "b.ts" };
      state.setStatus(moved);
      await tui.waitForFrame((frame) => frame.includes("— b.ts"));
      tui.resize(120, 30);
      await tui.waitForFrame((frame) => frame.includes("first_0"));
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
      await tui.waitForFrame((frame) => frame.includes("first_0"));
      await press(tui, "RETURN");
      await press(tui, "d", { ctrl: true });
      const before = tui
        .captureCharFrame()
        .split("\n")
        .filter((line) => line.includes("first_"))
        .map((line) => line.slice(27));
      assert(!before.some((line) => line.includes("first_0")));
      const next = structuredClone(state.status()) as any;
      next.spotlight.push({
        id: "d.ts",
        file: "d.ts",
        title: "Newly published",
        overview: "Independent change",
        accepted: false,
      });
      next.inbox = [];
      next.queue.push("d.ts");
      next.revision++;
      next.seq++;
      next.ready = true;
      state.setStatus(next);
      await tui.waitForFrame((frame) => frame.includes("0 hunks awaiting preparation"));
      assert.deepEqual(state.status().cursor, { itemId: "group", pane: "diff", hunkId: "b.ts" });
      assert.deepEqual(
        tui
          .captureCharFrame()
          .split("\n")
          .filter((line) => line.includes("first_"))
          .map((line) => line.slice(27)),
        before,
      );
    } finally {
      tui.renderer.destroy();
    }
  });

  it("distinguishes reviewed prepared work from completion while the inbox remains", async () => {
    const state = fixture();
    const next = structuredClone(state.status()) as any;
    next.groups[0].accepted = true;
    next.spotlight[0].accepted = true;
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
    long.cursor = { itemId: "c.ts", pane: "queue" };
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
