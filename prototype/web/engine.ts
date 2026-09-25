// PROTOTYPE, throwaway. Shared in-memory review state, keys, diff and tree mounting for all variants.
// No daemon, no persistence: every action only mutates this module's state.
import { FileDiff, getSingularPatch } from "@pierre/diffs";
import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import sample from "./sample.json";

export type Hunk = { id: string; file: string; header: string; patch: string };
// Notes anchor to one line of a hunk: `side` picks the old (deletions) or new (additions) file.
export type Note = { hunkId: string; side: "additions" | "deletions"; line: number; text: string };
export type Item = {
  id: string;
  title: string;
  hunkIds: string[];
  notes: Note[];
  accepted: boolean;
  inbox?: true;
};

export const flavors = ["mocha", "macchiato", "frappe", "latte"] as const;
export type Flavor = (typeof flavors)[number];
export const hunks = sample.hunks as Record<string, Hunk>;
export const meta = { scope: sample.scope, title: sample.scopeTitle, repo: sample.repo };

export const state = {
  items: [
    ...(sample.groups as Item[]),
    {
      id: "inbox",
      title: "Not grouped yet",
      hunkIds: sample.inbox,
      notes: [],
      accepted: false,
      inbox: true,
    } satisfies Item,
  ],
  index: 1,
  focus: "" as string,
  layout: (innerWidth >= 1500 ? "split" : "unified") as "split" | "unified",
  flavor: (new URLSearchParams(location.search).get("flavor") ?? "mocha") as Flavor,
  history: ["notes-schema"] as string[],
  sourceChanged: true,
  sidebar: true,
  overlay: "" as "" | "help" | "palette",
  // Files folded in the group view; view state only, never part of the review.
  foldedFiles: new Set<string>(),
  toast: "",
};
state.focus = state.items[state.index]!.hunkIds[0]!;

export const current = () => state.items[state.index]!;
export const groups = () => state.items.filter((item) => !item.inbox);
export const doneCount = () => groups().filter((item) => item.accepted).length;
export const notesFor = (item: Item, hunkId: string) =>
  item.notes.filter((note) => note.hunkId === hunkId);
export const filesOf = (item: Item) => [...new Set(item.hunkIds.map((id) => hunks[id]!.file))];
export const allFiles = () => [...new Set(Object.values(hunks).map((hunk) => hunk.file))];
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
  }, 2200);
}

// Walking onto a hunk in a folded file opens that file.
function setFocus(hunkId: string) {
  state.focus = hunkId;
  state.foldedFiles.delete(hunks[hunkId]!.file);
}

export function select(index: number, hunkId?: string) {
  if (index < 0 || index >= state.items.length) return;
  const changed = index !== state.index;
  state.index = index;
  setFocus(hunkId ?? current().hunkIds[0]!);
  state.overlay = "";
  rerender();
  if (changed && !hunkId) document.querySelector("[data-scroll]")?.scrollTo({ top: 0 });
  else reveal();
}

export function focusHunk(hunkId: string, scroll = true) {
  const index = itemIndexOfHunk(hunkId);
  if (index !== state.index) return select(index, hunkId);
  setFocus(hunkId);
  rerender();
  if (scroll) reveal();
}

function reveal() {
  requestAnimationFrame(() =>
    document.querySelector(`[data-hunk="${state.focus}"]`)?.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }),
  );
}

// One linear walk through the walkthrough: past a group's last hunk continues into the next group.
function step(delta: 1 | -1) {
  const members = current().hunkIds;
  const at = members.indexOf(state.focus) + delta;
  if (at >= 0 && at < members.length) return focusHunk(members[at]!);
  const next = state.index + delta;
  if (next < 0 || next >= state.items.length) return;
  const nextMembers = state.items[next]!.hunkIds;
  select(next, delta === 1 ? nextMembers[0] : nextMembers.at(-1));
}

function pending(delta: 1 | -1) {
  for (let i = state.index + delta; i >= 0 && i < state.items.length; i += delta)
    if (!state.items[i]!.accepted && !state.items[i]!.inbox) return select(i);
  toast(delta === 1 ? "No unreviewed groups below" : "No unreviewed groups above");
}

export function toggleDone() {
  const item = current();
  if (item.inbox) return toast("These hunks become reviewable once the agent groups them");
  item.accepted = !item.accepted;
  if (!item.accepted) {
    state.history = state.history.filter((id) => id !== item.id);
    return toast(`Marked “${item.title}” not done`);
  }
  state.history.push(item.id);
  const next = state.items.findIndex(
    (other, i) => i > state.index && !other.accepted && !other.inbox,
  );
  if (next >= 0) select(next);
  else rerender();
  toast(`Done: ${item.title}`);
}

export function undo() {
  const id = state.history.pop();
  if (!id) return toast("Nothing to undo");
  const index = state.items.findIndex((item) => item.id === id);
  state.items[index]!.accepted = false;
  select(index);
  toast(`Undid “${state.items[index]!.title}”`);
}

export function refresh() {
  state.sourceChanged = false;
  toast("Refreshed. Progress kept for unchanged groups");
}

