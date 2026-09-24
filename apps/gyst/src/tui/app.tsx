import {
  sanitizeTerminalText,
  type DiffPayload,
  type Hunk,
  type Source,
  type SourceCheckPayload,
  type StatusPayload,
} from "@gyst/core";
import {
  pathToFiletype,
  SyntaxStyle,
  type BoxRenderable,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions, type SpanProps } from "@opentui/solid";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { TuiClient } from "./client.ts";
import { TuiClientError } from "./client.ts";
import type { EditRequest } from "./editor.ts";

const C = {
  bg: "#0d1117",
  panel: "#1e2329",
  panelAlt: "#272b31",
  border: "#34393f",
  fg: "#e6edf3",
  muted: "#adaeb1",
  dim: "#878c92",
  accent: "#fab283",
  addSign: "#2ea043",
  delSign: "#f85149",
  addBg: "#12251d",
  delBg: "#3c1e21",
  addGutterBg: "#1b2b34",
  delGutterBg: "#2d1f26",
  ok: "#77c185",
  okBadge: "#7fd88f",
  delBadge: "#fa8e89",
};
// Tree-sitter capture names; dotted captures fall back to their prefix inside OpenTUI.
let syntaxStyle: SyntaxStyle | undefined;
const syntax = () =>
  (syntaxStyle ??= SyntaxStyle.fromStyles({
    default: { fg: C.fg },
    keyword: { fg: "#ff7b72" },
    string: { fg: "#a5d6ff" },
    comment: { fg: C.dim, italic: true },
    function: { fg: "#d2a8ff" },
    method: { fg: "#d2a8ff" },
    type: { fg: "#ffa657" },
    constructor: { fg: "#ffa657" },
    constant: { fg: "#79c0ff" },
    number: { fg: "#79c0ff" },
    boolean: { fg: "#79c0ff" },
    property: { fg: "#79c0ff" },
    attribute: { fg: "#79c0ff" },
    tag: { fg: "#7ee787" },
    operator: { fg: C.muted },
    punctuation: { fg: C.muted },
  }));

// SpanProps omits fg/bg/attributes while OpenTUI applies them at runtime (confirmed by the prototype).
const Sp = (props: SpanProps & { fg?: string; bg?: string; attributes?: number }) => (
  <span {...props} />
);

type Member = {
  id: string;
  file: string;
  header: string;
  patch: string;
  added: number;
  removed: number;
};
type ViewItem =
  | {
      kind: "group";
      id: string;
      title: string;
      notes: StatusPayload["groups"][number]["notes"];
      accepted: boolean;
      members: Member[];
    }
  | { kind: "inbox"; id: string; accepted: false; member: Member };
type LayoutMode = "auto" | "split" | "stack";
const LAYOUT = { sidebarColumns: 28, splitColumns: 120 };

function memberOf(hunk: Hunk): Member {
  const [header = "", ...body] = hunk.patch.split("\n");
  return {
    id: hunk.id,
    file: hunk.file,
    header,
    patch: hunk.patch,
    added: body.filter((line) => line.startsWith("+")).length,
    removed: body.filter((line) => line.startsWith("-")).length,
  };
}

function buildItems(status: StatusPayload, hunks: Map<string, Member>): ViewItem[] {
  const groups = status.groups.flatMap((group): ViewItem[] => {
    const members = group.hunkIds.flatMap((id) => hunks.get(id) ?? []);
    return members.length
      ? [
          {
            kind: "group",
            id: group.id,
            title: group.title,
            notes: group.notes,
            accepted: group.accepted,
            members,
          },
        ]
      : [];
  });
  const inbox = status.inbox.flatMap((hunk): ViewItem[] => {
    const member = hunks.get(hunk.id);
    return member ? [{ kind: "inbox", id: hunk.id, accepted: false, member }] : [];
  });
  const byId = new Map([...groups, ...inbox].map((item) => [item.id, item]));
  return [...status.queue, ...byId.keys()].flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    byId.delete(id);
    return [item];
  });
}

const itemTitle = (item: ViewItem) =>
  item.kind === "inbox" ? `${item.member.file} · unprepared` : item.title;
const itemMembers = (item: ViewItem) => (item.kind === "group" ? item.members : [item.member]);

function FileHeader(props: { member: Member; focused: boolean }) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={props.focused ? C.panelAlt : C.panel}
      paddingRight={1}
    >
      <text>
        <Sp fg={props.focused ? C.accent : C.panel}>▌</Sp>
        <Sp fg={C.fg} attributes={props.focused ? 1 : 0}>
          {props.member.file}
        </Sp>
        <Sp fg={C.dim}> {props.member.header}</Sp>
      </text>
      <text>
        <Show when={props.member.added}>
          <Sp fg={C.ok}>+{props.member.added}</Sp>
        </Show>
        <Show when={props.member.removed}>
          <Sp fg={C.delBadge}> -{props.member.removed}</Sp>
        </Show>
      </text>
    </box>
  );
}

