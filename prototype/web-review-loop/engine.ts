// PROTOTYPE, throwaway. Shared in-memory review state, keys, diff and tree mounting.
// No daemon, no persistence, no real agent: every action only mutates this module's state.
import { FileDiff, getSingularPatch, hydratePartialDiff, type DiffLineAnnotation } from "@pierre/diffs";
import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import { hydrateDiagrams, markdownHTML } from "./rich.ts";
// The same real hunks as the base prototype; its make-data.ts regenerates them.
import sample from "../web/sample.json";

export type Hunk = { id: string; file: string; header: string; patch: string };
type Side = "additions" | "deletions";
// Notes anchor to one line of a hunk: `side` picks the old (deletions) or new (additions) file.
export type Note = { hunkId: string; side: Side; line: number; text: string; updated?: true };
// A group, or "all changes under a path" (`file` set to a file or directory), which is also where
// ungrouped hunks live.
export type Item = { id: string; title: string; hunkIds: string[]; overview?: string; file?: string; dir?: boolean };
// A code comment anchors to its last line; `from` is the first line of a multi-line (V) selection.
export type LineTarget = { kind: "line"; hunkId: string; side: Side; line: number; from?: { side: Side; line: number } };
export type Target = LineTarget | { kind: "note"; hunkId: string; note: string };
// Where the cursor sits: a line of a file's diff, or an annotation (a note or a thread).
// Files and hidden-line ranges are stops too, so folds open and close from the keyboard.
type Cursor =
  | { kind: "line"; file: string; side: Side; line: number }
  | { kind: "anno"; key: string }
  | { kind: "file"; file: string }
  | { kind: "gap"; file: string; index: number };
// `unread` until the agent pulls the review through its gyst skill in the harness.
export type Message = { author: "you" | "agent"; text: string; unread?: true };
export type Thread = { id: string; target: Target; messages: Message[]; resolved: boolean };

export const flavors = ["mocha", "macchiato", "frappe", "latte"] as const;
export type Flavor = (typeof flavors)[number];
export const hunks = sample.hunks as Record<string, Hunk>;
export const meta = { scope: sample.scope, title: sample.scopeTitle, repo: sample.repo };

export function noteKey(note: Pick<Note, "hunkId" | "side" | "line">) {
  return `${note.hunkId}:${note.side}:${note.line}`;
}

// Hand-written richer guidance over the sample's plain notes: Markdown, a diagram and snapshot links.
const richNotes: Record<string, string> = {
  "7d97ca73d0e996a7:additions:23":
    "**Plain text, capped.** Notes stop at 400 code points and reject terminal controls:\n\n- they stay readable inline in the diff\n- no Markdown sanitizer is needed\n\n`NoteTextSchema` enforces both.",
  "a26fdd3693d2ada5:additions:73":
    "Publishing checks every note against its **own** group before applying anything.\n\n```mermaid\nflowchart LR\n  accTitle: Publishing a batch with notes\n  accDescr: A batch applies only when every note anchors to a member of its own group.\n  B[Batch] --> C{Every note on its group?}\n  C -->|Yes| A[Apply batch]\n  C -->|No| R[Reject whole batch]\n```\n\nRefresh applies the same rule: [refresh.ts:47–53](gyst:new/packages/core/src/refresh.ts#L47-L53).",
  "85cf1027d2a89f7a:additions:40":
    "Scroll observations apply only to the exact session, revision and sequence they saw; explicit navigation stays unconditional.\n\nPinned by [human-action.test.ts:92–144](gyst:new/packages/core/src/human-action.test.ts#L92-L144).",
  "3229ede64714720f:additions:50":
    "A surviving note may describe the vanished sibling, so **any** lost member clears the group's notes. Publishing enforces the matching rule in [apply.ts:44–79](gyst:new/packages/core/src/apply.ts#L44-L79).",
};

// Hand-written group overviews: the big picture before the notes. Prototype content, not a contract.
const overviews: Record<string, string> = {
  "notes-schema":
    "Group overviews give way to **notes**: short explanations anchored to a line of a member hunk.\n\n- `metadata.ts` defines the note schema and its limits\n- `session.ts` interns note text in receipts, so replay stays exact\n- `draft.ts` and `index.ts` carry notes through drafts and exports",
  anchors:
    "Publishing now checks that every note sits on a member of its own group, and rejects the whole batch otherwise.\n\n```mermaid\nflowchart LR\n  accTitle: Where note anchors are checked\n  P[Publish batch] --> V{Anchors valid?}\n  V -->|Yes| S[Save groups and notes]\n  V -->|No| X[Reject batch]\n  U[Update group] --> V\n```",
  focus:
    "Each item remembers its focused hunk, so hiding and showing the sidebar returns to the same place. Scroll-driven focus applies only if the session, revision and sequence it saw are still current.",
  refresh:
    "When a refresh loses a member of a group, the group's notes are cleared: a surviving note may describe the hunk that disappeared.",
  noop: "A cursor action that changes nothing no longer rewrites the session file.",
  skills:
    "The authoring skills ask for short titles plus notes on the hunks that need explaining, instead of overviews. `/gyst-ask` reads the focused hunk's note first.",
};

export const state = {
  // The sample's inbox is gone: ungrouped hunks appear only under their files (file view).
  items: sample.groups.map(({ id, title, hunkIds }) => ({ id, title, hunkIds, overview: overviews[id] })) as Item[],
  notes: sample.groups.flatMap((group) =>
    (group.notes as Note[]).map((note) => ({ ...note, text: richNotes[noteKey(note)] ?? note.text })),
  ),
  index: 0,
  // Set while reading all changes in one file instead of a group.
  file: null as string | null,
  // Like the TUI: split, stacked (unified) or auto, which picks by the width the diff gets.
  layoutMode: "auto" as "auto" | "split" | "unified",
  flavor: (new URLSearchParams(location.search).get("flavor") ?? "mocha") as Flavor,
  sourceChanged: true,
  sidebar: true,
  overlay: "" as "" | "help" | "palette" | "threads",
  // Files folded in view; view state only, never part of the review.
  foldedFiles: new Set<string>(),
  // Viewed is per hunk and shared by every view that shows the hunk. A file header's checkbox is
  // derived: checked iff every hunk of that file in the current view is viewed.
  viewed: new Set<string>(),
  openNotes: new Set<string>(),
  activeNote: "",
  threads: [] as Thread[],
  // One discussion is open at a time; its reply composer appears only on demand.
  activeThread: "",
  replying: false,
  composing: null as Target | null,
  // Threads with comments the agent hasn't pulled yet.
  queue: [] as string[],
  cursor: null as Cursor | null,
  // Visual line mode: the fixed end of the selection; the cursor is the moving end.
  visual: null as Extract<Cursor, { kind: "line" }> | null,
  // In split view the cursor walks one side; h / l switch.
  cursorSide: "additions" as Side,
  // Vim: a visible keyboard cursor. Mouse: no cursor highlight; j / k scroll and the gutter's +
  // comments on a line.
  inputMode: "vim" as "vim" | "mouse",
  back: [] as { index: number; file: string | null; scroll: number }[],
  toast: "",
};
// Comment drafts survive closing and switching; in memory only, like everything here.
export const drafts = new Map<string, string>();

export const groups = () => state.items;
export const rangeOf = (hunkId: string) => {
  const [, oldStart, oldLength, newStart, newLength] = hunks[hunkId]!.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/)!;
  return {
    old: [Number(oldStart), Number(oldStart) + Number(oldLength ?? 1) - 1],
    new: [Number(newStart), Number(newStart) + Number(newLength ?? 1) - 1],
  };
};
const byPosition = (a: string, b: string) => rangeOf(a).new[0] - rangeOf(b).new[0];
export function fileItem(path: string): Item {
  const files = allFiles().filter((file) => file === path || file.startsWith(`${path}/`));
  const hunkIds = files.flatMap((file) =>
    Object.values(hunks).filter((hunk) => hunk.file === file).map((hunk) => hunk.id).sort(byPosition),
  );
  return { id: `file:${path}`, title: path, hunkIds, file: path, dir: !files.includes(path) };
}
export const current = () => (state.file ? fileItem(state.file) : state.items[state.index]!);
export const notesOf = (hunkIds: string[]) => state.notes.filter((note) => hunkIds.includes(note.hunkId));
export const filesOf = (item: Item) => [...new Set(item.hunkIds.map((id) => hunks[id]!.file))];
export const allFiles = () => [...new Set(Object.values(hunks).map((hunk) => hunk.file))];
export const isViewed = (hunkIds: string[]) => hunkIds.every((id) => state.viewed.has(id));
export const isNewFile = (file: string) =>
  Object.values(hunks).some((hunk) => hunk.file === file && hunk.header.startsWith("@@ -0,0 "));
