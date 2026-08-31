// PROTOTYPE — pith TUI, winning hybrid layout (ticket #12).
// Triage queue focus card + collapsible sidebar. Grammar: j/k move, a accept toggle,
// e expand toggle (groups), u undo, s sidebar, q quit. `bun start` in a real terminal.
//
// Visual system: hunk's github-dark diff layering (row bg tints, tinted line-number
// gutters, sign-colored rails) + opencode chrome (panel layering, peach accent,
// key-normal/desc-muted hints, accent strip on the current row).
import { render, useKeyboard } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";
import { items, session, type DiffLine, type Item, type Member } from "./data";

const C = {
  bg: "#0d1117", // base / context (hunk github-dark)
  panel: "#1e2329", // sidebar, file headers
  panelAlt: "#272b31", // current-row fill, badges
  border: "#34393f",
  fg: "#e6edf3",
  muted: "#adaeb1",
  dim: "#878c92", // lineNumberFg
  accent: "#fab283", // opencode primary (peach)
  addSign: "#2ea043",
  delSign: "#f85149",
  addBg: "#12251d",
  delBg: "#3c1e21",
  addGutterBg: "#1b2b34", // opencode add-line-number-bg
  delGutterBg: "#2d1f26",
  ok: "#77c185", // hunk badgeAdded
  okBadge: "#7fd88f",
  delBadge: "#fa8e89",
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

function accept() {
  const it = current();
  if (isAccepted(it.id)) {
    // toggle off: unmark and stay put
    const next = new Set(accepted());
    next.delete(it.id);
    setAccepted(next);
    const i = undoStack.indexOf(it.id);
    if (i !== -1) undoStack.splice(i, 1);
    return;
  }
  setAccepted(new Set([...accepted(), it.id]));
  undoStack.push(it.id);
}

function undo() {
  const id = undoStack.pop();
  if (!id) return;
  const next = new Set(accepted());
  next.delete(id);
  setAccepted(next);
  setCursor(items.findIndex((it) => it.id === id));
}

const stats = (lines: DiffLine[]) => ({
  add: lines.filter((l) => l.sign === "+").length,
  del: lines.filter((l) => l.sign === "-").length,
});

/** One diff row: tinted line-number gutter + sign + content on a full-width tinted band. */
function DiffRow(props: { line: DiffLine; no: string }) {
  const l = () => props.line;
  const rowBg = () => (l().sign === "+" ? C.addBg : l().sign === "-" ? C.delBg : C.bg);
  const gutterBg = () => (l().sign === "+" ? C.addGutterBg : l().sign === "-" ? C.delGutterBg : C.bg);
  const signFg = () => (l().sign === "+" ? C.addSign : l().sign === "-" ? C.delSign : C.dim);
  return (
    <box flexDirection="row" backgroundColor={rowBg()}>
      <text fg={l().sign === " " ? C.dim : signFg()} bg={gutterBg()}>
        {props.no} {l().sign === " " ? " " : l().sign}{" "}
      </text>
      <text fg={l().sign === " " ? C.muted : C.fg}> {l().text}</text>
    </box>
  );
}

/** File header row, hunk-style: panel band, filename left, +N -N badges right. */
function FileHeader(props: { file: string; lines: DiffLine[]; tag?: string }) {
  const s = () => stats(props.lines);
  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={C.panel} paddingLeft={1} paddingRight={1}>
      <text>
        <Sp fg={C.fg}>{props.file}</Sp>
        <Show when={props.tag}>
          <Sp fg={C.dim}>  {props.tag}</Sp>
        </Show>
      </text>
      <text>
        <Show when={s().add > 0}>
          <Sp fg={C.ok}>+{s().add}</Sp>
        </Show>
        <Show when={s().del > 0}>
          <Sp fg={C.delBadge}> -{s().del}</Sp>
        </Show>
      </text>
    </box>
  );
}

function MemberDiff(props: { member: Member; tag?: string }) {
  const width = () => String(props.member.start + props.member.lines.length).length;
  let n = props.member.start;
  const numbered = props.member.lines.map((l) => {
    const no = l.sign === "-" ? "" : String(n++);
    return { l, no };
  });
  return (
    <box flexDirection="column">
      <FileHeader file={props.member.file} lines={props.member.lines} tag={props.tag} />
      <For each={numbered}>{(r) => <DiffRow line={r.l} no={r.no.padStart(width() + 1)} />}</For>
    </box>
  );
}

function Sidebar() {
  const row = (it: Item, label: string, count?: number) => {
    const i = items.indexOf(it);
    const active = () => i === cursor();
    return (
      <box flexDirection="row" backgroundColor={active() ? C.panelAlt : C.panel}>
        <text fg={active() ? C.accent : C.panel} bg={active() ? C.panelAlt : C.panel}>▌</text>
        <box flexDirection="row" justifyContent="space-between" flexGrow={1} paddingRight={1}>
          <text fg={isAccepted(it.id) ? C.ok : active() ? C.fg : C.muted}>
            {isAccepted(it.id) ? "✓" : "·"} {label.slice(0, 19)}
          </text>
          <Show when={count !== undefined}>
            <text fg={C.dim}>{count}</text>
          </Show>
        </box>
      </box>
    );
  };
  return (
    <box width={27} flexDirection="column" backgroundColor={C.panel} paddingTop={1}>
      <text fg={C.dim} attributes={1}>{"  GROUPS"}</text>
      <For each={items.filter((it) => it.kind === "group")}>
        {(it) => row(it, (it as Item & { kind: "group" }).title, (it as any).members.length)}
      </For>
      <text> </text>
      <text fg={C.dim} attributes={1}>{"  SPOTLIGHT"}</text>
      <For each={items.filter((it) => it.kind === "spotlight")}>
        {(it) => row(it, (it as Item & { kind: "spotlight" }).file.replace("src/", ""))}
      </For>
    </box>
  );
}

