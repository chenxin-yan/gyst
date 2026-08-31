// PROTOTYPE — pith TUI, winning hybrid layout (ticket #12).
// Triage queue focus card + collapsible sidebar. Grammar: j/k move, a accept→next,
// e expand toggle (groups), u undo, tab sidebar, q quit. `bun start` in a real terminal.
import { render, useKeyboard } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import { items, session, type Item, type Member } from "./data";

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  fg: "#c9d1d9",
  dim: "#8b949e",
  accent: "#d29922",
  add: "#3fb950",
  del: "#f85149",
  ok: "#3fb950",
};

// ponytail: SpanProps omits fg/bg at the type level but runtime applies them — cast wrapper.
const Sp = (p: Record<string, unknown>) => <span {...(p as object)} />;

const [cursor, setCursor] = createSignal(0);
const [accepted, setAccepted] = createSignal<ReadonlySet<string>>(new Set());
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
const [sidebar, setSidebar] = createSignal(true);
const undoStack: string[] = [];

const current = () => items[cursor()]!;
const isAccepted = (id: string) => accepted().has(id);
const doneCount = () => accepted().size;
const allDone = () => doneCount() === items.length;

function nextPending(from: number): number {
  for (let step = 1; step <= items.length; step++) {
    const i = (from + step) % items.length;
    if (!accepted().has(items[i]!.id)) return i;
  }
  return from;
}

function accept() {
  const it = current();
  if (isAccepted(it.id)) return;
  setAccepted(new Set([...accepted(), it.id]));
  undoStack.push(it.id);
  if (!allDone()) setCursor(nextPending(cursor()));
}

function undo() {
  const id = undoStack.pop();
  if (!id) return;
  const next = new Set(accepted());
  next.delete(id);
  setAccepted(next);
  setCursor(items.findIndex((it) => it.id === id));
}

function DiffLines(props: { member: Member; showFile?: boolean }) {
  return (
    <box flexDirection="column">
      <Show when={props.showFile !== false}>
        <text fg={C.dim} attributes={4}>{props.member.file}</text>
      </Show>
      <For each={props.member.lines}>
        {(l) => (
          <text fg={l.sign === "+" ? C.add : l.sign === "-" ? C.del : C.dim}>
            {l.sign} {l.text}
          </text>
        )}
      </For>
    </box>
  );
}

function Sidebar() {
  const row = (it: Item, label: string) => {
    const i = items.indexOf(it);
    const mark = () => (isAccepted(it.id) ? "✓" : i === cursor() ? "▸" : "·");
    const fg = () => (i === cursor() ? C.accent : isAccepted(it.id) ? C.ok : C.dim);
    return <text fg={fg()}> {mark()} {label.slice(0, 20)}</text>;
  };
  return (
    <box width={24} flexDirection="column" backgroundColor={C.panel} paddingTop={1} paddingLeft={1}>
      <text fg={C.dim} attributes={1}>GROUPS</text>
      <For each={items.filter((it) => it.kind === "group")}>
        {(it) => row(it, `${(it as Item & { kind: "group" }).title} ×${(it as any).members.length}`)}
      </For>
      <text> </text>
      <text fg={C.dim} attributes={1}>SPOTLIGHT</text>
      <For each={items.filter((it) => it.kind === "spotlight")}>
        {(it) => row(it, (it as Item & { kind: "spotlight" }).file.replace("src/", ""))}
      </For>
    </box>
  );
}

function FocusCard() {
  const it = current;
  return (
    <scrollbox flexGrow={1} paddingLeft={2} paddingTop={1} paddingRight={2} flexDirection="column">
      <Show when={it().kind === "group"} fallback={<SpotlightCard item={it() as Item & { kind: "spotlight" }} />}>
        <GroupCard item={it() as Item & { kind: "group" }} />
      </Show>
    </scrollbox>
  );
}