export const itemIndexOfHunk = (hunkId: string) =>
  state.items.findIndex((item) => item.hunkIds.includes(hunkId));
export const counts = (hunkIds: string | string[]) => {
  const lines = [hunkIds]
    .flat()
    .flatMap((id) => hunks[id]!.patch.split("\n").slice(1));
  return {
    added: lines.filter((line) => line[0] === "+").length,
    removed: lines.filter((line) => line[0] === "-").length,
  };
};
// Reading order: the walkthrough, then ungrouped hunks by file.
const readingOrder = () => {
  const grouped = state.items.flatMap((item) => item.hunkIds);
  return [...grouped, ...Object.keys(hunks).filter((id) => !grouped.includes(id))];
};

let rerender = () => {};
export function onChange(render: () => void) {
  rerender = render;
}
// A variant may register how its tree takes keyboard focus (`f`) and opens search (`/`).
export const hooks = {
  focusTree: () => {},
  searchTree: () => {},
};

export function toast(text: string) {
  state.toast = text;
  rerender();
  setTimeout(() => {
    if (state.toast === text) {
      state.toast = "";
      rerender();
    }
  }, 2600);
}

const scroller = () => document.querySelector<HTMLElement>("[data-scroll]");
const motion = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// There is no focused hunk: the reader scrolls. "Here" is whatever the reading line crosses, a bit
// below the pane's top edge, and commands without a target act on the file there.
const readingLine = () => (scroller()?.getBoundingClientRect().top ?? 0) + 80;
export function fileInView() {
  const files = [...document.querySelectorAll<HTMLElement>(".pane .file")];
  const line = readingLine();
  const hit = files.find((file) => file.getBoundingClientRect().bottom > line) ?? files.at(-1);
  return hit?.dataset.file ?? filesOf(current())[0]!;
}
const unfold = (hunkId: string) => state.foldedFiles.delete(hunks[hunkId]!.file);

export function select(index: number, hunkId?: string) {
  if (index < 0 || index >= state.items.length) return;
  state.cursor = null;
  state.visual = null;
  state.index = index;
  state.file = null;
  state.overlay = "";
  if (hunkId) unfold(hunkId);
  rerender();
  if (hunkId) revealHunk(hunkId);
  else scroller()?.scrollTo({ top: 0 });
}

export function openFile(file: string, hunkId?: string) {
  state.file = file;
  state.cursor = null;
  state.visual = null;
  state.overlay = "";
  rerender();
  if (hunkId) revealHunk(hunkId);
  else scroller()?.scrollTo({ top: 0 });
}

// Brings a hunk on screen: in the current view if it's there, else its group, else its file.
export function goToHunk(hunkId: string, scroll = true) {
  if (!current().hunkIds.includes(hunkId)) {
    const index = itemIndexOfHunk(hunkId);
    return index >= 0 ? select(index, hunkId) : openFile(hunks[hunkId]!.file, hunkId);
  }
  unfold(hunkId);
  rerender();
  if (scroll) revealHunk(hunkId);
}

// A file renders as one diff, so a hunk is found by its first line inside that diff's shadow root.
function revealHunk(hunkId: string, tries = 30) {
  state.cursor = { kind: "line", file: hunks[hunkId]!.file, ...firstChangedLine(hunkId) };
  requestAnimationFrame(() => {
    const file = document.querySelector(`[data-file="${CSS.escape(hunks[hunkId]!.file)}"]`);
    const root = file?.querySelector("diffs-container")?.shadowRoot;
    const line = [...(root?.querySelectorAll(`[data-line="${rangeOf(hunkId).new[0]}"]`) ?? [])].at(-1);
    if (!line && tries) return revealHunk(hunkId, tries - 1);
    (line ?? file)?.scrollIntoView({ block: "start", behavior: motion() });
    paintAnnotations();
  });
}
const revealFile = (file: string) =>
  requestAnimationFrame(() =>
    document.querySelector(`[data-file="${CSS.escape(file)}"]`)?.scrollIntoView({ block: "start", behavior: motion() }),
  );
// Annotations mount asynchronously with their diff, so wait a few frames for them.
function revealAnnotation(key: string, tries = 30) {
  requestAnimationFrame(() => {
    const element = document.querySelector(`[data-anno="${CSS.escape(key)}"]`);
    if (element) element.scrollIntoView({ block: "center", behavior: motion() });
    else if (tries) revealAnnotation(key, tries - 1);
  });
}
function focusComposer(tries = 30) {
  requestAnimationFrame(() => {
    const composer = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    if (!composer) return tries && focusComposer(tries - 1);
    composer.focus({ preventScroll: true });
    composer.scrollIntoView({ block: "nearest", behavior: motion() });
  });
}

// ─── cursor ───────────────────────────────────────────────────────────────────
// A Neovim-style cursor walks the rendered diff: code lines and, between them, the notes and threads
// attached there. It's what c, r, V, Enter, v and z act on. The view follows it smoothly, keeping a
// margin (scrolloff); scrolling the page away pulls it back onto the first or last visible stop.

type Stop = { top: number; bottom: number; element: Element; file: string } & Cursor;
const SCROLLOFF = 96;

// Every stop in reading order. In split view only the cursor's side counts, unless a file has none.
function stops(): Stop[] {
  const out: Stop[] = [];
  const split = layout() === "split";
  for (const fileElement of document.querySelectorAll<HTMLElement>(".pane .file")) {
    const file = fileElement.dataset.file!;
    // The file's own stop sits at the top of its block (its header sticks, so its rect would drift).
    const block = fileElement.getBoundingClientRect();
    out.push({ kind: "file", file, top: block.top - 0.5, bottom: block.top + 34, element: fileElement });
    if (fileElement.classList.contains("folded")) continue;
    const root = fileElement.querySelector("diffs-container")?.shadowRoot;
    const rows = [...(root?.querySelectorAll<HTMLElement>("[data-content] > [data-line]") ?? [])].map((row) => ({
      row,
      side: (split
        ? row.closest("[data-code]")?.hasAttribute("data-deletions")
          ? "deletions"
          : "additions"
        : row.dataset.lineType === "change-deletion"
          ? "deletions"
          : "additions") as Side,
    }));
    const onSide = split ? rows.filter(({ side }) => side === state.cursorSide) : rows;
    const fileStops: Stop[] = (onSide.length ? onSide : rows).map(({ row, side }) => {
      const { top, bottom } = row.getBoundingClientRect();
      return { kind: "line", file, side, line: Number(row.dataset.line), top, bottom, element: row };
    });
    const gaps = new Set<number>();
    for (const element of root?.querySelectorAll<HTMLElement>("[data-content] > [data-separator][data-expand-index]") ?? []) {
      const index = Number(element.dataset.expandIndex);
      const { top, bottom } = element.getBoundingClientRect();
      if (gaps.has(index) || element.style.display === "none" || !bottom) continue;
      gaps.add(index);
      fileStops.push({ kind: "gap", file, index, top, bottom, element });
    }
    for (const element of fileElement.querySelectorAll<HTMLElement>(".anno[data-anno]:not([data-anno^='draft:'])")) {
      const { top, bottom } = element.getBoundingClientRect();
      // An annotation sits under its line; the nudge keeps it after that line when tops touch.
      fileStops.push({ kind: "anno", key: element.dataset.anno!, file, top: top + 0.5, bottom, element });
    }
    out.push(...fileStops.sort((a, b) => a.top - b.top));
  }
  return out;
}
const sameStop = (stop: Cursor, cursor: Cursor | null) => {
  if (!cursor || cursor.kind !== stop.kind) return false;
  if (stop.kind === "anno") return (cursor as typeof stop).key === stop.key;
  if (stop.kind === "file") return (cursor as typeof stop).file === stop.file;
  if (stop.kind === "gap") return (cursor as typeof stop).file === stop.file && (cursor as typeof stop).index === stop.index;
  const line = cursor as typeof stop;
  return line.file === stop.file && line.side === stop.side && line.line === stop.line;
};
function asCursor(stop: Stop): Cursor {
  if (stop.kind === "anno") return { kind: "anno", key: stop.key };
  if (stop.kind === "file") return { kind: "file", file: stop.file };
  if (stop.kind === "gap") return { kind: "gap", file: stop.file, index: stop.index };
  return { kind: "line", file: stop.file, side: stop.side, line: stop.line };
}

