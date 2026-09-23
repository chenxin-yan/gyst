import {
  sanitizeOverview,
  type DiffPayload,
  type Hunk,
  type Source,
  type StatusPayload,
} from "@gyst/core";
import {
  pathToFiletype,
  SyntaxStyle,
  type BoxRenderable,
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
      overview: string;
      accepted: boolean;
      members: Member[];
    }
  | {
      kind: "spotlight";
      id: string;
      title: string;
      overview: string;
      accepted: boolean;
      member: Member;
    }
  | { kind: "inbox"; id: string; accepted: false; member: Member };
type LayoutMode = "auto" | "split" | "stack";
const LAYOUT = { zoomColumns: 120, overviewPercent: 40, splitColumns: 120, queueColumns: 27 };

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
            overview: group.overview,
            accepted: group.accepted,
            members,
          },
        ]
      : [];
  });
  const spotlight = status.spotlight.flatMap((hunk): ViewItem[] => {
    const member = hunks.get(hunk.id);
    return member
      ? [
          {
            kind: "spotlight",
            id: hunk.id,
            title: hunk.title,
            overview: hunk.overview,
            accepted: hunk.accepted,
            member,
          },
        ]
      : [];
  });
  const inbox = status.inbox.flatMap((hunk): ViewItem[] => {
    const member = hunks.get(hunk.id);
    return member ? [{ kind: "inbox", id: hunk.id, accepted: false, member }] : [];
  });
  const byId = new Map([...groups, ...spotlight, ...inbox].map((item) => [item.id, item]));
  return [...status.queue, ...byId.keys()].flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    byId.delete(id);
    return [item];
  });
}

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

/** The box id lets the focus card scroll a focused member into view. */
const memberElementId = (hunkId: string) => `hunk:${hunkId}`;

