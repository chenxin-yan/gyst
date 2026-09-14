import type { DiffPayload, Hunk, StatusPayload } from "@gyst/core";
import { useKeyboard, useTerminalDimensions, type SpanProps } from "@opentui/solid";
import { For, Show, batch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
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

// SpanProps omits fg/bg/attributes while OpenTUI applies them at runtime (confirmed by the prototype).
const Sp = (props: SpanProps & { fg?: string; bg?: string; attributes?: number }) => (
  <span {...props} />
);

type DiffLine = { sign: " " | "+" | "-"; text: string };
type Member = {
  id: string;
  file: string;
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
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
type NumberedLine = DiffLine & { oldNo: number | null; newNo: number | null };
type SplitCell = NumberedLine | null;

function memberOf(hunk: Hunk): Member {
  const firstNewline = hunk.patch.indexOf("\n");
  const header = firstNewline < 0 ? hunk.patch : hunk.patch.slice(0, firstNewline);
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(header);
  const lines = (firstNewline < 0 ? "" : hunk.patch.slice(firstNewline + 1))
    .split("\n")
    .flatMap((line): DiffLine[] => {
      const sign = line[0];
      return sign === " " || sign === "+" || sign === "-" ? [{ sign, text: line.slice(1) }] : [];
    });
  return {
    id: hunk.id,
    file: hunk.file,
    header,
    oldStart: Number(match?.[1] ?? 1),
    newStart: Number(match?.[2] ?? 1),
    lines,
  };
}

function buildItems(status: StatusPayload, diff: DiffPayload): ViewItem[] {
  const hunks = new Map(diff.hunks.map((hunk) => [hunk.id, memberOf(hunk)]));
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

function numberLines(member: Member): NumberedLine[] {
  let oldNo = member.oldStart;
  let newNo = member.newStart;
  return member.lines.map((line) => {
    if (line.sign === " ") return { ...line, oldNo: oldNo++, newNo: newNo++ };
    if (line.sign === "-") return { ...line, oldNo: oldNo++, newNo: null };
    return { ...line, oldNo: null, newNo: newNo++ };
  });
}

function splitRows(lines: NumberedLine[]): Array<{ left: SplitCell; right: SplitCell }> {
  const rows: Array<{ left: SplitCell; right: SplitCell }> = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.sign === " ") {
      rows.push({ left: lines[index]!, right: lines[index]! });
      index++;
      continue;
    }
    const removed: NumberedLine[] = [];
    const added: NumberedLine[] = [];
    while (index < lines.length && lines[index]!.sign !== " ") {
      (lines[index]!.sign === "-" ? removed : added).push(lines[index]!);
      index++;
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      rows.push({ left: removed[offset] ?? null, right: added[offset] ?? null });
    }
  }
  return rows;
}

function stackRows(lines: NumberedLine[]): NumberedLine[] {
  const rows: NumberedLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.sign === " ") {
      rows.push(lines[index]!);
      index++;
      continue;
    }
    const removed: NumberedLine[] = [];
    const added: NumberedLine[] = [];
    while (index < lines.length && lines[index]!.sign !== " ") {
      (lines[index]!.sign === "-" ? removed : added).push(lines[index]!);
      index++;
    }
    rows.push(...removed, ...added);
  }
  return rows;
}

const rowBg = (sign: DiffLine["sign"]) => (sign === "+" ? C.addBg : sign === "-" ? C.delBg : C.bg);
const gutterBg = (sign: DiffLine["sign"]) =>
  sign === "+" ? C.addGutterBg : sign === "-" ? C.delGutterBg : C.bg;
const signFg = (sign: DiffLine["sign"]) =>
  sign === "+" ? C.addSign : sign === "-" ? C.delSign : C.dim;
const pad = (line: number | null, width: number) =>
  (line === null ? "" : String(line)).padStart(width);

function StackRow(props: { row: NumberedLine; width: number }) {
  return (
    <box flexDirection="row" backgroundColor={rowBg(props.row.sign)}>
      <text
        fg={props.row.sign === " " ? C.dim : signFg(props.row.sign)}
        bg={gutterBg(props.row.sign)}
      >
        {pad(props.row.oldNo, props.width)} {pad(props.row.newNo, props.width)}{" "}
        {props.row.sign === " " ? " " : props.row.sign}{" "}
      </text>
      <text fg={props.row.sign === " " ? C.muted : C.fg}> {props.row.text}</text>
    </box>
  );
}

function SplitHalf(props: { cell: SplitCell; width: number; side: "left" | "right" }) {
  const number = () => (props.side === "left" ? props.cell!.oldNo : props.cell!.newNo);
  const sign = (): DiffLine["sign"] =>
    props.cell!.sign === " " ? " " : props.side === "left" ? "-" : "+";
  return (
    <Show
      when={props.cell}
      fallback={
        <box flexGrow={1} flexBasis={0} backgroundColor={C.panelAlt}>
          <text> </text>
        </box>
      }
    >
      <box flexGrow={1} flexBasis={0} flexDirection="row" backgroundColor={rowBg(sign())}>
        <text fg={props.cell!.sign === " " ? C.dim : signFg(sign())} bg={gutterBg(sign())}>
          {pad(number(), props.width)} {props.cell!.sign === " " ? " " : sign()}{" "}
        </text>
        <text fg={props.cell!.sign === " " ? C.muted : C.fg}> {props.cell!.text}</text>
      </box>
    </Show>
  );
}