// Smooth scrolling that retargets, so a held j or k glides instead of queueing animations.
let scrollTarget: number | null = null;
function smoothScrollBy(delta: number) {
  const pane = scroller();
  if (!pane) return;
  const max = pane.scrollHeight - pane.clientHeight;
  const running = scrollTarget !== null;
  scrollTarget = Math.min(max, Math.max(0, (scrollTarget ?? pane.scrollTop) + delta));
  if (motion() === "auto") {
    pane.scrollTop = scrollTarget;
    scrollTarget = null;
    return;
  }
  const frame = () => {
    const current = scroller();
    if (!current || scrollTarget === null) return;
    const gap = scrollTarget - current.scrollTop;
    if (Math.abs(gap) < 1) {
      current.scrollTop = scrollTarget;
      scrollTarget = null;
      return;
    }
    current.scrollTop += Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.25);
    requestAnimationFrame(frame);
  };
  if (!running) requestAnimationFrame(frame);
}
// Only scrolling the reader does by hand moves the cursor; the app's own reveals never do.
let manualScrollAt = 0;
const manualScroll = () => {
  scrollTarget = null;
  manualScrollAt = performance.now();
};
addEventListener("wheel", manualScroll, { passive: true });
addEventListener("touchmove", manualScroll, { passive: true });
addEventListener("pointerdown", (event) => (event.target as Element).matches?.("[data-scroll]") && manualScroll());
addEventListener("keydown", (event) => [" ", "PageDown", "PageUp", "Home", "End"].includes(event.key) && manualScroll());
// Positions as they'll be once the running scroll animation lands.
const pendingScroll = () => (scrollTarget === null ? 0 : scrollTarget - (scroller()?.scrollTop ?? 0));
function keepInView(stop: Stop) {
  const pane = scroller()?.getBoundingClientRect();
  if (!pane) return;
  const top = stop.top - pendingScroll();
  // A tall note or diagram only needs its top half on screen.
  const bottom = Math.min(stop.bottom, stop.top + pane.height / 2) - pendingScroll();
  if (top < pane.top + SCROLLOFF) smoothScrollBy(top - pane.top - SCROLLOFF);
  else if (bottom > pane.bottom - SCROLLOFF) smoothScrollBy(bottom - pane.bottom + SCROLLOFF);
}

const noteOf = (cursor: Cursor | null) =>
  cursor?.kind === "anno" && cursor.key.startsWith("note:") ? cursor.key.slice(5) : "";
function setCursor(cursor: Cursor | null, scroll?: Stop) {
  state.cursor = cursor;
  state.activeNote = noteOf(cursor);
  paintAnnotations();
  if (scroll) keepInView(scroll);
  rerenderStatus();
}
// Only the status line reflects the cursor; the rest of the app needn't re-render per keystroke.
let rerenderStatus = () => {};
export function onCursorMove(render: () => void) {
  rerenderStatus = render;
}
// The cursor's stop, or (after navigation or before the diff mounted) the first visible one.
function ensureCursor(list = stops()) {
  let at = list.findIndex((stop) => sameStop(stop, state.cursor));
  if (at < 0) {
    const pane = scroller()?.getBoundingClientRect();
    at = Math.max(0, list.findIndex((stop) => stop.top >= (pane?.top ?? 0) + 40));
    if (list[at]) {
      state.cursor = asCursor(list[at]!);
      state.activeNote = noteOf(state.cursor);
    }
  }
  return { list, at };
}
// Visual mode selects lines of one file.
const reachable = (list: Stop[]) =>
  state.visual ? list.filter((stop) => stop.kind === "line" && stop.file === state.visual!.file) : list;
function moveCursor(delta: number) {
  const { list } = ensureCursor();
  const candidates = reachable(list);
  const index = candidates.findIndex((stop) => sameStop(stop, state.cursor));
  const next = candidates[Math.min(candidates.length - 1, Math.max(0, index + delta))];
  if (next) setCursor(asCursor(next), next);
}
// Ctrl-d / Ctrl-u: move the cursor and the page by half a screen, as Vim does.
function halfPage(delta: 1 | -1) {
  const { list, at } = ensureCursor();
  const pane = scroller();
  if (!pane || !list[at]) return;
  const distance = (pane.clientHeight / 2) * delta;
  const goal = list[at]!.top + distance;
  const candidates = reachable(list);
  const next =
    delta === 1
      ? (candidates.find((stop) => stop.top >= goal) ?? candidates.at(-1))
      : (candidates.findLast((stop) => stop.top <= goal) ?? candidates[0]);
  if (!next) return;
  setCursor(asCursor(next));
  smoothScrollBy(distance);
}
function edge(end: "first" | "last") {
  const candidates = reachable(stops());
  const next = end === "first" ? candidates[0] : candidates.at(-1);
  if (!next) return;
  setCursor(asCursor(next));
  if (end === "first" && !state.visual) smoothScrollBy(-(scroller()?.scrollTop ?? 0));
  else keepInView(next);
}
// h / l: the same row on the other side of a split diff.
function switchSide(side: Side) {
  if (layout() !== "split" || state.visual) return;
  const { list, at } = ensureCursor();
  const top = list[at]?.top ?? 0;
  state.cursorSide = side;
  const next = stops()
    .filter((stop) => stop.kind === "line")
    .sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top))[0];
  if (next) setCursor(asCursor(next));
}
// Scrolling the page with the mouse drags the cursor along, so c and r never act off screen.
let snapQueued = false;
addEventListener(
  "scroll",
  () => {
    if (snapQueued || scrollTarget !== null || performance.now() - manualScrollAt > 1000) return;
    snapQueued = true;
    requestAnimationFrame(() => {
      snapQueued = false;
      if (scrollTarget !== null || state.visual) return;
      const pane = scroller()?.getBoundingClientRect();
      const list = stops();
      const current = list.find((stop) => sameStop(stop, state.cursor));
      if (!pane || !current || (current.top >= pane.top && current.top <= pane.bottom)) return;
      const visible = list.filter((stop) => stop.top >= pane.top + 40 && stop.top <= pane.bottom - 40);
      const next = current.top < pane.top ? visible[0] : visible.at(-1);
      if (next) setCursor(asCursor(next));
    });
  },
  true,
);

// Draws the cursor (or V selection) with the diff's own line selection, and marks annotations.
// `drawn` skips redundant writes; forget a diff's entry whenever the diff selects lines itself (a
// click or a gutter drag), or its selection would outlive the gesture.
const drawn = new WeakMap<object, string>();
function drawCursor() {
  // Like Vim, there is always a cursor: a fresh view starts it on its first visible line.
  if (!state.cursor) ensureCursor();
  const vim = state.inputMode === "vim";
  const cursor = state.cursor;
  for (const [key, diff] of live) {
    const file = key.slice(key.indexOf("|") + 1);
    const host = diffRoot(diff)?.host as HTMLElement | undefined;
    if (host && host.dataset.cursorSide !== state.cursorSide) host.dataset.cursorSide = state.cursorSide;
    let range: { start: number; end: number; side: Side; endSide: Side } | null = null;
    // Mouse mode draws only a dragged multi-line selection, never the cursor itself.
    if (cursor?.kind === "line" && cursor.file === file && (vim || state.visual?.file === file)) {
      const from = state.visual?.file === file ? state.visual : cursor;
      range = { start: from.line, side: from.side, end: cursor.line, endSide: cursor.side };
    }
    const signature = JSON.stringify(range);
    if (drawn.get(diff) === signature) continue;
    drawn.set(diff, signature);
    diff.setSelectedLines(range, { notify: false });
  }
  for (const element of document.querySelectorAll(".anno.cursor, .file-head.cursor")) element.classList.remove("cursor");
  for (const [, diff] of live)
    for (const element of diffRoot(diff)?.querySelectorAll("[data-cursor]") ?? []) element.removeAttribute("data-cursor");
  if (vim && cursor?.kind === "file")
    document.querySelector(`.file[data-file="${CSS.escape(cursor.file)}"] .file-head`)?.classList.add("cursor");
  if (vim && cursor?.kind === "gap")
    for (const element of document.querySelector(`.file[data-file="${CSS.escape(cursor.file)}"] diffs-container`)?.shadowRoot?.querySelectorAll(`[data-separator][data-expand-index="${cursor.index}"]`) ?? [])
      element.setAttribute("data-cursor", "");
  if (vim && cursor?.kind === "anno")
    for (const element of document.querySelectorAll(`[data-anno="${CSS.escape(cursor.key)}"]`))
      element.classList.add("cursor");
}
const hunkAt = (file: string, side: Side, line: number) =>
  Object.values(hunks).find((hunk) => {
    const [start, end] = rangeOf(hunk.id)[side === "deletions" ? "old" : "new"];
    return hunk.file === file && line >= start! && line <= end!;
  })?.id;
const diffRoot = (diff: FileDiff<Annotation>) =>
  [...cache.values()].find((entry) => entry.diff === diff)?.element.querySelector("diffs-container")?.shadowRoot;