function MemberDiff(props: { member: Member; layout: "split" | "stack"; focused: boolean }) {
  return (
    <box flexDirection="column" id={memberElementId(props.member.id)}>
      <FileHeader member={props.member} focused={props.focused} />
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

function Note(props: { text: string }) {
  return (
    <box flexDirection="row" backgroundColor={C.panel} marginTop={1}>
      <text fg={C.accent} bg={C.panel}>
        ▌{" "}
      </text>
      <text fg={C.fg} bg={C.panel}>
        {props.text}
      </text>
    </box>
  );
}

function VerdictTag(props: { accepted: boolean }) {
  return (
    <Show when={props.accepted}>
      <Sp fg={C.okBadge} attributes={1}>
        {" "}
        ✓ accepted
      </Sp>
    </Show>
  );
}

function FocusCard(props: {
  item: ViewItem;
  focusedHunk: string | undefined;
  layout: "split" | "stack";
}) {
  const focused = (member: Member) => member.id === props.focusedHunk;
  if (props.item.kind === "group")
    return (
      <box flexDirection="column">
        <text>
          <Sp fg={C.accent} attributes={1}>
            ▍GROUP
          </Sp>
          <Sp fg={C.dim}> ×{props.item.members.length}</Sp>
          <VerdictTag accepted={props.item.accepted} />
        </text>
        <Note text={props.item.title} />
        <text> </text>
        <text fg={C.dim}>
          all {props.item.members.length} members (
          {props.focusedHunk === undefined ? "enter to step through" : "j/k to step, esc to leave"})
        </text>
        <For each={props.item.members}>
          {(member) => (
            <box paddingBottom={1}>
              <MemberDiff member={member} layout={props.layout} focused={focused(member)} />
            </box>
          )}
        </For>
      </box>
    );
  if (props.item.kind === "spotlight")
    return (
      <box flexDirection="column">
        <text>
          <Sp fg={C.okBadge} attributes={1}>
            ▍SPOTLIGHT{" "}
          </Sp>
          <Sp fg={C.fg} attributes={1}>
            {props.item.member.file}
          </Sp>
          <VerdictTag accepted={props.item.accepted} />
        </text>
        <text fg={C.muted} attributes={2}>
          {props.item.member.header}
        </text>
        <Note text={props.item.title} />
        <text> </text>
        <MemberDiff
          member={props.item.member}
          layout={props.layout}
          focused={focused(props.item.member)}
        />
      </box>
    );
  return (
    <box flexDirection="column">
      <text>
        <Sp fg={C.accent} attributes={1}>
          ▍INBOX{" "}
        </Sp>
        <Sp fg={C.fg} attributes={1}>
          {props.item.member.file}
        </Sp>
      </text>
      <text fg={C.accent}>awaiting agent triage — verdict unavailable</text>
      <text fg={C.muted} attributes={2}>
        {props.item.member.header}
      </text>
      <text> </text>
      <MemberDiff
        member={props.item.member}
        layout={props.layout}
        focused={focused(props.item.member)}
      />
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
  const [diffWidth, setDiffWidth] = createSignal(0);
  const [help, setHelp] = createSignal(false);
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>("auto");
  // `closing` stops admitting inputs and polls while the queue drains; `stopped` means the renderer is gone.
  let closing = false;
  let stopped = false;
  let editing = false;
  let syncQueued = false;
  let latestStatus: StatusPayload | undefined;
  let inputs = Promise.resolve();
  let focusCard: ScrollBoxRenderable | undefined;
  let overviewPane: ScrollBoxRenderable | undefined;
  let diffContent: BoxRenderable | undefined;

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
  // The focus card is rebuilt only when the item or its kind changes, not on every poll.
  const currentKey = createMemo(() => {
    const item = current();
    return item && `${status()!.session.id}:${item.kind}:${item.id}`;
  });
  // A memo, so a poll that returns the same focus does not re-run the reveal below.
  const focusedHunk = createMemo(() => status()?.cursor.hunkId);
  const pane = createMemo(() => status()?.cursor.pane ?? "queue");
  const zoomed = createMemo(() => pane() !== "queue");
  const wide = createMemo(() => dims().width >= LAYOUT.zoomColumns);
  const overview = createMemo(() => {
    const item = current();
    return sanitizeOverview(
      item && item.kind !== "inbox"
        ? item.overview
        : "Unprepared hunk — awaiting agent preparation. Verdict unavailable.",
    );
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
    if (!item) return [];
    return item.kind === "group" ? item.members.map(({ id }) => id) : [item.id];
  });
  const resolvedLayout = createMemo(() => {
    const mode = layoutMode();
    return mode === "auto" ? (diffWidth() >= LAYOUT.splitColumns ? "split" : "stack") : mode;
  });
  // A ready session has an empty inbox, so a ready empty queue is also complete.
  const allDone = createMemo(
    () => status()?.ready === true && items().every((item) => item.accepted),
  );
  // Keyed on the id, not the item object: every poll rebuilds the items, and only a move should reset the scroll.
  createEffect(
    on([currentKey, zoomed], () => {
      focusCard?.scrollTo(0);
      overviewPane?.scrollTo(0);
    }),
  );
  // Reveal the focused member when the focus moves or its card is (re)mounted. Positions exist only
  // after layout, which happens inside a render, so the scroll waits for a rendered frame. A narrow
  // overview hides the diff pane, which then has no layout: the reveal stays pending until a frame shows it.
  createEffect(
    on([focusedHunk, currentKey], ([hunkId]) => {
      if (hunkId === undefined) return;
      // A hunk that does not fit goes to the top of the viewport: reading starts at its header, and a
      // hunk taller than the viewport would otherwise be revealed by its tail.
      const reveal = () => {
        const member = focusCard?.findDescendantById(memberElementId(hunkId));
        if (!focusCard?.visible || !member) return;
        renderer.off("frame", reveal);
        const top = member.y - focusCard.viewport.y;
        if (top < 0 || top + member.height > focusCard.viewport.height) focusCard.scrollBy(top);
      };
      renderer.on("frame", reveal);
      renderer.requestRender();
      onCleanup(() => renderer.off("frame", reveal));
    }),
  );

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
      await synchronize(await props.client.action(next));
    } catch (error) {
      if (error instanceof TuiClientError && error.payload.code === "stale_revision") {
        await sync();
        setMessage("snapshot changed, re-read");
      } else setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  onMount(() => {
    // Read completed geometry: changing diff mode inside onSizeChange would mutate the tree during layout.
    const measureDiff = () => {
      if (!stopped && diffContent && focusCard?.visible) setDiffWidth(diffContent.width);
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
      if (!seen || !zoomed() || !member || !props.onEdit) return;
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
          failure = sanitizeOverview(error instanceof Error ? error.message : String(error)).slice(
            0,
            300,
          );
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
    const activeScroll = () => (pane() === "overview" ? overviewPane : focusCard);
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
    if (key.name === "return")
      return enqueue(async () => {
        const first = focusable()[0];
        const itemId = current()?.id;
        if (itemId && first !== undefined && pane() === "queue")
          await action({ type: "cursor.focus", itemId, pane: "diff", hunkId: first });
      });
    if (key.name === "escape")
      return enqueue(async () => {
        const itemId = current()?.id;
        if (itemId && zoomed()) await action({ type: "cursor.focus", itemId, pane: "queue" });
      });
    if (key.name === "tab")
      return enqueue(async () => {
        const itemId = current()?.id;
        const hunkId = focusedHunk();
        if (itemId && hunkId && zoomed())
          await action({
            type: "cursor.focus",
            itemId,
            hunkId,
            pane: pane() === "diff" ? "overview" : "diff",
          });
      });
    if (key.name === "j" || key.name === "k") {
      const delta = key.name === "j" ? 1 : -1;
      // Scroll the displayed pane now; a queued poll may replace the shared view.
      if (pane() === "overview") return overviewPane?.scrollBy(delta);
      return enqueue(async () => {
        if (pane() === "overview") return;
        const focused = focusedHunk();
        if (focused !== undefined) {
          const ids = focusable();
          if (ids.length < 2) return;
          const next = ids[(ids.indexOf(focused) + delta + ids.length) % ids.length]!;
          await action({ type: "cursor.focus", itemId: current()!.id, pane: "diff", hunkId: next });
          return;
        }
        const visible = items();
        if (!visible.length) return;
        const destination = visible[(currentIndex() + delta + visible.length) % visible.length]!;
        await action({ type: "cursor.move", itemId: destination.id });
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

  const queueRow = (item: ViewItem) => {
    const active = () => item.id === current()?.id;
    const label = item.kind === "inbox" ? item.member.file : item.title;
    return (
      <box flexDirection="row" backgroundColor={active() ? C.panelAlt : C.panel}>
        <text fg={active() ? C.accent : C.panel} bg={active() ? C.panelAlt : C.panel}>
          ▌
        </text>
        <box flexDirection="row" justifyContent="space-between" flexGrow={1} paddingRight={1}>
          <text
            fg={item.accepted ? C.ok : item.kind === "inbox" ? C.accent : active() ? C.fg : C.muted}
          >
            {item.accepted ? "✓" : item.kind === "inbox" ? "!" : "·"} {label.slice(0, 19)}
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
            <Show when={zoomed() && current()}>
              <text fg={C.accent} flexShrink={0}>
                {current()!.kind === "inbox"
                  ? "Unprepared hunk"
                  : (current() as Exclude<ViewItem, { kind: "inbox" }>).title}
                {" — "}
                {selectedMember()?.file} {selectedMember()?.header}
                {" — "}
                {pane() === "diff" ? "[diff] / overview" : "diff / [overview]"}
              </text>
            </Show>
            <box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0}>
              <Show when={!zoomed()}>
                <box
                  width={LAYOUT.queueColumns}
                  flexDirection="column"
                  backgroundColor={C.panel}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <text fg={C.dim} attributes={1}>
                    {"  REVIEW QUEUE"}
                  </text>
                  <text fg={C.muted}>
                    {"  "}
                    {scopeLabel(status()!.session.source).slice(0, 25)}
                  </text>
                  <For each={items()}>{queueRow}</For>
                </box>
              </Show>
              <scrollbox
                id="diff-pane"
                visible={!zoomed() || wide() || pane() === "diff"}
                width={zoomed() && wide() ? `${100 - LAYOUT.overviewPercent}%` : "auto"}
                ref={(scrollbox: ScrollBoxRenderable) => (focusCard = scrollbox)}
                flexGrow={1}
                paddingLeft={2}
                paddingTop={1}
                paddingRight={2}
                flexDirection="column"
              >
                <box
                  ref={(box: BoxRenderable) => (diffContent = box)}
                  width="100%"
                  flexDirection="column"
                >
                  <Show when={currentKey()} keyed fallback={<text>no review items</text>}>
                    <FocusCard
                      item={current()!}
                      focusedHunk={focusedHunk()}
                      layout={resolvedLayout()}
                    />
                  </Show>
                </box>
              </scrollbox>
              <scrollbox
                id="overview-pane"
                ref={(scrollbox: ScrollBoxRenderable) => (overviewPane = scrollbox)}
                visible={zoomed() && (wide() || pane() === "overview")}
                width={wide() ? `${LAYOUT.overviewPercent}%` : "auto"}
                flexGrow={1}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
              >
                <Show when={zoomed() && currentKey()} keyed>
                  <markdown
                    id="overview-markdown"
                    content={overview()}
                    syntaxStyle={syntax()}
                    conceal={true}
                  />
                </Show>
              </scrollbox>
            </box>
          </box>
        )}
      </Show>
      <Show when={status()}>
        <text fg={allDone() ? C.okBadge : C.muted}>
          {allDone()
            ? `✓ review complete — ${items().length}/${items().length} accepted · u undo · q quit`
            : !status()!.queueSet || status()!.groups.length + status()!.spotlight.length === 0
              ? `preparing — ${status()!.inbox.length} hunks awaiting preparation`
              : [...status()!.groups, ...status()!.spotlight].every((item) => item.accepted) &&
                  status()!.inbox.length > 0
                ? `reviewed everything prepared so far — ${status()!.inbox.length} hunks awaiting preparation`
                : `ready to review these items — ${status()!.inbox.length} hunks awaiting preparation`}
        </text>
      </Show>
      <Show when={Boolean(message() || editorNotice()) && Boolean(status())}>
        <text fg={C.accent}>{message() || editorNotice()}</text>
      </Show>
      <Show when={help()}>
        <box
          position="absolute"
          left={Math.max(0, Math.floor((dims().width - 60) / 2))}
          top={4}
          width={60}
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
              ["j / k", "queue: item; diff: hunk; overview: scroll line"],
              ["enter / esc", "zoom into item / return to queue"],
              ["tab / S-tab", "switch diff / overview when zoomed"],
              ["^d / ^u", "scroll active pane half page (PgDn / PgUp)"],
              ["a", "accept whole item (all group members), advance"],
              ["u", "undo last accept"],
              ["1 / 2 / 0", "split / stack / auto layout"],
              ["o", "zoom: EDITOR opens working-tree file, not snapshot"],
              ["r", "refresh Git snapshot; stdin: replace from harness"],
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
