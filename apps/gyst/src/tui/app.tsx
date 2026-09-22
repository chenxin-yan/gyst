import type { DiffPayload, Hunk, Source, StatusPayload } from "@gyst/core";
import { pathToFiletype, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions, type SpanProps } from "@opentui/solid";
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
      tldr: string;
      accepted: boolean;
      exemplar: Member;
      members: Member[];
    }
  | { kind: "spotlight"; id: string; tldr: string; accepted: boolean; member: Member }
  | { kind: "inbox"; id: string; accepted: false; member: Member };
type LayoutMode = "auto" | "split" | "stack";

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
    const exemplar = hunks.get(group.exemplarHunkId);
    return members.length && exemplar
      ? [
          {
            kind: "group",
            id: group.id,
            tldr: group.tldr,
            accepted: group.accepted,
            exemplar,
            members,
          },
        ]
      : [];
  });
  const spotlight = status.spotlight.flatMap((hunk): ViewItem[] => {
    const member = hunks.get(hunk.id);
    return member
      ? [{ kind: "spotlight", id: hunk.id, tldr: hunk.tldr, accepted: hunk.accepted, member }]
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
  expanded: boolean;
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
        <Note text={props.item.tldr} />
        <text> </text>
        <Show
          when={props.expanded}
          fallback={
            <box flexDirection="column">
              <text fg={C.dim}>exemplar · 1 of {props.item.members.length}</text>
              <MemberDiff
                member={props.item.exemplar}
                layout={props.layout}
                focused={focused(props.item.exemplar)}
              />
              <text fg={C.dim}>(e to expand)</text>
            </box>
          }
        >
          <box flexDirection="column">
            <text fg={C.dim}>
              all {props.item.members.length} members (e to fold
              {props.focusedHunk === undefined
                ? ", enter to step through"
                : ", j/k to step, esc to leave"}
              )
            </text>
            <For each={props.item.members}>
              {(member) => (
                <box paddingBottom={1}>
                  <MemberDiff member={member} layout={props.layout} focused={focused(member)} />
                </box>
              )}
            </For>
          </box>
        </Show>
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
        <Note text={props.item.tldr} />
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
  pollInterval?: number;
}) {
  const dims = useTerminalDimensions();
  const [status, setStatus] = createSignal<StatusPayload>();
  const [diff, setDiff] = createSignal<DiffPayload>();
  const [message, setMessage] = createSignal("attaching…");
  const [sidebar, setSidebar] = createSignal(true);
  const [help, setHelp] = createSignal(false);
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>("auto");
  // `closing` stops admitting inputs and polls while the queue drains; `stopped` means the renderer is gone.
  let closing = false;
  let stopped = false;
  let syncQueued = false;
  let latestStatus: StatusPayload | undefined;
  let inputs = Promise.resolve();
  let focusCard: ScrollBoxRenderable | undefined;

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
    return item && `${item.kind}:${item.id}`;
  });
  const focusedHunk = () => status()?.cursor.hunkId;
  // Hunks the focused cursor can step through: a group's members in order, or the lone hunk.
  const focusable = createMemo(() => {
    const item = current();
    if (!item) return [];
    return item.kind === "group" ? item.members.map(({ id }) => id) : [item.id];
  });
  const resolvedLayout = createMemo(() => {
    const mode = layoutMode();
    return mode === "auto" ? (dims().width >= 120 ? "split" : "stack") : mode;
  });
  // A ready session has an empty inbox, so a ready empty queue is also complete.
  const allDone = createMemo(
    () => status()?.ready === true && items().every((item) => item.accepted),
  );
  createEffect(
    on(
      () => current()?.id,
      () => focusCard?.scrollTo(0),
    ),
  );
  createEffect(
    on(focusedHunk, (hunkId) => {
      if (hunkId !== undefined) focusCard?.scrollChildIntoView(memberElementId(hunkId));
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

  async function synchronize(next: StatusPayload): Promise<boolean> {
    next = observe(next);
    let nextDiff = diff();
    if (!matches(next, nextDiff)) nextDiff = await props.client.diff();
    if (!matches(next, nextDiff)) next = observe(await props.client.status());
    // A harness may mutate between reads. Keep the last coherent frame and retry on the next poll.
    if (stopped || !matches(next, nextDiff)) return false;
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

  async function sync(): Promise<void> {
    try {
      if (!(await synchronize(await props.client.status()))) return;
      const next = status()!;
      const nextItems = items();
      if (!nextItems.some(({ id }) => id === next.cursor.itemId) && nextItems[0]) {
        await synchronize(
          await props.client.action({ type: "cursor.move", itemId: nextItems[0].id }),
        );
      }
    } catch (error) {
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
    if (syncQueued || closing) return;
    syncQueued = true;
    enqueue(async () => {
      try {
        await sync();
      } finally {
        syncQueued = false;
      }
    });
  }

  async function refresh(): Promise<void> {
    try {
      const coherent = await synchronize(await props.client.refresh());
      setMessage(coherent ? "snapshot refreshed" : "refreshed; waiting for a coherent view");
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
    scheduleSync();
    const timer = setInterval(scheduleSync, props.pollInterval ?? 250);
    onCleanup(() => {
      closing = true;
      stopped = true;
      clearInterval(timer);
    });
  });

  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) return quit(true);
    if (help()) {
      if (["?", "escape", "q"].includes(key.name)) setHelp(false);
      return;
    }
    if (key.name === "?") return setHelp(true);
    if (key.name === "1") return setLayoutMode("split");
    if (key.name === "2") return setLayoutMode("stack");
    if (key.name === "0") return setLayoutMode("auto");
    if (key.name === "s") return setSidebar(!sidebar());
    if (key.name === "q") return quit(false);
    if (key.name === "pagedown" || (key.name === "d" && key.ctrl))
      return focusCard?.scrollBy(0.5, "viewport");
    if (key.name === "pageup" || (key.name === "u" && key.ctrl))
      return focusCard?.scrollBy(-0.5, "viewport");
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
        if (first !== undefined && focusedHunk() === undefined)
          await action({ type: "cursor.focus", hunkId: first });
      });
    if (key.name === "escape")
      return enqueue(async () => {
        if (focusedHunk() !== undefined) await action({ type: "cursor.focus", hunkId: null });
      });
    if (key.name === "j" || key.name === "k")
      return enqueue(async () => {
        const delta = key.name === "j" ? 1 : -1;
        const focused = focusedHunk();
        if (focused !== undefined) {
          const ids = focusable();
          if (ids.length < 2) return;
          const next = ids[(ids.indexOf(focused) + delta + ids.length) % ids.length]!;
          await action({ type: "cursor.focus", hunkId: next });
          return;
        }
        const visible = items();
        if (!visible.length) return;
        const destination = visible[(currentIndex() + delta + visible.length) % visible.length]!;
        await action({ type: "cursor.move", itemId: destination.id });
      });
    if (key.name === "e")
      return enqueue(async () => {
        if (current()?.kind === "group") await action({ type: "expand.toggle" });
      });
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

  const sidebarRow = (item: ViewItem) => {
    const active = () => item.id === current()?.id;
    const label = item.kind === "group" ? item.tldr : item.member.file;
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
          <box flexDirection="row" flexGrow={1}>
            <Show when={sidebar()}>
              <box
                width={27}
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
                <For each={items()}>{sidebarRow}</For>
              </box>
            </Show>
            <Show
              when={!allDone()}
              fallback={
                <box
                  flexGrow={1}
                  justifyContent="center"
                  alignItems="center"
                  flexDirection="column"
                >
                  <text fg={C.okBadge} attributes={1}>
                    ✓ review complete — {items().length}/{items().length} accepted
                  </text>
                  <text fg={C.muted}>
                    you read {items().length} things, not {diff()?.hunks.length ?? 0} hunks · u undo
                    · q quit
                  </text>
                </box>
              }
            >
              <scrollbox
                ref={(scrollbox: ScrollBoxRenderable) => (focusCard = scrollbox)}
                flexGrow={1}
                paddingLeft={2}
                paddingTop={1}
                paddingRight={2}
                flexDirection="column"
              >
                <Show when={currentKey()} keyed fallback={<text>no review items</text>}>
                  <FocusCard
                    item={current()!}
                    expanded={status()!.cursor.expanded}
                    focusedHunk={focusedHunk()}
                    layout={resolvedLayout()}
                  />
                </Show>
              </scrollbox>
            </Show>
          </box>
        )}
      </Show>
      <Show when={Boolean(message()) && Boolean(status())}>
        <text fg={C.accent}>{message()}</text>
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
              ["j / k", "next / previous item, or hunk when focused"],
              ["enter / esc", "focus / leave the diff pane"],
              ["^d / ^u", "scroll item down / up (PgDn / PgUp)"],
              ["a", "accept — done reviewing (toggle)"],
              ["e", "expand group members (toggle)"],
              ["u", "undo last accept"],
              ["s", "toggle sidebar"],
              ["1 / 2 / 0", "split / stack / auto layout"],
              ["r", "refresh snapshot"],
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