export function cursorFile() {
  const cursor = state.cursor;
  if (cursor && cursor.kind !== "anno") return cursor.file;
  const annotation = cursor && document.querySelector(`[data-anno="${CSS.escape(cursor.key)}"]`);
  return (annotation?.closest("[data-file]") as HTMLElement | null)?.dataset.file ?? fileInView();
}
export const cursorLabel = () => {
  const cursor = state.cursor;
  if (!cursor || state.inputMode !== "vim") return "";
  if (cursor.kind === "anno") return cursor.key.startsWith("note:") ? "note" : "thread";
  if (cursor.kind === "file") return `${cursor.file.split("/").at(-1)} · file`;
  if (cursor.kind === "gap") return "hidden lines";
  const place = `${cursor.file.split("/").at(-1)}:${cursor.line}`;
  if (!state.visual) return place;
  const count = Math.abs(cursor.line - state.visual.line) + 1;
  return `${place} · ${count} ${count === 1 ? "line" : "lines"}`;
};
export function toggleInputMode() {
  state.inputMode = state.inputMode === "vim" ? "mouse" : "vim";
  state.visual = null;
  rerender();
  toast(state.inputMode === "vim" ? "Vim mode: keyboard cursor" : "Mouse mode: hover a line for +");
}
const LINE_SCROLL = 57;
const vimOr = (vim: () => void, mouse: () => void) => () => (state.inputMode === "vim" ? vim() : mouse());

// V: start or end a visual line selection at the cursor.
function toggleVisual() {
  if (state.visual) {
    state.visual = null;
    return setCursor(state.cursor);
  }
  ensureCursor();
  if (state.cursor?.kind !== "line") return toast("V selects code lines");
  state.visual = { ...state.cursor };
  setCursor(state.cursor);
}
// Folding, one level at a time, on whatever the cursor is on. Enter / zo opens: a hidden-line range,
// a closed note, then that note's replies, a collapsed thread; on a file header Enter toggles the file.
// Esc / zc closes in reverse; zc on a code line folds its file (Esc never does, it only backs out).
const noteThread = (key: string) => state.threads.find((t) => t.target.kind === "note" && t.target.note === key);
function lineThread(cursor: Extract<Cursor, { kind: "line" }>) {
  return state.threads.findLast(
    (t) =>
      t.target.kind === "line" &&
      hunks[t.target.hunkId]!.file === cursor.file &&
      t.target.side === cursor.side &&
      t.target.line === cursor.line,
  );
}
function openHere() {
  const cursor = (ensureCursor(), state.cursor);
  if (!cursor) return;
  // On a file header Enter toggles, like clicking the header: a deliberate spot, and otherwise dead.
  if (cursor.kind === "file") return toggleFile(cursor.file);
  if (cursor.kind === "gap") return openRange(cursor.file, cursor.index);
  if (cursor.kind === "line") {
    const thread = lineThread(cursor);
    return thread && openThread(thread.id);
  }
  const [kind, ...rest] = cursor.key.split(":");
  const key = rest.join(":");
  if (kind === "thread") return state.activeThread !== key && openThread(key);
  if (!state.openNotes.has(key)) return setNoteOpen(key, true);
  const thread = noteThread(key);
  if (thread && state.activeThread !== thread.id) openThread(thread.id);
}
function closeHere(fromEscape = false) {
  const cursor = (ensureCursor(), state.cursor);
  if (!cursor) return false;
  if (cursor.kind === "anno") {
    const [kind, ...rest] = cursor.key.split(":");
    const key = rest.join(":");
    if (kind === "thread") return state.activeThread === key && (closeThread(), true);
    const thread = noteThread(key);
    if (thread && state.activeThread === thread.id) return closeThread(), true;
    return state.openNotes.has(key) && (setNoteOpen(key, false), true);
  }
  if (fromEscape || cursor.kind === "gap") return false;
  if (state.foldedFiles.has(cursor.file)) return false;
  toggleFile(cursor.file);
  setCursor({ kind: "file", file: cursor.file });
  return true;
}
function toggleHere() {
  const cursor = (ensureCursor(), state.cursor);
  if (cursor?.kind === "file" && state.foldedFiles.has(cursor.file)) return openHere();
  if (cursor?.kind === "anno") {
    const key = cursor.key.split(":").slice(1).join(":");
    const open = cursor.key.startsWith("note:") ? state.openNotes.has(key) : state.activeThread === key;
    return open ? closeHere() : openHere();
  }
  if (cursor?.kind === "gap") return openHere();
  closeHere();
}
// Opens a hidden-line range, then puts the cursor on its first line.
const expanders = new Map<string, (index: number) => void>();
function openRange(file: string, index: number) {
  const gap = stops().find((stop) => stop.kind === "gap" && stop.file === file && stop.index === index);
  expanders.get(`${current().id}|${file}`)?.(index);
  const top = gap?.top ?? 0;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const next = stops().find((stop) => stop.kind === "line" && stop.file === file && stop.top >= top - 1);
      if (next) setCursor(asCursor(next));
    }),
  );
}
function foldAll(folded: boolean) {
  setFilesFolded(filesOf(current()), folded);
  if (folded && state.cursor) setCursor({ kind: "file", file: cursorFile() });
}
// Puts the cursor on an annotation once its diff has mounted it.
function cursorTo(key: string, tries = 30) {
  requestAnimationFrame(() => {
    const stop = stops().find((s) => s.kind === "anno" && s.key === key);
    if (!stop) return tries && cursorTo(key, tries - 1);
    setCursor(asCursor(stop));
  });
}

export function refresh() {
  state.sourceChanged = false;
  toast("Refreshed. Progress kept for unchanged hunks");
}

// The TUI splits once the diff gets 120 columns; 12.5px JetBrains Mono is ~7.5px a column.
const AUTO_SPLIT_WIDTH = 120 * 7.5;
const diffWidth = () => innerWidth - (state.sidebar ? 264 : 0) - 8 - 64;
export const layout = () =>
  state.layoutMode !== "auto" ? state.layoutMode : diffWidth() >= AUTO_SPLIT_WIDTH ? "split" : "unified";
const layoutNames = { auto: "auto", split: "split", unified: "stacked" };
function setLayout(mode: typeof state.layoutMode) {
  state.layoutMode = mode;
  rerender();
  toast(`Diff layout: ${layoutNames[mode]}${mode === "auto" ? ` (${layoutNames[layout()]})` : ""}`);
}
let lastLayout = layout();
addEventListener("resize", () => {
  if (layout() === lastLayout) return;
  lastLayout = layout();
  rerender();
});
// Folding is view state only: it hides a hunk's code, never its place in the walkthrough.
export function toggleFile(file = cursorFile()) {
  if (state.foldedFiles.has(file)) state.foldedFiles.delete(file);
  else state.foldedFiles.add(file);
  rerender();
}
export function setFilesFolded(files: string[], folded: boolean) {
  for (const file of files) folded ? state.foldedFiles.add(file) : state.foldedFiles.delete(file);
  rerender();
}
export const sectionOf = (file: string) => current().hunkIds.filter((id) => hunks[id]!.file === file);
// Checking marks every hunk of the file in this view, folds it and moves to the next unviewed file.
// Unchecking clears only this view's hunks of the file.
export function toggleViewed(file = cursorFile()) {
  const section = sectionOf(file);
  if (isViewed(section)) {
    for (const id of section) state.viewed.delete(id);
    state.foldedFiles.delete(file);
    return rerender();
  }
  for (const id of section) state.viewed.add(id);
  state.foldedFiles.add(file);
  const next = current().hunkIds.find((id) => !state.viewed.has(id));
  if (next) unfold(next);
  rerender();
  revealFile(next ? hunks[next]!.file : file);
}