function VerdictTag(props: { id: string }) {
  return (
    <Show when={isAccepted(props.id)}>
      <Sp fg={C.okBadge} attributes={1}>   ✓ accepted</Sp>
    </Show>
  );
}

function GroupCard(props: { item: Item & { kind: "group" } }) {
  const g = () => props.item;
  const open = () => expanded().has(g().id);
  return (
    <box flexDirection="column">
      <text>
        <Sp fg={C.accent} attributes={1}>▍GROUP </Sp>
        <Sp fg={C.fg} attributes={1}>{g().title}</Sp>
        <Sp fg={C.dim}>  ×{g().members.length}</Sp>
        <VerdictTag id={g().id} />
      </text>
      <text fg={C.muted} attributes={2}>agent: {g().agentNote}</text>
      <text> </text>
      <Show
        when={open()}
        fallback={
          <box flexDirection="column">
            <text fg={C.dim}>exemplar · 1 of {g().members.length}</text>
            <MemberDiff member={g().members[0]!} />
            <text> </text>
            <text fg={C.dim}>
              members: {g().members.map((m) => m.file.split("/").pop()).slice(0, 5).join(" · ")}
              {g().members.length > 5 ? ` · … ${g().members.length - 5} more` : ""}
              {"   "}(e to expand)
            </text>
          </box>
        }
      >
        <box flexDirection="column">
          <text fg={C.dim}>all {g().members.length} members (e to fold)</text>
          <For each={g().members}>
            {(m) => (
              <box flexDirection="column" paddingBottom={1}>
                <MemberDiff member={m} />
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
        <Sp fg={C.okBadge} attributes={1}>▍SPOTLIGHT </Sp>
        <Sp fg={C.fg} attributes={1}>{s().file}</Sp>
        <VerdictTag id={s().id} />
      </text>
      <text fg={C.muted} attributes={2}>{s().hunkHeader}</text>
      <text> </text>
      <MemberDiff member={{ file: s().file, lines: s().lines, start: s().start }} />
    </box>
  );
}

function FocusCard() {
  return (
    <scrollbox flexGrow={1} paddingLeft={2} paddingTop={1} paddingRight={2} flexDirection="column">
      <Show
        when={current().kind === "group"}
        fallback={<SpotlightCard item={current() as Item & { kind: "spotlight" }} />}
      >
        <GroupCard item={current() as Item & { kind: "group" }} />
      </Show>
    </scrollbox>
  );
}

function DoneCard() {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <text fg={C.okBadge} attributes={1}>✓ review complete — {items.length}/{items.length} accepted</text>
      <text fg={C.muted}>you read {items.length} things, not {session.totalHunks} hunks · u undo · q quit</text>
    </box>
  );
}

function KeyHints() {
  const hints: [string, string][] = [
    ["j/k", "move"],
    ["a", "accept"],
    ["e", "expand"],
    ["u", "undo"],
    ["s", "sidebar"],
    ["q", "quit"],
  ];
  return (
    <text>
      {hints.map(([key, desc]) => (
        <>
          <Sp fg={C.fg}>{key}</Sp>
          <Sp fg={C.dim}> {desc}   </Sp>
        </>
      ))}
    </text>
  );
}

export function App() {
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
    if (key.name === "j") setCursor((cursor() + 1) % items.length);
    if (key.name === "k") setCursor((cursor() - 1 + items.length) % items.length);
    if (key.name === "a") accept();
    if (key.name === "u") undo();
    if (key.name === "s") setSidebar(!sidebar());
    if (key.name === "e" && current().kind === "group") {
      const next = new Set(expanded());
      next.has(current().id) ? next.delete(current().id) : next.add(current().id);
      setExpanded(next);
    }
  });

  const bar = () => {
    const filled = Math.round((doneCount() / items.length) * 12);
    return "━".repeat(filled) + "╌".repeat(12 - filled);
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={C.bg}>
      <box height={1} paddingLeft={2} paddingRight={2} backgroundColor={C.panel} flexDirection="row" justifyContent="space-between">
        <text>
          <Sp fg={C.accent} attributes={1}>● pith</Sp>
          <Sp fg={C.muted}> · {session.branch}</Sp>
        </text>
        <text>
          <Sp fg={C.fg}>item {cursor() + 1}/{items.length}  </Sp>
          <Sp fg={C.accent}>{bar()}</Sp>
          <Sp fg={C.muted}>  {doneCount()}/{items.length} done</Sp>
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
      <box height={1} paddingLeft={2} backgroundColor={C.bg}>
        <KeyHints />
      </box>
    </box>
  );
}

if (import.meta.main) await render(() => <App />);