const toggleLayout = () => {
  state.layout = state.layout === "split" ? "unified" : "split";
  rerender();
};
// Folding is view state only: it hides a hunk's code, never its place in the walkthrough.
export function toggleFile(file = hunks[state.focus]!.file) {
  if (state.foldedFiles.has(file)) state.foldedFiles.delete(file);
  else state.foldedFiles.add(file);
  rerender();
}
export function setFilesFolded(files: string[], folded: boolean) {
  for (const file of files) folded ? state.foldedFiles.add(file) : state.foldedFiles.delete(file);
  rerender();
}
export function toggleAllFiles() {
  const files = filesOf(current());
  setFilesFolded(files, files.some((file) => !state.foldedFiles.has(file)));
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
  { keys: ["j", "k"], label: "Next / previous hunk", run: () => step(1) },
  { keys: ["J", "K"], label: "Next / previous group", run: () => select(state.index + 1) },
  { keys: ["n", "p"], label: "Next / previous unreviewed group", run: () => pending(1) },
  { keys: ["a"], label: "Mark group done", run: toggleDone },
  { keys: ["u"], label: "Undo last done", run: undo },
  { keys: ["z"], label: "Fold or unfold file", run: () => toggleFile() },
  { keys: ["Z"], label: "Fold or unfold all files", run: toggleAllFiles },
  { keys: ["f"], label: "Focus the file tree", run: () => hooks.focusTree() },
  { keys: ["/"], label: "Search files", run: () => hooks.searchTree() },
  { keys: ["s"], label: "Split or unified diff", run: toggleLayout },
  { keys: ["b"], label: "Show or hide sidebar", run: toggleSidebar },
  { keys: ["t"], label: "Next Catppuccin flavor", run: cycleFlavor },
  { keys: ["o"], label: "Open hunk in editor", run: () => toast("Would open in $EDITOR") },
  { keys: ["r"], label: "Refresh from source", run: refresh },
  { keys: ["⌘", "K"], label: "Command menu", run: () => openOverlay("palette") },
  { keys: ["?"], label: "Keyboard shortcuts", run: () => openOverlay("help") },
];

addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const inTree = event
    .composedPath()
    .some((node) => (node as Element).tagName?.toLowerCase() === FILE_TREE_TAG_NAME);
  if (event.key === "Escape") {
    if (state.overlay) return openOverlay("");
    if (inTree) return document.querySelector<HTMLElement>("[data-scroll]")?.focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "k") {
    event.preventDefault();
    return openOverlay("palette");
  }
  if (
    inTree ||
    target.closest("input, textarea, [contenteditable]") ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  if (state.overlay && event.key !== "?") return;
  const run = {
    j: () => step(1),
    k: () => step(-1),
    J: () => select(state.index + 1),
    K: () => select(state.index - 1),
    n: () => pending(1),
    p: () => pending(-1),
    a: toggleDone,
    u: undo,
    z: () => toggleFile(),
    Z: toggleAllFiles,
    f: () => hooks.focusTree(),
    "/": () => hooks.searchTree(),
    s: toggleLayout,
    b: toggleSidebar,
    t: cycleFlavor,
    o: () => toast(`Would open ${hunks[state.focus]!.file} in $EDITOR`),
    r: refresh,
    "?": () => openOverlay("help"),
  }[event.key];
  if (!run) return;
  event.preventDefault();
  run();
});

// Rendered diffs are cached per flavor and layout; re-rendering the shell only re-attaches them.
// The code background follows the app's --code-bg token instead of the Shiki theme's own.
const diffCSS = `pre,[data-diffs]{--diffs-dark-bg:var(--code-bg)!important;--diffs-light-bg:var(--code-bg)!important}`;
const cache = new Map<string, HTMLElement>();
export function diffElement(hunkId: string): HTMLElement {
  const key = `${state.flavor}:${state.layout}:${hunkId}`;
  const notes = notesFor(state.items[itemIndexOfHunk(hunkId)]!, hunkId);
  let element = cache.get(key);
  if (!element) {
    element = document.createElement("div");
    element.className = "diff";
    const hunk = hunks[hunkId]!;
    const oldPath = hunk.header.startsWith("@@ -0,0 ") ? "/dev/null" : `a/${hunk.file}`;
    new FileDiff<Note>({
      theme: `catppuccin-${state.flavor}`,
      themeType: state.flavor === "latte" ? "light" : "dark",
      diffStyle: state.layout,
      overflow: "wrap",
      disableFileHeader: true,
      diffIndicators: "bars",
      lineDiffType: "word",
      hunkSeparators: "simple",
      unsafeCSS: diffCSS,
      // Notes render in the light DOM (slotted), so the app's stylesheet styles them.
      renderAnnotation: (annotation) => {
        const note = annotation.metadata as Note;
        return h("div", { class: "line-note" }, h("span", { class: "note-label" }, "Agent"), h("p", {}, note.text));
      },
    }).render({
      fileDiff: getSingularPatch(`--- ${oldPath}\n+++ b/${hunk.file}\n${hunk.patch}\n`),
      containerWrapper: element,
      lineAnnotations: notes.map((note) => ({ side: note.side, lineNumber: note.line, metadata: note })),
    });
    cache.set(key, element);
  }
  return element;
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