// ─── notes ────────────────────────────────────────────────────────────────────
// Opening or clicking a note makes it the active one, which `c` and `r` act on.
export function setNoteOpen(key: string, open: boolean) {
  open ? state.openNotes.add(key) : state.openNotes.delete(key);
  if (open) state.cursor = { kind: "anno", key: `note:${key}` };
  state.activeNote = noteOf(state.cursor);
  paintAnnotations();
}
export function activateNote(key: string) {
  if (state.activeNote === key) return;
  state.cursor = { kind: "anno", key: `note:${key}` };
  state.activeNote = key;
  paintAnnotations();
}
// `r` replies in the open discussion; on the active note it continues the note's latest open
// discussion, or starts one.
function replyHere() {
  if (state.activeThread) return reply();
  const cursor = (ensureCursor(), state.cursor);
  if (cursor?.kind === "anno") {
    const [kind, ...rest] = cursor.key.split(":");
    if (kind === "note") return replyToNote(rest.join(":"));
    if (kind === "thread") {
      openThread(rest.join(":"));
      return reply();
    }
  }
  if (cursor?.kind === "line") {
    const thread = state.threads.findLast(
      (t) =>
        t.target.kind === "line" &&
        hunks[t.target.hunkId]!.file === cursor.file &&
        t.target.side === cursor.side &&
        t.target.line === cursor.line,
    );
    if (thread) {
      openThread(thread.id);
      return reply();
    }
  }
  toast("Nothing to reply to here: move onto a note or thread (c comments on code)");
}
// A note is the first message of at most one thread: replying continues it, creating it on the
// first reply.
export function replyToNote(key: string) {
  const note = state.notes.find((n) => noteKey(n) === key)!;
  const thread = state.threads.find((t) => t.target.kind === "note" && t.target.note === key);
  state.openNotes.add(key);
  state.activeNote = key;
  state.activeThread = thread?.id ?? "";
  state.replying = !!thread;
  state.composing = thread ? null : { kind: "note", hunkId: note.hunkId, note: key };
  goToHunk(note.hunkId, false);
  focusComposer();
}
// `i` opens every agent note, or closes them all if they're all open. Chips still open one at a time.
function toggleNotes() {
  if (!state.notes.length) return toast("No agent notes");
  const open = state.notes.some((note) => !state.openNotes.has(noteKey(note)));
  for (const note of state.notes) open ? state.openNotes.add(noteKey(note)) : state.openNotes.delete(noteKey(note));
  if (!open) state.activeNote = "";
  paintAnnotations();
}
// ─── jumping ──────────────────────────────────────────────────────────────────
// One grammar for jumps: n / p go to the next / previous thing to read (a note or an open thread);
// ] or [ plus a letter jumps by kind, as in Neovim: ]c change (hunk), ]n note, ]t thread, ]f file.
// Past the last one in the view, jumps continue into the next or previous group.
type JumpKind = "any" | "note" | "thread" | "change" | "file";
const jumpNames: Record<JumpKind, string> = { any: "notes or threads", note: "notes", thread: "open threads", change: "changes", file: "files" };
const annoKind = (key: string) => (key.startsWith("note:") ? "note" : key.startsWith("thread:") ? "thread" : "");
// Every changed line of the view's hunks, keyed file:side:line, mapped to its hunk.
function changedLines() {
  const lines = new Map<string, string>();
  for (const id of current().hunkIds) {
    const [, oldStart, newStart] = hunks[id]!.patch.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)!;
    let oldLine = Number(oldStart);
    let newLine = Number(newStart);
    for (const line of hunks[id]!.patch.split("\n").slice(1)) {
      if (line[0] === "-") lines.set(`${hunks[id]!.file}:deletions:${oldLine}`, id);
      if (line[0] === "+") lines.set(`${hunks[id]!.file}:additions:${newLine}`, id);
      if (line[0] !== "+") oldLine++;
      if (line[0] !== "-") newLine++;
    }
  }
  return lines;
}
function isJumpStop(stop: Stop, kind: JumpKind, starts: Set<Stop>) {
  if (kind === "file") return stop.kind === "file";
  if (kind === "change") return starts.has(stop);
  if (stop.kind !== "anno") return false;
  const found = annoKind(stop.key);
  return kind === "any" ? found !== "" : found === kind;
}
// Where each group's jump targets are, in reading order, for continuing past the view.
function groupTargets(index: number, kind: JumpKind, item = state.items[index]!): (() => void)[] {
  const order = (hunkId: string) => item.hunkIds.indexOf(hunkId);
  const out: { at: number; go: () => void }[] = [];
  if (kind === "any" || kind === "note")
    for (const note of notesOf(item.hunkIds)) out.push({ at: order(note.hunkId) * 1e6 + note.line, go: () => openNote(noteKey(note)) });
  if (kind === "any" || kind === "thread")
    for (const thread of state.threads)
      if (!thread.resolved && item.hunkIds.includes(thread.target.hunkId))
        out.push({ at: order(thread.target.hunkId) * 1e6 + (thread.target.kind === "line" ? thread.target.line : 0), go: () => openThread(thread.id) });
  if (kind === "change" || kind === "file")
    out.push({ at: 0, go: () => select(index, item.hunkIds[0]) });
  return out.sort((a, b) => a.at - b.at).map(({ go }) => go);
}
function jump(kind: JumpKind, delta: 1 | -1) {
  const { list, at } = ensureCursor();
  // A change starts at the first stop showing one of its hunk's changed lines (on the cursor's side
  // in split view).
  const starts = new Set<Stop>();
  if (kind === "change") {
    const changed = changedLines();
    const seen = new Set<string>();
    for (const stop of list) {
      const hunk = stop.kind === "line" ? changed.get(`${stop.file}:${stop.side}:${stop.line}`) : undefined;
      if (hunk && !seen.has(hunk)) {
        seen.add(hunk);
        starts.add(stop);
      }
    }
  }
  const hits = list.map((stop, index) => ({ stop, index })).filter(({ stop }) => isJumpStop(stop, kind, starts));
  const next = delta === 1 ? hits.find(({ index }) => index > at) : hits.findLast(({ index }) => index < at);
  if (next) {
    if (next.stop.kind === "anno" && next.stop.key.startsWith("note:")) state.openNotes.add(next.stop.key.slice(5));
    setCursor(asCursor(next.stop), next.stop);
    return;
  }
  // Nothing of that kind mounted yet (a view that just opened): use the view's own targets.
  if (!hits.length && kind !== "file") {
    const own = groupTargets(state.index, kind, current());
    const target = delta === 1 ? own[0] : own.at(-1);
    if (target && kind !== "change") return target();
  }
  const none = () => toast(`No more ${jumpNames[kind]} ${delta === 1 ? "below" : "above"}`);
  if (state.file) return none();
  for (let i = state.index + delta; i >= 0 && i < state.items.length; i += delta) {
    const targets = groupTargets(i, kind);
    const target = delta === 1 ? targets[0] : targets.at(-1);
    if (target) return target();
  }
  none();
}
function openNote(key: string) {
  const note = state.notes.find((n) => noteKey(n) === key)!;
  state.openNotes.add(key);
  goToHunk(note.hunkId, false);
  revealAnnotation(`note:${key}`);
  cursorTo(`note:${key}`);
}