/** The box id lets the diff pane reveal a focused member and find the member at its viewport top. */
const memberElementId = (hunkId: string) => `hunk:${hunkId}`;
const rowElementId = (itemId: string) => `row:${itemId}`;

function MemberDiff(props: {
  member: Member;
  layout: "split" | "stack";
  focused: boolean;
  note: string | undefined;
}) {
  return (
    <box flexDirection="column" id={memberElementId(props.member.id)}>
      <FileHeader member={props.member} focused={props.focused} />
      <Show when={props.note}>
        <box
          border={["left"]}
          borderColor={C.dim}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          <text fg={C.muted}>Agent</text>
          <text fg={C.fg} wrapMode="word">
            {props.note}
          </text>
        </box>
      </Show>
      <diff
        diff={props.member.patch}
        view={props.layout === "split" ? "split" : "unified"}
        wrapMode="word"
        filetype={pathToFiletype(props.member.file)}
        syntaxStyle={syntax()}
        fg={C.fg}
        lineNumberFg={C.dim}
        contextBg={C.bg}
        addedBg={C.addBg}
        removedBg={C.delBg}
        addedSignColor={C.addSign}
        removedSignColor={C.delSign}
        addedLineNumberBg={C.addGutterBg}
        removedLineNumberBg={C.delGutterBg}
      />
    </box>
  );
}

function GroupDiff(props: {
  item: ViewItem;
  focusedHunk: string | undefined;
  layout: "split" | "stack";
  showNotes: boolean;
}) {
  return (
    <box flexDirection="column">
      <For each={itemMembers(props.item)}>
        {(member) => (
          <box paddingBottom={1}>
            <MemberDiff
              member={member}
              layout={props.layout}
              focused={member.id === props.focusedHunk}
              note={
                props.showNotes && props.item.kind === "group"
                  ? props.item.notes.find(({ hunkId }) => hunkId === member.id)?.text
                  : undefined
              }
            />
          </box>
        )}
      </For>
    </box>
  );
}

const scopeLabel = (source: Source) =>
  source.kind === "stdin"
    ? "stdin"
    : source.includeUntracked
      ? "working tree"
      : source.args.join(" ");