function VerdictTag(props: { id: string }) {
  return (
    <Show when={isAccepted(props.id)}>
      <Sp fg={C.ok} attributes={1}>  ✓ accepted</Sp>
    </Show>
  );
}

function GroupCard(props: { item: Item & { kind: "group" } }) {
  const g = () => props.item;
  const open = () => expanded().has(g().id);
  return (
    <box flexDirection="column">
      <text>
        <Sp fg={C.accent} attributes={1}>GROUP</Sp>
        <Sp fg={C.fg} attributes={1}>  {g().title}</Sp>
        <Sp fg={C.dim}>  ×{g().members.length}</Sp>
        <VerdictTag id={g().id} />
      </text>
      <text fg={C.dim}>agent: {g().agentNote}</text>
      <text> </text>
      <Show
        when={open()}
        fallback={
          <box flexDirection="column">
            <text fg={C.dim} attributes={1}>exemplar · 1 of {g().members.length}</text>
            <DiffLines member={g().members[0]!} />
            <text> </text>
            <text fg={C.dim}>
              members: {g().members.map((m) => m.file.split("/").pop()).slice(0, 5).join("  ")}
              {g().members.length > 5 ? `  … ${g().members.length - 5} more` : ""}
              {"   "}(e to expand)
            </text>
          </box>
        }
      >
        <box flexDirection="column">
          <text fg={C.dim} attributes={1}>all {g().members.length} members (e to fold)</text>
          <For each={g().members}>
            {(m) => (
              <box flexDirection="column" paddingBottom={1}>
                <DiffLines member={m} />
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

function SpotlightCard(props: { item: Item & { kind: "spotlight" } }) {
  const s = () => props.item;
  return (
    <box flexDirection="column">
      <text>
        <Sp fg={C.add} attributes={1}>SPOTLIGHT</Sp>
        <Sp fg={C.fg} attributes={1}>  {s().file}</Sp>
        <VerdictTag id={s().id} />
      </text>
      <text fg={C.dim}>{s().hunkHeader}</text>
      <text> </text>
      <DiffLines member={{ file: s().file, lines: s().lines }} showFile={false} />
    </box>
  );
}

function DoneCard() {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <text fg={C.ok} attributes={1}>review complete — {items.length}/{items.length} accepted</text>
      <text fg={C.dim}>you read {items.length} things, not {session.totalHunks} hunks · u undo · q quit</text>
    </box>
  );
}

export function App() {
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
    if (key.name === "j") setCursor((cursor() + 1) % items.length);
    if (key.name === "k") setCursor((cursor() - 1 + items.length) % items.length);
    if (key.name === "a") accept();
    if (key.name === "u") undo();
    if (key.name === "tab") setSidebar(!sidebar());
    if (key.name === "e" && current().kind === "group") {
      const next = new Set(expanded());
      next.has(current().id) ? next.delete(current().id) : next.add(current().id);
      setExpanded(next);
    }
  });

  const bar = () => {
    const filled = Math.round((doneCount() / items.length) * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={C.bg}>
      <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={C.panel} flexDirection="row" justifyContent="space-between">
        <text>
          <Sp fg={C.accent} attributes={1}>pith</Sp>
          <Sp fg={C.dim}> · {session.branch}</Sp>
        </text>
        <text>
          <Sp fg={C.fg}>item {cursor() + 1}/{items.length}  </Sp>
          <Sp fg={C.accent}>{bar()}</Sp>
          <Sp fg={C.dim}>  {doneCount()}/{items.length} done</Sp>
        </text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <Show when={sidebar()}>
          <Sidebar />
        </Show>
        <Show when={!allDone()} fallback={<DoneCard />}>
          <FocusCard />
        </Show>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={C.panel}>
        <text fg={C.dim}>j/k move   a accept→next   e expand   u undo   tab sidebar   q quit</text>
      </box>
    </box>
  );
}

if (import.meta.main) await render(() => <App />);