// ─── references ───────────────────────────────────────────────────────────────
// Agent-authored links name an exact snapshot side, path and range: gyst:new/path#L40-L52.
export function followReference(reference: string) {
  const match = reference.match(/^gyst:(new|old)\/(.+)#L(\d+)(?:-L\d+)?$/);
  const hit = match && Object.values(hunks).find((hunk) => {
    const [start, end] = rangeOf(hunk.id)[match[1] as "new" | "old"];
    return hunk.file === match[2] && Number(match[3]) >= start! && Number(match[3]) <= end!;
  });
  if (!hit) return toast("That range isn't in this snapshot");
  state.back.push({ index: state.index, file: state.file, scroll: scroller()?.scrollTop ?? 0 });
  goToHunk(hit.id);
}
export function goBack() {
  const place = state.back.pop();
  if (!place) return toast("Nothing to go back to");
  state.index = place.index;
  state.file = place.file;
  rerender();
  requestAnimationFrame(() => scroller()?.scrollTo({ top: place.scroll }));
}

// ─── discussions ──────────────────────────────────────────────────────────────
export const targetKey = (target: Target) =>
  target.kind === "note" ? `note:${target.note}` : `${target.hunkId}:${target.side}:${target.line}`;
function firstChangedLine(hunkId: string) {
  const [, oldStart, newStart] = hunks[hunkId]!.patch.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)!;
  let oldLine = Number(oldStart);
  let newLine = Number(newStart);
  for (const line of hunks[hunkId]!.patch.split("\n").slice(1)) {
    if (line[0] === "+") return { side: "additions" as const, line: newLine };
    if (line[0] === "-") return { side: "deletions" as const, line: oldLine };
    oldLine++;
    newLine++;
  }
  return { side: "additions" as const, line: Number(newStart) };
}
// A comment is the human starting a thread on code; everything after it, and anything said to an
// agent note, is a reply. `c` comments on the cursor's line or the V selection; the gutter's +
// comments on a specific line directly.
export function startComment(target?: LineTarget) {
  if (!target) {
    const cursor = (ensureCursor(), state.cursor);
    if (cursor?.kind !== "line") return toast("c comments on code: move onto a line (r replies to notes and threads)");
    const hunkId = hunkAt(cursor.file, cursor.side, cursor.line);
    if (!hunkId) return toast("Comments attach to changed hunks");
    const from = state.visual?.file === cursor.file ? state.visual : null;
    const spans = from && (from.line !== cursor.line || from.side !== cursor.side);
    target = {
      kind: "line",
      hunkId,
      side: cursor.side,
      line: cursor.line,
      ...(spans ? { from: { side: from.side, line: from.line } } : {}),
    };
  }
  state.visual = null;
  state.composing = target;
  state.activeThread = "";
  state.replying = false;
  goToHunk(target.hunkId, false);
  focusComposer();
}
export function submitComment(text: string) {
  if (!text.trim()) return;
  if (state.composing) {
    const thread: Thread = {
      id: `t${state.threads.length + 1}`,
      target: state.composing,
      messages: [{ author: "you", text, unread: true }],
      resolved: false,
    };
    drafts.delete(`new:${targetKey(state.composing)}`);
    state.threads.push(thread);
    state.queue.push(thread.id);
    state.composing = null;
    state.activeThread = thread.id;
  } else {
    const thread = state.threads.find((t) => t.id === state.activeThread);
    if (!thread) return;
    thread.messages.push({ author: "you", text, unread: true });
    drafts.delete(`reply:${thread.id}`);
    if (!state.queue.includes(thread.id)) state.queue.push(thread.id);
    state.replying = false;
  }
  toast("Saved. Your agent pulls it through the gyst skill");
}
export function cancelComposer() {
  state.composing = null;
  state.replying = false;
  rerender();
}
export function openThread(id: string) {
  const thread = state.threads.find((t) => t.id === id)!;
  state.activeThread = id;
  state.composing = null;
  state.replying = false;
  state.overlay = "";
  if (thread.target.kind === "note") state.openNotes.add(thread.target.note);
  goToHunk(thread.target.hunkId, false);
  revealAnnotation(thread.target.kind === "note" ? `note:${thread.target.note}` : `thread:${id}`);
  cursorTo(thread.target.kind === "note" ? `note:${thread.target.note}` : `thread:${id}`);
}
export function closeThread() {
  state.activeThread = "";
  state.replying = false;
  rerender();
}
export function reply() {
  if (!state.activeThread) return;
  state.replying = true;
  rerender();
  focusComposer();
}
// Only the human resolves, and resolving never touches Viewed.
export function toggleResolved(id = state.activeThread) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return toast("Open a discussion first");
  thread.resolved = !thread.resolved;
  state.replying = false;
  if (thread.resolved) {
    state.activeThread = "";
    // The thread leaves the diff; the cursor falls back to the line (or note) it was on.
    if (state.cursor?.kind === "anno" && state.cursor.key === `thread:${thread.id}` && thread.target.kind === "line")
      state.cursor = { kind: "line", file: hunks[thread.target.hunkId]!.file, side: thread.target.side, line: thread.target.line };
  }
  toast(thread.resolved ? "Resolved and hidden. Find it under Comments (C)" : "Reopened");
}
const threadOrder = (thread: Thread) => {
  const line = thread.target.kind === "line" ? thread.target.line : 0;
  return readingOrder().indexOf(thread.target.hunkId) * 1e6 + line;
};
export const sortedThreads = () => [...state.threads].sort((a, b) => threadOrder(a) - threadOrder(b));

// ─── the agent's side ─────────────────────────────────────────────────────────
// gyst never runs or signals agents: the agent's gyst skill, run in the harness, pulls unread
// comments and answers through the CLI; replies and note edits arrive here live.

// PROTOTYPE ONLY: canned replies standing in for the real agent. Updated or new notes mark their
// hunk unviewed everywhere; replies alone don't.
export function simulateResponse() {
  let updated = 0;
  for (const id of state.queue) {
    const thread = state.threads.find((t) => t.id === id)!;
    for (const message of thread.messages) delete message.unread;
    const target = thread.target;
    const existing = state.notes.find((note) =>
      target.kind === "note" ? noteKey(note) === target.note : noteKey(note) === noteKey(target),
    );
    const clarification =
      "**Follow-up.** This hunk changes only what's described above:\n\n- behaviour elsewhere is unchanged\n- no code changed in response to the question\n\n_Simulated agent clarification._";
    if (existing) {
      existing.text += `\n\n${clarification}`;
      existing.updated = true;
    } else if (target.kind === "line") {
      state.notes.push({ hunkId: target.hunkId, side: target.side, line: target.line, text: clarification, updated: true });
    }
    const note = existing ?? state.notes.at(-1)!;
    state.openNotes.add(noteKey(note));
    state.viewed.delete(note.hunkId);
    state.foldedFiles.delete(hunks[note.hunkId]!.file);
    updated++;
    thread.messages.push({
      author: "agent",
      text: `${existing ? "Clarified the note on this line" : "Added a note on this line"}. I didn't change any code; ask if you want a fix.`,
    });
  }
  state.queue = [];
  state.overlay = "";
  if (!updated) return toast("Nothing unread for the agent");
  toast(`Simulated reply to ${updated} ${updated === 1 ? "discussion" : "discussions"}. Updated notes are unviewed again`);
}

const cycleFlavor = () => {
  state.flavor = flavors[(flavors.indexOf(state.flavor) + 1) % flavors.length]!;
  rerender();
  toast(`Catppuccin ${state.flavor}`);
};
const toggleSidebar = () => {
  state.sidebar = !state.sidebar;
  rerender();
};

export function openOverlay(overlay: typeof state.overlay) {
  state.overlay = state.overlay === overlay ? "" : overlay;
  rerender();
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-autofocus]")?.focus());
}

export const actions: { keys: string[]; label: string; run: () => void }[] = [
  { keys: ["j", "k"], label: "Cursor down / up (mouse mode: scroll)", run: () => moveCursor(1) },
  { keys: ["⌃d", "⌃u"], label: "Half a page down / up", run: () => halfPage(1) },
  { keys: ["gg", "G"], label: "Top / bottom", run: () => edge("first") },
  { keys: ["h", "l"], label: "Old / new side of a split diff", run: () => switchSide("deletions") },
  { keys: ["V", "v"], label: "Select lines (then c to comment)", run: toggleVisual },
  { keys: ["↵"], label: "Open what's at the cursor (hidden lines, note, replies, thread); fold or unfold a file header", run: openHere },
  { keys: ["esc"], label: "Close it again (and cancel a comment or selection)", run: () => closeHere(true) },
  { keys: ["J", "K"], label: "Next / previous group", run: () => select(state.index + 1) },
  { keys: ["n", "p"], label: "Next / previous note or open thread", run: () => jump("any", 1) },
  { keys: ["]c", "[c"], label: "Next / previous change (hunk)", run: () => jump("change", 1) },
  { keys: ["]n", "[n"], label: "Next / previous agent note", run: () => jump("note", 1) },
  { keys: ["]t", "[t"], label: "Next / previous open thread", run: () => jump("thread", 1) },
  { keys: ["]f", "[f"], label: "Next / previous file", run: () => jump("file", 1) },
  { keys: ["c"], label: "Comment on the cursor line or selection", run: () => startComment() },
  { keys: ["r"], label: "Reply to the note or thread at the cursor", run: replyHere },
  { keys: ["x"], label: "Resolve or reopen the open discussion", run: () => toggleResolved() },
  { keys: ["C"], label: "All discussions", run: () => openOverlay("threads") },
  { keys: ["⌫"], label: "Back from a reference", run: goBack },
  { keys: ["i"], label: "Show or hide all agent notes", run: toggleNotes },
  { keys: ["m"], label: "Mark file viewed and go to the next", run: () => toggleViewed() },
  { keys: [], label: "Switch between vim and mouse mode", run: toggleInputMode },
  { keys: ["za"], label: "Toggle the fold at the cursor (zo open, zc close; zc on code folds the file)", run: toggleHere },
  { keys: ["zR", "zM"], label: "Unfold / fold every file", run: () => foldAll(false) },
  { keys: ["f"], label: "Focus the file tree", run: () => hooks.focusTree() },
  { keys: ["/"], label: "Search files", run: () => hooks.searchTree() },
  { keys: ["1"], label: "Split diff", run: () => setLayout("split") },
  { keys: ["2"], label: "Stacked diff", run: () => setLayout("unified") },
  { keys: ["0"], label: "Auto diff layout (by width)", run: () => setLayout("auto") },
  { keys: [], label: "Prototype: simulate the agent pulling and replying", run: () => simulateResponse() },
  { keys: ["b"], label: "Show or hide sidebar", run: toggleSidebar },
  { keys: ["t"], label: "Next Catppuccin flavor", run: cycleFlavor },
  { keys: ["R"], label: "Refresh from source", run: refresh },
  { keys: ["⌘", "K"], label: "Command menu", run: () => openOverlay("palette") },
  { keys: ["?"], label: "Keyboard shortcuts", run: () => openOverlay("help") },
];