function FileHeader(props: { member: Member }) {
  const added = () => props.member.lines.filter(({ sign }) => sign === "+").length;
  const removed = () => props.member.lines.filter(({ sign }) => sign === "-").length;
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={C.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={C.fg}>{props.member.file}</text>
      <text>
        <Show when={added()}>
          <Sp fg={C.ok}>+{added()}</Sp>
        </Show>
        <Show when={removed()}>
          <Sp fg={C.delBadge}> -{removed()}</Sp>
        </Show>
      </text>
    </box>
  );
}

function MemberDiff(props: { member: Member; layout: "split" | "stack" }) {
  const width = () =>
    String(Math.max(props.member.oldStart, props.member.newStart) + props.member.lines.length)
      .length;
  const numbered = () => numberLines(props.member);
  return (
    <box flexDirection="column">
      <FileHeader member={props.member} />
      <Show
        when={props.layout === "split"}
        fallback={
          <For each={stackRows(numbered())}>{(row) => <StackRow row={row} width={width()} />}</For>
        }
      >
        <For each={splitRows(numbered())}>
          {(row) => (
            <box flexDirection="row">
              <SplitHalf cell={row.left} width={width()} side="left" />
              <text fg={C.border}>▌</text>
              <SplitHalf cell={row.right} width={width()} side="right" />
            </box>
          )}
        </For>
      </Show>
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

function FocusCard(props: { item: ViewItem; expanded: boolean; layout: "split" | "stack" }) {
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
              <MemberDiff member={props.item.exemplar} layout={props.layout} />
              <text fg={C.dim}>(e to expand)</text>
            </box>
          }
        >
          <box flexDirection="column">
            <text fg={C.dim}>all {props.item.members.length} members (e to fold)</text>
            <For each={props.item.members}>
              {(member) => (
                <box paddingBottom={1}>
                  <MemberDiff member={member} layout={props.layout} />
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
        <MemberDiff member={props.item.member} layout={props.layout} />
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
      <MemberDiff member={props.item.member} layout={props.layout} />
    </box>
  );
}

export function App(props: { client: TuiClient; onQuit?: () => void; pollInterval?: number }) {
  const dims = useTerminalDimensions();
  const [status, setStatus] = createSignal<StatusPayload>();
  const [diff, setDiff] = createSignal<DiffPayload>();
  const [message, setMessage] = createSignal("attaching…");
  const [sidebar, setSidebar] = createSignal(true);
  const [help, setHelp] = createSignal(false);
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>("auto");
  let stopped = false;
  let syncQueued = false;
  let latestStatus: StatusPayload | undefined;
  let inputs = Promise.resolve();

  const items = createMemo(() => (status() && diff() ? buildItems(status()!, diff()!) : []));
  const currentIndex = createMemo(() =>
    Math.max(
      0,
      items().findIndex(({ id }) => id === status()?.cursor.itemId),
    ),
  );
  const current = createMemo(() => items()[currentIndex()]);
  const resolvedLayout = createMemo(() => {
    const mode = layoutMode();
    return mode === "auto" ? (dims().width >= 120 ? "split" : "stack") : mode;
  });
  const allDone = createMemo(
    () => items().length > 0 && items().every((item) => item.kind !== "inbox" && item.accepted),
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
    inputs = inputs.then(() => {
      if (!stopped) return operation();
    });
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
    if (syncQueued || stopped) return;
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
      await synchronize(await props.client.refresh());
      setMessage("snapshot refreshed");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function action(next: Parameters<TuiClient["action"]>[0]): Promise<void> {
    try {
      await synchronize(await props.client.action(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  onMount(() => {
    scheduleSync();
    const timer = setInterval(scheduleSync, props.pollInterval ?? 250);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  useKeyboard((key) => {
    if (help()) {
      if (["?", "escape", "q"].includes(key.name)) setHelp(false);
      return;
    }
    if (key.name === "?") return setHelp(true);
    if (key.name === "1") return setLayoutMode("split");
    if (key.name === "2") return setLayoutMode("stack");
    if (key.name === "0") return setLayoutMode("auto");
    if (key.name === "s") return setSidebar(!sidebar());
    if (key.name === "q") return props.onQuit?.();
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
    if (key.name === "j" || key.name === "k")
      return enqueue(async () => {
        const visible = items();
        if (!visible.length) return;
        const delta = key.name === "j" ? 1 : -1;
        const destination = visible[(currentIndex() + delta + visible.length) % visible.length]!;
        await action({ type: "cursor.move", itemId: destination.id });
      });
    if (key.name === "e")
      return enqueue(async () => {
        if (current()?.kind === "group") await action({ type: "expand.toggle" });
      });
    if (key.name === "a")
      return enqueue(async () => {
        const item = current();
        if (item && item.kind !== "inbox")
          await action({ type: "verdict.toggle", itemId: item.id });
      });
    if (key.name === "u") return enqueue(() => action({ type: "verdict.undo" }));
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
                flexGrow={1}
                paddingLeft={2}
                paddingTop={1}
                paddingRight={2}
                flexDirection="column"
              >
                <Show when={current()} keyed fallback={<text>no review items</text>}>
                  {(item) => (
                    <FocusCard
                      item={item}
                      expanded={status()!.cursor.expanded}
                      layout={resolvedLayout()}
                    />
                  )}
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
          left={Math.max(0, Math.floor((dims().width - 48) / 2))}
          top={4}
          width={48}
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
              ["j / k", "next / previous item"],
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
                <Sp fg={C.accent}>{key!.padEnd(11)}</Sp>
                <Sp fg={C.muted}>{description}</Sp>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}