/** `onQuit` fires once every queued input has landed; `cancelled` is true when Ctrl+C asked for it. */
export function App(props: {
  client: TuiClient;
  onQuit?: (cancelled: boolean) => void;
  onEdit?: (request: EditRequest) => Promise<void>;
  pollInterval?: number;
}) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  const [status, setStatus] = createSignal<StatusPayload>();
  const [diff, setDiff] = createSignal<DiffPayload>();
  const [message, setMessage] = createSignal("attaching…");
  const [editorNotice, setEditorNotice] = createSignal("");
  const [sourceCheck, setSourceCheck] = createSignal<SourceCheckPayload>();
  let checkingSource = false;
  let checkedIdentity = "";
  let nextSourceCheck = 0;
  const [diffWidth, setDiffWidth] = createSignal(0);
  const [help, setHelp] = createSignal(false);
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>("auto");
  const [revealVersion, setRevealVersion] = createSignal(0);
  // `closing` stops admitting inputs and polls while the queue drains; `stopped` means the renderer is gone.
  let closing = false;
  let stopped = false;
  let editing = false;
  let syncQueued = false;
  let latestStatus: StatusPayload | undefined;
  let inputs = Promise.resolve();
  let diffPane: ScrollBoxRenderable | undefined;
  let groupList: ScrollBoxRenderable | undefined;
  let diffContent: BoxRenderable | undefined;
  // Scroll-derived focus: `revealPending` holds the tracker off until an explicit focus is revealed,
  // `derivedFocus` is the hunk the tracker sent so the reveal effect does not snap the viewport to it,
  // and `focusGeneration` counts every focus change the tracker did not cause: a queued tracker entry
  // derived under an older generation has been overtaken and is dropped.
  let revealPending = false;
  let derivedFocus: string | undefined;
  let derivedInFlight = false;
  let focusGeneration = 0;
  // A derived focus the daemon rejected, keyed by everything that made it: the same view at the same
  // scroll position is not retried by frames, error renders or unchanged polls, only by new input.
  let failedDerived: string | undefined;
  // Layout reflows the diff; tracking waits until its reading position is restored.
  let anchorPending = false;
  let cancelRestore: (() => void) | undefined;

  // Reusing a member across polls keeps its rendered diff (and highlighting) in place. A refresh keeps a
  // hunk's id when only its line numbers moved, so the patch text decides whether the member is still current.
  const members = new Map<string, Member>();
  const hunks = createMemo(
    () =>
      new Map(
        (diff()?.hunks ?? []).map((hunk) => {
          const cached = members.get(hunk.id);
          const member = cached?.patch === hunk.patch ? cached : memberOf(hunk);
          members.set(hunk.id, member);
          return [hunk.id, member];
        }),
      ),
  );
  const items = createMemo(() => (status() ? buildItems(status()!, hunks()) : []));
  const currentIndex = createMemo(() =>
    Math.max(
      0,
      items().findIndex(({ id }) => id === status()?.cursor.itemId),
    ),
  );
  const current = createMemo(() => items()[currentIndex()]);
  // The diff is rebuilt only when the item or its kind changes, not on every poll.
  const currentKey = createMemo(() => {
    const item = current();
    return item && `${status()!.session.id}:${item.kind}:${item.id}`;
  });
  // A memo, so a poll that returns the same focus does not re-run the reveal below.
  const focusedHunk = createMemo(() => status()?.cursor.hunkId);
  const pane = createMemo(() => status()?.cursor.pane ?? "queue");
  const reading = createMemo(() => pane() === "diff");
  const sidebarWidth = createMemo(() =>
    Math.min(LAYOUT.sidebarColumns, Math.max(8, Math.floor(dims().width / 3))),
  );
  const noteText = createMemo(() => {
    const item = current();
    return item?.kind === "group" ? JSON.stringify(item.notes) : "";
  });
  const selectedMember = createMemo(() => {
    const item = current();
    return item?.kind === "group"
      ? item.members.find((member) => member.id === focusedHunk())
      : item?.member;
  });
  // Hunks the focused cursor can step through: a group's members in order, or the lone hunk.
  const focusable = createMemo(() => {
    const item = current();
    return item ? itemMembers(item).map(({ id }) => id) : [];
  });
  const resolvedLayout = createMemo(() => {
    const mode = layoutMode();
    return mode === "auto" ? (diffWidth() >= LAYOUT.splitColumns ? "split" : "stack") : mode;
  });
  const doneCount = createMemo(
    () => status()?.groups.filter((group) => group.accepted).length ?? 0,
  );
  // A ready session has an empty inbox, so a ready empty queue is also complete.
  const allDone = createMemo(
    () => status()?.ready === true && items().every((item) => item.accepted),
  );
  // One muted line of the keys that matter right now; the full list stays behind ?.
  const hint = createMemo(() => {
    const item = current();
    if (!item) return "no review items · ? help";
    if (!reading()) return "enter review · ? help";
    const parts = [
      item.kind === "inbox" ? "no verdict (inbox)" : item.accepted ? "a unmark" : "a done",
      ...(focusable().length > 1 ? ["[ ] hunk"] : []),
      "s sidebar",
      "? help",
    ];
    return parts.join(" · ");
  });
  const position = createMemo(() => {
    const frame = status();
    const item = current();
    if (!frame || !item) return "";
    const parts = [`${currentIndex() + 1}/${items().length}`];
    const hunkIndex = focusable().indexOf(focusedHunk() ?? "");
    if (reading() && hunkIndex >= 0 && focusable().length > 1)
      parts.push(`hunk ${hunkIndex + 1}/${focusable().length}`);
    parts.push(`${doneCount()}/${frame.groups.length} done`);
    return parts.join(" · ");
  });
  // Keyed on the id, not the item object: every poll rebuilds the items, and only a move should reset the scroll.
  createEffect(
    on(currentKey, () => {
      cancelRestore?.();
      roundTrip = undefined;
      diffPane?.scrollTo(0);
    }),
  );
  // A newer snapshot invalidates saved geometry even when ids and note text survive.
  const revision = createMemo(() => status()?.revision);
  createEffect(
    on(revision, () => {
      cancelRestore?.();
      roundTrip = undefined;
    }),
  );
  // Keep the selected row visible in a long list: positions exist after a rendered frame.
  createEffect(
    on([currentKey, reading], ([key, isReading]) => {
      if (!key || isReading) return;
      const reveal = () => {
        if (!groupList?.visible || !groupList.findDescendantById(rowElementId(current()!.id)))
          return;
        renderer.off("frame", reveal);
        groupList.scrollChildIntoView(rowElementId(current()!.id));
      };
      renderer.on("frame", reveal);
      renderer.requestRender();
      onCleanup(() => renderer.off("frame", reveal));
    }),
  );
  // Reveal the focused member when the focus moves or its diff is (re)mounted. Positions exist only
  // after layout, which happens inside a render, so the scroll waits for a rendered frame.
  createEffect(
    on([focusedHunk, currentKey, revealVersion], ([hunkId]) => {
      const derived = hunkId !== undefined && hunkId === derivedFocus;
      derivedFocus = undefined;
      if (!derived) {
        // An explicit jump, another TUI's focus or a new item supersedes queued tracking and any
        // layout restore still in flight, including its saved round-trip offset.
        focusGeneration++;
        cancelRestore?.();
        roundTrip = undefined;
      }
      // The tracker named this hunk because it already heads the viewport: no snap to its header.
      if (hunkId === undefined || derived) return;
      // A hunk that does not fit goes to the top of the viewport: reading starts at its header, and a
      // hunk taller than the viewport would otherwise be revealed by its tail.
      const reveal = () => {
        const member = diffPane?.findDescendantById(memberElementId(hunkId));
        if (!diffPane?.visible || !member) return;
        renderer.off("frame", reveal);
        revealPending = false;
        const top = member.y - diffPane.viewport.y;
        if (top < 0 || top + member.height > diffPane.viewport.height) diffPane.scrollBy(top);
      };
      revealPending = true;
      renderer.on("frame", reveal);
      renderer.requestRender();
      onCleanup(() => {
        renderer.off("frame", reveal);
        revealPending = false;
      });
    }),
  );

  const sourceNotice = createMemo(() => {
    const frame = status();
    if (!frame) return "";
    if (frame.session.source.kind === "stdin")
      return "stdin snapshot — source changes cannot be checked";
    const check = sourceCheck();
    if (check?.sessionId !== frame.session.id || check.revision !== frame.revision)
      return "checking source — snapshot stays fixed";
    if (check.state === "changed") return "source changed — snapshot unchanged · r refresh";
    if (check.state === "unavailable") return "source check unavailable — snapshot unchanged";
    return "";
  });

  async function checkSource(): Promise<void> {
    const seen = status();
    if (
      !seen ||
      seen.session.source.kind === "stdin" ||
      checkingSource ||
      stopped ||
      closing ||
      editing
    )
      return;
    const identity = `${seen.session.id}:${seen.revision}`;
    if (checkedIdentity === identity && Date.now() < nextSourceCheck) return;
    checkedIdentity = identity;
    checkingSource = true;
    try {
      const checked = await props.client.check();
      if (
        !stopped &&
        !closing &&
        !editing &&
        checked.sessionId === status()?.session.id &&
        checked.revision === status()?.revision
      )
        setSourceCheck(checked);
    } catch {
      if (
        !stopped &&
        !closing &&
        !editing &&
        seen.session.id === status()?.session.id &&
        seen.revision === status()?.revision
      )
        setSourceCheck({
          sessionId: seen.session.id,
          revision: seen.revision,
          state: "unavailable",
          checkedAt: new Date().toISOString(),
        });
    } finally {
      checkingSource = false;
      nextSourceCheck = Date.now() + 5_000;
    }
  }

  function observe(next: StatusPayload): StatusPayload {
    if (
      !latestStatus ||
      latestStatus.session.id !== next.session.id ||
      next.seq >= latestStatus.seq
    )
      latestStatus = next;
    return latestStatus;
  }

  function matches(
    next: StatusPayload,
    nextDiff: DiffPayload | undefined,
  ): nextDiff is DiffPayload {
    return nextDiff?.sessionId === next.session.id && nextDiff.revision === next.revision;
  }

  async function synchronize(next: StatusPayload, afterEdit = false): Promise<boolean> {
    next = observe(next);
    if (stopped || (editing && !afterEdit)) return false;
    let nextDiff = diff();
    if (!matches(next, nextDiff)) nextDiff = await props.client.diff();
    if (stopped || (editing && !afterEdit)) return false;
    if (!matches(next, nextDiff)) next = observe(await props.client.status());
    // A harness may mutate between reads. Keep the last coherent frame and retry on the next poll.
    if (stopped || (editing && !afterEdit) || !matches(next, nextDiff)) return false;
    batch(() => {
      setDiff(nextDiff);
      setStatus(next);
      setMessage("");
    });
    void checkSource();
    return true;
  }

  function enqueue(operation: () => Promise<void>): void {
    if (closing) return;
    inputs = inputs.then(() => {
      if (!stopped) return operation();
    });
  }

  function quit(cancelled: boolean): void {
    if (closing) return;
    closing = true;
    void inputs.then(() => props.onQuit?.(cancelled));
  }

  async function sync(afterEdit = false): Promise<void> {
    try {
      if (!(await synchronize(await props.client.status(), afterEdit))) return;
      const next = status()!;
      const nextItems = items();
      if (!nextItems.some(({ id }) => id === next.cursor.itemId) && nextItems[0]) {
        await synchronize(
          await props.client.action({ type: "cursor.move", itemId: nextItems[0].id }),
          afterEdit,
        );
      }
    } catch (error) {
      if (stopped || (editing && !afterEdit)) return;
      if (error instanceof TuiClientError && error.payload.code === "no_session") {
        latestStatus = undefined;
        batch(() => {
          setStatus(undefined);
          setDiff(undefined);
          setMessage("no session for this repo — waiting… run /gyst in your harness");
        });
      } else setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleSync(): void {
    if (syncQueued || closing || editing) return;
    syncQueued = true;
    enqueue(async () => {
      try {
        if (!editing) await sync();
      } finally {
        syncQueued = false;
      }
    });
  }

  async function refresh(): Promise<void> {
    try {
      const coherent = await synchronize(await props.client.refresh());
      setMessage(
        coherent
          ? "snapshot refreshed — changed group members need re-review"
          : "refreshed; waiting for a coherent view",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function action(next: Parameters<TuiClient["action"]>[0]): Promise<void> {
    try {
      const coherent = await synchronize(await props.client.action(next));
      if (coherent && next.type === "cursor.follow" && focusedHunk() !== next.hunkId) {
        // A rejected observation can leave the hunk id unchanged (e.g. after refresh); reveal it anyway.
        derivedFocus = undefined;
        setRevealVersion((version) => version + 1);
      }
    } catch (error) {
      if (error instanceof TuiClientError && error.payload.code === "stale_revision") {
        await sync();
        setMessage("snapshot changed, re-read");
      } else setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  /** The member occupying the diff viewport's top row; undefined while the focused member is fully shown. */
  function memberAtTop(): string | undefined {
    if (!diffPane?.visible || !reading()) return undefined;
    const viewport = diffPane.viewport;
    const box = (id: string) => diffPane!.findDescendantById(memberElementId(id));
    const focused = focusedHunk() === undefined ? undefined : box(focusedHunk()!);
    if (focused) {
      const top = focused.y - viewport.y;
      if (top >= 0 && top + focused.height <= viewport.height) return undefined;
    }
    let candidate: string | undefined;
    for (const id of focusable()) {
      const member = box(id);
      if (!member) return undefined;
      if (member.y - viewport.y <= 0) candidate = id;
      else break;
    }
    return candidate ?? focusable()[0];
  }

  // Scrolling moves the shared focus to the hunk heading the viewport. Geometry is read after a
  // rendered frame; an explicit jump's reveal or a layout restore runs first so the tracker never
  // fights them. The queue may carry an explicit jump, a poll with another TUI's focus or a snapshot
  // change ahead of the entry, so nothing observed here is trusted at dequeue: the entry is dropped
  // when the view changed meaning and otherwise re-derived from the latest completed geometry.
  function followScroll(): void {
    if (stopped || closing || editing || revealPending || anchorPending || derivedInFlight) return;
    const seen = status();
    const item = current();
    if (!seen || !item || memberAtTop() === undefined) return;
    const generation = focusGeneration;
    derivedInFlight = true;
    enqueue(async () => {
      let top: string | undefined;
      try {
        const fresh = status();
        if (
          editing ||
          revealPending ||
          anchorPending ||
          generation !== focusGeneration ||
          fresh?.session.id !== seen.session.id ||
          fresh.revision !== seen.revision ||
          current()?.id !== item.id
        )
          return;
        top = memberAtTop();
        if (top === undefined || top === focusedHunk() || !focusable().includes(top)) return;
        const attempt = [
          seen.session.id,
          seen.revision,
          item.id,
          top,
          focusGeneration,
          diffPane?.scrollTop,
        ].join(":");
        if (attempt === failedDerived) return;
        derivedFocus = top;
        await action({
          type: "cursor.follow",
          sessionId: fresh.session.id,
          revision: fresh.revision,
          seq: fresh.seq,
          itemId: item.id,
          pane: "diff",
          hunkId: top,
        });
        if (focusedHunk() !== top) failedDerived = attempt;
      } finally {
        // A failed or no-op action leaves nothing for the reveal effect to consume.
        if (derivedFocus === top) derivedFocus = undefined;
        derivedInFlight = false;
      }
    });
  }

  // A member owns its header, note and diff. Reflow retains a relative member row;
  // exact source-line mapping across split/unified layouts is deliberately not promised.
  type Anchor = { block: Renderable; row: number; height: number; scrollTop: number };
  function anchorOf(scroll: ScrollBoxRenderable): Anchor | undefined {
    let block: Renderable | undefined;
    for (const id of focusable()) {
      const candidate = scroll.findDescendantById(memberElementId(id));
      if (!candidate) continue;
      if (candidate.y <= scroll.viewport.y) block = candidate;
      else break;
    }
    return (
      block && {
        block,
        row: scroll.viewport.y - block.y,
        height: block.height,
        scrollTop: scroll.scrollTop,
      }
    );
  }
  let roundTrip: { anchor: Anchor; browseTop?: number } | undefined;
  function restorePosition(anchor: Anchor, exact?: number): void {
    cancelRestore?.();
    const scroll = diffPane!;
    const seen = status();
    anchorPending = true;
    let unchanged = 0;
    let frames = 0;
    const restore = () => {
      const fresh = status();
      if (
        anchor.block.isDestroyed ||
        fresh?.session.id !== seen?.session.id ||
        fresh?.revision !== seen?.revision ||
        fresh?.cursor.itemId !== seen?.cursor.itemId
      )
        return cancelRestore?.();
      const before = scroll.scrollTop;
      const row =
        anchor.height > 0 ? Math.round((anchor.row / anchor.height) * anchor.block.height) : 0;
      let target = exact ?? before + anchor.block.y + row - scroll.viewport.y;
      const selected = seen?.cursor.hunkId
        ? scroll.findDescendantById(memberElementId(seen.cursor.hunkId))
        : undefined;
      if (selected && selected !== anchor.block) {
        // A fully visible selection can sit below the top-row anchor. Reflow must not hide it
        // and let scroll tracking replace it. Use content coordinates from this completed frame.
        const top = before + selected.y - scroll.viewport.y;
        if (top < target || top + selected.height > target + scroll.viewport.height) target = top;
      }
      scroll.scrollTo(target);
      unchanged = scroll.scrollTop === before ? unchanged + 1 : 0;
      if (unchanged >= 2 || ++frames >= 8) {
        if (!reading() && roundTrip) roundTrip.browseTop = scroll.scrollTop;
        return cancelRestore?.();
      }
      renderer.requestRender();
    };
    cancelRestore = () => {
      renderer.off("frame", restore);
      anchorPending = false;
      cancelRestore = undefined;
    };
    renderer.on("frame", restore);
    renderer.requestRender();
  }
  createEffect(
    on([reading, () => dims().width, layoutMode, noteText], (next, previous) => {
      if (!previous || !diffPane || revealPending) return;
      const anchor = anchorOf(diffPane);
      if (!anchor) return;
      const viewOnly = next.slice(1).every((value, index) => value === previous[index + 1]);
      const exact =
        viewOnly && next[0] && roundTrip?.browseTop === diffPane.scrollTop
          ? roundTrip.anchor.scrollTop
          : undefined;
      roundTrip = viewOnly && !next[0] && previous[0] ? { anchor } : undefined;
      restorePosition(anchor, exact);
    }),
  );
  onCleanup(() => cancelRestore?.());

  // Scroll the displayed diff immediately; a queued poll must never retarget a scroll key.
  const activeScroll = () => (reading() ? diffPane : undefined);

  onMount(() => {
    // Read completed geometry: changing diff mode inside onSizeChange would mutate the tree during layout.
    const measureDiff = () => {
      if (stopped) return;
      if (diffContent && diffPane?.visible) setDiffWidth(diffContent.width);
      followScroll();
    };
    renderer.on("frame", measureDiff);
    onCleanup(() => renderer.off("frame", measureDiff));
    scheduleSync();
    const timer = setInterval(scheduleSync, props.pollInterval ?? 250);
    onCleanup(() => {
      closing = true;
      stopped = true;
      clearInterval(timer);
    });
  });

  // Group navigation keeps the pane: browsing moves the selection, reading opens the destination's first hunk.
  async function moveTo(destination: ViewItem): Promise<void> {
    if (!reading()) return action({ type: "cursor.move", itemId: destination.id });
    const first = itemMembers(destination)[0]!.id;
    await action({
      type: "cursor.focus",
      itemId: destination.id,
      pane: "diff",
      hunkId: first,
    });
  }

  useKeyboard((key) => {
    // Admission, not dequeue: even local help/layout/scroll and quit keys belong to the editor now.
    if (closing || stopped || editing) return;
    setEditorNotice("");
    if (key.name === "c" && key.ctrl) return quit(true);
    if (help()) {
      if (["?", "escape", "q"].includes(key.name)) setHelp(false);
      return;
    }
    if (key.name === "?") return setHelp(true);
    if (key.name === "1") return setLayoutMode("split");
    if (key.name === "2") return setLayoutMode("stack");
    if (key.name === "0") return setLayoutMode("auto");
    if (key.name === "q") return quit(false);
    if (key.name === "o") {
      const seen = status();
      const member = selectedMember();
      if (!seen || !reading() || !member || !props.onEdit) return;
      const displayed = memberAtTop();
      if (revealPending || anchorPending || (displayed !== undefined && displayed !== member.id))
        return setEditorNotice("focus is synchronizing — re-read and press o again");
      const request: EditRequest = {
        sessionId: seen.session.id,
        revision: seen.revision,
        repoRoot: seen.session.repoRoot,
        cursor: { ...seen.cursor },
        file: member.file,
      };
      editing = true;
      return enqueue(async () => {
        let failure = "";
        try {
          // A preceding poll/action or another TUI may have moved the shared focus. Never retarget.
          const fresh = observe(await props.client.status());
          if (
            fresh.session.id !== request.sessionId ||
            fresh.revision !== request.revision ||
            fresh.session.repoRoot !== request.repoRoot ||
            fresh.cursor.itemId !== request.cursor.itemId ||
            fresh.cursor.pane !== request.cursor.pane ||
            fresh.cursor.hunkId !== request.cursor.hunkId
          )
            throw new Error("edit target changed — re-read and press o again");
          if (!stopped) await props.onEdit!(request);
        } catch (error) {
          failure = sanitizeTerminalText(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 300);
        } finally {
          if (!stopped) {
            await sync(true);
            const guidance =
              status()?.session.source.kind === "stdin"
                ? "stdin snapshot unchanged — replace it from the harness"
                : "snapshot unchanged — r refreshes the Git snapshot";
            setEditorNotice(`${failure || "Editor returned"} · ${guidance}`);
          }
          editing = false;
        }
      });
    }
    if (key.name === "pagedown" || (key.name === "d" && key.ctrl))
      return activeScroll()?.scrollBy(0.5, "viewport");
    if (key.name === "pageup" || (key.name === "u" && key.ctrl))
      return activeScroll()?.scrollBy(-0.5, "viewport");
    if (key.name === "r")
      return enqueue(async () => {
        if (status()?.session.source.kind === "stdin") {
          setMessage(
            "stdin session — refresh it from the harness with gyst session refresh --stdin",
          );
          return;
        }
        await refresh();
      });
    if (["return", "escape", "s"].includes(key.name))
      return enqueue(async () => {
        const itemId = current()?.id;
        const hunkId = focusedHunk();
        const target = key.name === "s" ? !reading() : key.name === "return";
        if (itemId && hunkId && target !== reading())
          await action({ type: "cursor.focus", itemId, hunkId, pane: target ? "diff" : "queue" });
      });
    if (key.name === "j" || key.name === "k") {
      const delta = key.name === "j" ? 1 : -1;
      if (reading()) return activeScroll()?.scrollBy(delta);
      return enqueue(async () => {
        if (reading()) return;
        const visible = items();
        if (!visible.length) return;
        await moveTo(visible[(currentIndex() + delta + visible.length) % visible.length]!);
      });
    }
    if (key.name === "[" || key.name === "]") {
      const delta = key.name === "]" ? 1 : -1;
      return enqueue(async () => {
        const focused = focusedHunk();
        if (!reading() || focused === undefined) return;
        const ids = focusable();
        if (ids.length < 2) return;
        const next = ids[(ids.indexOf(focused) + delta + ids.length) % ids.length]!;
        await action({
          type: "cursor.focus",
          itemId: current()!.id,
          pane: "diff",
          hunkId: next,
        });
      });
    }
    if (key.name === "p" || key.name === "n") {
      const delta = key.name === "n" ? 1 : -1;
      return enqueue(async () => {
        const visible = items();
        const count = visible.length;
        for (let offset = 1; offset < count; offset++) {
          const destination =
            visible[(((currentIndex() + delta * offset) % count) + count) % count]!;
          if (destination.accepted) continue;
          await moveTo(destination);
          return;
        }
        setMessage("no other group without a verdict");
      });
    }
    if (key.name === "a" || key.name === "u") {
      // Captured at keypress: the verdict names the frame the human saw, not whatever lands later.
      const seen = status();
      if (!seen) return;
      if (!seen.queueSet)
        return setMessage("review queue is not set — waiting for the agent's pre-pass");
      const frame = { sessionId: seen.session.id, revision: seen.revision };
      if (key.name === "u") return enqueue(() => action({ type: "verdict.undo", ...frame }));
      const item = current();
      if (item && item.kind !== "inbox")
        return enqueue(() => action({ type: "verdict.toggle", itemId: item.id, ...frame }));
    }
  });

  const listRow = (item: ViewItem) => {
    const active = () => item.id === current()?.id;
    const label = item.kind === "inbox" ? item.member.file : item.title;
    // Marker, gap, count column, padding and the scrollbar share the row with the title.
    const columns = () => Math.max(1, sidebarWidth() - 8);
    return (
      <box
        id={rowElementId(item.id)}
        flexDirection="row"
        backgroundColor={active() ? C.panelAlt : C.panel}
      >
        <text fg={active() ? C.accent : C.panel} bg={active() ? C.panelAlt : C.panel}>
          ▌
        </text>
        <box flexDirection="row" justifyContent="space-between" flexGrow={1} paddingRight={1}>
          <text
            fg={item.accepted ? C.ok : item.kind === "inbox" ? C.accent : active() ? C.fg : C.muted}
          >
            {item.accepted ? "✓" : item.kind === "inbox" ? "!" : "·"} {label.slice(0, columns())}
          </text>
          {item.kind === "group" && <text fg={C.dim}>{item.members.length}</text>}
        </box>
      </box>
    );
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={C.bg}>
      <Show
        when={status() && diff()}
        fallback={
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={C.muted}>{message()}</text>
          </box>
        }
      >
        {(_attached) => (
          <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
            <box
              flexDirection="row"
              justifyContent="space-between"
              paddingLeft={1}
              paddingRight={1}
            >
              <text>
                <Sp fg={C.fg} attributes={1}>
                  {(reading() && current()
                    ? itemTitle(current()!)
                    : scopeLabel(status()!.session.source)
                  ).slice(0, Math.max(12, dims().width - position().length - 6))}
                </Sp>
                <Show when={reading() && current()?.accepted}>
                  <Sp fg={C.okBadge}> ✓</Sp>
                </Show>
              </text>
              <text fg={C.dim}>{position()}</text>
            </box>
            <box paddingLeft={1}>
              <text fg={C.dim}>{hint()}</text>
            </box>
            <box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0}>
              <scrollbox
                id="group-list"
                visible={!reading()}
                ref={(scrollbox: ScrollBoxRenderable) => (groupList = scrollbox)}
                width={sidebarWidth()}
                flexShrink={0}
                backgroundColor={C.panel}
                paddingTop={1}
                paddingBottom={1}
              >
                <box flexDirection="column" width="100%">
                  <For each={items()}>{listRow}</For>
                </box>
              </scrollbox>
              <scrollbox
                id="diff-pane"
                minWidth={0}
                flexBasis={0}
                ref={(scrollbox: ScrollBoxRenderable) => (diffPane = scrollbox)}
                flexGrow={1}
                paddingLeft={1}
                paddingRight={1}
                border={["top"]}
                borderColor={pane() === "diff" ? C.accent : C.border}
                title={reading() ? " ▍diff " : " diff "}
                titleColor={pane() === "diff" ? C.accent : C.dim}
              >
                <box
                  ref={(box: BoxRenderable) => (diffContent = box)}
                  width="100%"
                  flexDirection="column"
                >
                  <Show when={currentKey()} keyed>
                    <GroupDiff
                      item={current()!}
                      focusedHunk={focusedHunk()}
                      layout={resolvedLayout()}
                      showNotes={reading()}
                    />
                  </Show>
                </box>
              </scrollbox>
            </box>
          </box>
        )}
      </Show>
      <Show when={status()}>
        <Show
          when={allDone()}
          fallback={
            <Show when={!status()!.queueSet || status()!.inbox.length > 0}>
              <text fg={C.muted}>
                {!status()!.queueSet || status()!.groups.length === 0
                  ? `preparing — ${status()!.inbox.length} hunks awaiting preparation`
                  : status()!.groups.every((group) => group.accepted)
                    ? `reviewed everything prepared so far — ${status()!.inbox.length} hunks awaiting preparation`
                    : `${status()!.inbox.length} hunks awaiting preparation`}
              </text>
            </Show>
          }
        >
          <text fg={C.okBadge}>
            ✓ review complete — {items().length}/{items().length} done · u undo · q quit
          </text>
        </Show>
      </Show>
      <Show when={sourceNotice()}>
        <text fg={C.accent}>{sourceNotice()}</text>
      </Show>
      <Show when={Boolean(message() || editorNotice()) && Boolean(status())}>
        <text fg={C.accent}>{message() || editorNotice()}</text>
      </Show>
      <Show when={help()}>
        <box
          position="absolute"
          left={Math.max(0, Math.floor((dims().width - 64) / 2))}
          top={2}
          width={64}
          zIndex={10}
          backgroundColor={C.panel}
          border
          borderColor={C.border}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text fg={C.fg} attributes={1}>
              keys
            </text>
            <text fg={C.dim}>? / esc</text>
          </box>
          <text> </text>
          <For
            each={[
              ["j / k", "browse: select group; reading: scroll a line"],
              ["enter / esc", "hide / show the sidebar"],
              ["[ / ]", "previous / next hunk in the group"],
              ["p / n", "previous / next group without a verdict"],
              ["s", "toggle the sidebar (notes show only while hidden)"],
              ["^d / ^u", "scroll half a page (PgDn / PgUp)"],
              ["a", "mark the group done and advance (again to unmark)"],
              ["u", "undo the last verdict"],
              ["1 / 2 / 0", "split / stack / auto diff layout"],
              ["o", "reading: EDITOR opens the working-tree file, not the snapshot"],
              ["r", "refresh the Git snapshot; stdin: replace from the harness"],
              ["q", "quit"],
            ]}
          >
            {([key, description]) => (
              <text>
                <Sp fg={C.accent}>{key!.padEnd(13)}</Sp>
                <Sp fg={C.muted}>{description}</Sp>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}