let pendingG = false;
// z opens Vim's fold commands: za / zo / zc at the cursor, zR / zM for every file.
let pendingZ = false;
// ] and [ take a kind letter next: c change, n note, t thread, f file.
let pendingBracket: 0 | 1 | -1 = 0;
const bracketKinds: Record<string, JumpKind> = { c: "change", n: "note", t: "thread", f: "file" };
const foldKeys: Record<string, () => unknown> = {
  a: () => toggleHere(),
  // zo only ever opens, so on a file header it leaves an open file alone.
  o: () => (state.cursor?.kind === "file" ? state.foldedFiles.has(state.cursor.file) && toggleFile(state.cursor.file) : openHere()),
  c: () => closeHere(),
  R: () => foldAll(false),
  M: () => foldAll(true),
};
addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const inTree = event
    .composedPath()
    .some((node) => (node as Element).tagName?.toLowerCase() === FILE_TREE_TAG_NAME);
  const typing = target instanceof Element && target.closest("input, textarea, [contenteditable]");
  if (event.key === "Escape") {
    if (state.overlay) return openOverlay("");
    if (inTree) return scroller()?.focus();
    if (typing && target.matches("[data-composer]")) {
      target.blur();
      return cancelComposer();
    }
    if (state.composing || state.replying) return cancelComposer();
    if (state.visual) return toggleVisual();
    if (state.inputMode === "vim" && closeHere(true)) return;
    if (state.activeThread) return closeThread();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "k") {
    event.preventDefault();
    return openOverlay("palette");
  }
  if (event.ctrlKey && (event.key === "d" || event.key === "u") && !inTree && !typing && !state.overlay) {
    event.preventDefault();
    const delta = event.key === "d" ? 1 : -1;
    return state.inputMode === "vim" ? halfPage(delta) : smoothScrollBy(((scroller()?.clientHeight ?? 0) / 2) * delta);
  }
  if (inTree || typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.overlay && event.key !== "?") return;
  if (pendingBracket) {
    const delta = pendingBracket;
    pendingBracket = 0;
    const kind = bracketKinds[event.key];
    if (kind) {
      event.preventDefault();
      jump(kind, delta);
      return;
    }
  }
  if (pendingZ) {
    pendingZ = false;
    const fold = foldKeys[event.key];
    if (fold) {
      event.preventDefault();
      fold();
      return;
    }
  }
  const run = {
    j: vimOr(() => moveCursor(1), () => smoothScrollBy(LINE_SCROLL)),
    k: vimOr(() => moveCursor(-1), () => smoothScrollBy(-LINE_SCROLL)),
    ArrowDown: vimOr(() => moveCursor(1), () => smoothScrollBy(LINE_SCROLL)),
    ArrowUp: vimOr(() => moveCursor(-1), () => smoothScrollBy(-LINE_SCROLL)),
    g: () => {
      if (!pendingG) return (pendingG = true), setTimeout(() => (pendingG = false), 600);
      pendingG = false;
      vimOr(() => edge("first"), () => smoothScrollBy(-(scroller()?.scrollTop ?? 0)))();
    },
    G: vimOr(() => edge("last"), () => smoothScrollBy(scroller()?.scrollHeight ?? 0)),
    h: vimOr(() => switchSide("deletions"), () => {}),
    l: vimOr(() => switchSide("additions"), () => {}),
    V: vimOr(toggleVisual, () => {}),
    v: vimOr(toggleVisual, () => {}),
    Enter: vimOr(openHere, () => {}),
    z: () => {
      pendingZ = true;
      setTimeout(() => (pendingZ = false), 800);
    },
    J: () => select(state.index + 1),
    K: () => select(state.index - 1),
    n: () => jump("any", 1),
    p: () => jump("any", -1),
    c: () => startComment(),
    "]": () => (pendingBracket = 1),
    "[": () => (pendingBracket = -1),
    r: replyHere,
    x: () => toggleResolved(),
    C: () => openOverlay("threads"),
    Backspace: goBack,
    i: toggleNotes,
    m: () => toggleViewed(),
    f: () => hooks.focusTree(),
    "/": () => hooks.searchTree(),
    "1": () => setLayout("split"),
    "2": () => setLayout("unified"),
    "0": () => setLayout("auto"),
    b: toggleSidebar,
    t: cycleFlavor,
    R: refresh,
    "?": () => openOverlay("help"),
  }[event.key];
  if (!run) return;
  event.preventDefault();
  run();
});

// ─── one diff per file ────────────────────────────────────────────────────────
// A file's hunks in the current view render as one diff over the full old/new contents, so touching
// hunks read as continuous code and every hidden range shows its line count and expands.
// A group's view of a file can hide another group's hunks. The shown hunks alone don't line up with
// the full contents (the old and new sides of the hidden ranges differ in length), so such a file
// renders from its patch, with separators relabelled from the snapshot. Clicking any of its ranges
// brings the other groups' hunks in as real changes, never as fake unchanged lines, which makes the
// file consistent again, then opens the range that was clicked.

const contents = sample.contents as Record<string, { old: string | null; new: string }>;
// Files whose other-group hunks a reader brought into a group's diff, keyed `${itemId}:${file}`.
const revealed = new Set<string>();
// The range to open once that re-render lands: between two shown hunks (undefined = file edge).
const pendingExpand = new Map<string, { after?: string; before?: string }>();

// Notes, threads and the new-comment composer ride the diff as line annotations. Each annotation is
// a stable container the app repaints in place when its content changes, so the diff never re-renders
// for a note edit or a new reply.
type Annotation = { kind: "note" | "thread" | "draft"; key: string };
const annotationMeta = new Map<string, Annotation>();
const annotation = (kind: Annotation["kind"], key: string) => {
  const id = `${kind}:${key}`;
  if (!annotationMeta.has(id)) annotationMeta.set(id, { kind, key });
  return annotationMeta.get(id)!;
};
const kindOrder = { note: 0, thread: 1, draft: 2 };
function annotationsFor(hunkIds: string[]): DiffLineAnnotation<Annotation>[] {
  const list: DiffLineAnnotation<Annotation>[] = notesOf(hunkIds).map((note) => ({
    side: note.side,
    lineNumber: note.line,
    metadata: annotation("note", noteKey(note)),
  }));
  // Resolved threads leave the diff; opening one from the Comments list (C) shows it again.
  for (const thread of state.threads)
    if (thread.target.kind === "line" && hunkIds.includes(thread.target.hunkId) && (!thread.resolved || state.activeThread === thread.id))
      list.push({ side: thread.target.side, lineNumber: thread.target.line, metadata: annotation("thread", thread.id) });
  const draft = state.composing;
  if (draft?.kind === "line" && hunkIds.includes(draft.hunkId))
    list.push({ side: draft.side, lineNumber: draft.line, metadata: annotation("draft", targetKey(draft)) });
  return list.sort(
    (a, b) => a.lineNumber - b.lineNumber || kindOrder[a.metadata.kind] - kindOrder[b.metadata.kind],
  );
}

// Painters come from the variant, which owns the markup; the engine only owns when to paint.
export const painters = {
  note: (_element: HTMLElement, _note: Note) => {},
  thread: (_element: HTMLElement, _thread: Thread) => {},
  draft: (_element: HTMLElement, _target: Target) => {},
};
function paint(element: HTMLElement) {
  const [kind, ...rest] = element.dataset.anno!.split(":");
  const key = rest.join(":");
  if (kind === "note") {
    const note = state.notes.find((n) => noteKey(n) === key);
    const threads = state.threads.filter((t) => t.target.kind === "note" && t.target.note === key);
    const signature = JSON.stringify([note, state.openNotes.has(key), state.activeNote === key, state.flavor, threads, state.activeThread, state.replying, state.composing]);
    if (element.dataset.sig === signature) return;
    element.dataset.sig = signature;
    if (note) painters.note(element, note);
  } else if (kind === "thread") {
    const thread = state.threads.find((t) => t.id === key);
    const signature = JSON.stringify([thread, state.activeThread === key && state.replying, state.activeThread === key]);
    if (element.dataset.sig === signature) return;
    element.dataset.sig = signature;
    if (thread) painters.thread(element, thread);
  } else if (kind === "draft" && state.composing && !element.dataset.sig) {
    element.dataset.sig = "draft";
    painters.draft(element, state.composing);
  }
}
export function paintAnnotations(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-anno]").forEach(paint);
  drawCursor();
}
export function paintMarkdown(element: HTMLElement, source: string) {
  element.innerHTML = markdownHTML(source);
  for (const button of element.querySelectorAll<HTMLElement>("[data-ref]"))
    button.addEventListener("click", () => followReference(button.dataset.ref!));
  hydrateDiagrams(element, state.flavor);
}

// The code background follows the app's --code-bg token instead of the Shiki theme's own.
// The cursor and V selection reuse the diff's line selection, tinted with the accent so they show
// on changed lines too.
// The cursor on a hidden-line range outlines its bar.
const diffCSS = `pre,[data-diffs]{--diffs-dark-bg:var(--code-bg)!important;--diffs-light-bg:var(--code-bg)!important}
[data-content]>[data-selected-line]{background-image:linear-gradient(var(--cursor-tint),var(--cursor-tint));box-shadow:inset 2px 0 var(--accent)}
[data-selected-line]{--cursor-tint:color-mix(in srgb,var(--accent) 16%,transparent)}
:host([data-cursor-side="deletions"]) [data-additions] [data-selected-line],:host([data-cursor-side="additions"]) [data-deletions] [data-selected-line]{background-image:none;box-shadow:none;background-color:transparent}
[data-separator][data-cursor] [data-separator-content],[data-separator][data-cursor] [data-separator-wrapper]{box-shadow:inset 0 0 0 1.5px var(--accent)}`;
const cache = new Map<string, { element: HTMLElement; diff: FileDiff<Annotation>; signature: string }>();
// The diffs on screen, keyed `${itemId}|${file}`, for drawing the cursor.
const live = new Map<string, FileDiff<Annotation>>();
const lineCount = (text: string | null) => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

export function fileDiffElement(item: Item, file: string, hunkIds: string[]): HTMLElement {
  const all = Object.values(hunks).filter((hunk) => hunk.file === file).map((hunk) => hunk.id);
  const shown = (revealed.has(`${item.id}:${file}`) ? all : hunkIds).slice().sort(byPosition);
  const hidden = all.filter((id) => !shown.includes(id));
  const key = `${state.flavor}:${layout()}:${state.inputMode}:${item.id}:${file}:${shown.length}`;
  const annotations = annotationsFor(shown);
  const signature = annotations.map((a) => `${a.metadata.kind}:${a.metadata.key}`).join("|");
  const cached = cache.get(key);
  if (live.size && ![...live.keys()][0]!.startsWith(`${item.id}|`)) live.clear();
  if (cached) {
    live.set(`${item.id}|${file}`, cached.diff);
    if (cached.signature !== signature) {
      cached.signature = signature;
      cached.diff.setLineAnnotations(annotations);
      cached.diff.rerender();
    }
    return cached.element;
  }
  // Range i sits above shown[i]; range shown.length trails the last hunk.
  const gapOf = (id: string) => shown.filter((other) => byPosition(other, id) < 0).length;
  const foreignGaps = new Set(hidden.map(gapOf));

  const element = h("div", { class: "diff" });
  const oldPath = isNewFile(file) ? "/dev/null" : `a/${file}`;
  const patch = getSingularPatch(`--- ${oldPath}\n+++ b/${file}\n${shown.map((id) => hunks[id]!.patch).join("\n")}\n`);
  const full = contents[file]!;
  const files = {
    oldFile: full.old === null ? null : { name: file, contents: full.old },
    newFile: { name: file, contents: full.new },
  } as never;
  const diff = new FileDiff<Annotation>({
    theme: `catppuccin-${state.flavor}`,
    themeType: state.flavor === "latte" ? "light" : "dark",
    diffStyle: layout(),
    overflow: "wrap",
    disableFileHeader: true,
    diffIndicators: "bars",
    lineDiffType: "word",
    hunkSeparators: "line-info",
    expansionLineCount: 20,
    unsafeCSS: diffCSS,
    // Only there so separators carry their range index; clicks on them are intercepted below.
    loadDiffFiles: hidden.length ? async () => files : undefined,
    // Clicking a line puts the cursor there; dragging across line numbers makes a V selection.
    enableLineSelection: true,
    onLineSelected: (range) => {
      drawn.delete(diff);
      if (!range) return;
      const side = (range.endSide ?? range.side ?? "additions") as Side;
      state.visual =
        range.start !== range.end ? { kind: "line", file, side: (range.side ?? side) as Side, line: range.start } : null;
      setCursor({ kind: "line", file, side, line: range.end });
    },
    onLineClick: ({ lineNumber, annotationSide }) => {
      state.visual = null;
      if (layout() === "split") state.cursorSide = annotationSide;
      setCursor({ kind: "line", file, side: annotationSide, line: lineNumber });
    },
    enableGutterUtility: state.inputMode === "mouse",
    // A click comments on one line; dragging the + across lines comments on the range.
    onGutterUtilityClick: (range) => {
      drawn.delete(diff);
      const at = lineTarget(shown, range.end, range.endSide ?? range.side ?? "additions");
      if (!at) return toast("Comments attach to changed lines");
      const from = { side: (range.side ?? at.side) as Side, line: range.start };
      startComment({ kind: "line", ...at, ...(from.line !== at.line || from.side !== at.side ? { from } : {}) });
    },
    onPostRender: (node) => {
      if (!hidden.length) return;
      for (const separator of node.shadowRoot?.querySelectorAll<HTMLElement>("[data-expand-index]") ?? []) {
        const index = Number(separator.dataset.expandIndex);
        const count = hiddenLines(shown, index, full);
        const label = separator.querySelector("[data-unmodified-lines]");
        // Without full contents the diff can't tell that the last hunk reaches the end of the file.
        separator.style.display = count > 0 ? "" : "none";
        if (label)
          label.textContent = foreignGaps.has(index)
            ? `${count} lines, with changes from another group`
            : `${count} unmodified ${count === 1 ? "line" : "lines"}`;
      }
    },
    // Annotations are slotted into the light DOM, so the app stylesheet styles them.
    renderAnnotation: ({ metadata }) => {
      const container = h("div", { class: "anno", "data-anno": `${metadata.kind}:${metadata.key}` });
      paint(container);
      return container;
    },
  });
  const bringIn = (index: number) => {
    revealed.add(`${item.id}:${file}`);
    pendingExpand.set(`${item.id}:${file}`, { after: shown[index - 1], before: shown[index] });
    rerender();
  };
  expanders.set(`${item.id}|${file}`, (index) => (hidden.length ? bringIn(index) : diff.expandHunk(index, "both", 1e6)));
  if (hidden.length)
    // Capture runs before the diff's own handler, so these ranges never expand from mismatched lines.
    element.addEventListener(
      "click",
      (event) => {
        const separator = event.composedPath().find((node) => node instanceof HTMLElement && node.dataset.expandIndex != null) as HTMLElement | undefined;
        if (!separator) return;
        event.stopPropagation();
        event.preventDefault();
        bringIn(Number(separator.dataset.expandIndex));
      },
      true,
    );
  diff.render({
    // An added file's patch already holds every line, and the library can't hydrate it without an
    // old side; nothing is hidden, so it needs no contents.
    fileDiff: hidden.length || full.old === null ? patch : hydratePartialDiff("clone", patch, files),
    containerWrapper: element,
    lineAnnotations: annotations,
  });
  const opened = pendingExpand.get(`${item.id}:${file}`);
  if (opened && !hidden.length) {
    pendingExpand.delete(`${item.id}:${file}`);
    const from = opened.after ? shown.indexOf(opened.after) + 1 : 0;
    const to = opened.before ? shown.indexOf(opened.before) : shown.length;
    for (let index = from; index <= to; index++) diff.expandHunk(index, "both", 1e6);
  }
  cache.set(key, { element, diff, signature });
  live.set(`${item.id}|${file}`, diff);
  return element;
}
// Lines hidden above shown[index] (or after the last hunk), counted on the new side.
function hiddenLines(shown: string[], index: number, full: { new: string }) {
  const start = index === 0 ? 1 : rangeOf(shown[index - 1]!).new[1]! + 1;
  const end = index === shown.length ? lineCount(full.new) : rangeOf(shown[index]!).new[0]! - 1;
  return end - start + 1;
}
function lineTarget(shown: string[], line: number, side: string) {
  const hunkId = shown.find((id) => {
    const [start, end] = rangeOf(id)[side === "deletions" ? "old" : "new"];
    return line >= start! && line <= end!;
  });
  return hunkId ? { hunkId, side: (side === "deletions" ? "deletions" : "additions") as Side, line } : undefined;
}

// Tiny hyperscript: enough DOM for a prototype, not a framework.
type Child = Node | string | false | null | undefined | Child[];
export function h(
  tag: string,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (name.startsWith("on")) element.addEventListener(name.slice(2), value as EventListener);
    else if (name === "class") element.className = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  const append = (child: Child) => {
    if (Array.isArray(child)) child.forEach(append);
    else if (child instanceof Node) element.append(child);
    else if (typeof child === "string") element.append(child);
  };
  children.forEach(append);
  return element;
}
