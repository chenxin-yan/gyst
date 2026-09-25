// PROTOTYPE, throwaway. One layout (sidebar with walkthrough and file tree framing an inset panel),
// painted with Catppuccin (t cycles Mocha, Macchiato, Frappé, Latte). Each group owns one Catppuccin
// accent, which ties its walkthrough row, tree marks, focus ring, notes and Done button together.
// Variants differ only in typography:
//   N · Sans    Inter for the interface, JetBrains Mono for code
//   O · Mono    one monospace for everything (JetBrains Mono)
//   P · Split   mono chrome (IBM Plex Mono), sans prose for titles and notes (IBM Plex Sans)
import {
  FileTree,
  type FileTreeOptions,
  type GitStatusEntry,
} from "@pierre/trees";
import {
  actions,
  allFiles,
  counts,
  current,
  diffElement,
  doneCount,
  filesOf,
  focusHunk,
  groups,
  h,
  hooks,
  hunks,
  isNewFile,
  meta,
  noteFor,
  openOverlay,
  refresh,
  select,
  state,
  toggleDone,
} from "./engine.ts";

// ─── shared shell ────────────────────────────────────────────────────────────

const kbd = (...keys: string[]) => keys.map((key) => h("kbd", {}, key));
const basename = (path: string) => path.split("/").at(-1)!;
const dirname = (path: string) => path.split("/").slice(0, -1).join("/");
// Semantic colours (green done, red deletions, yellow warnings) are never used as group colours.
const groupColors = ["lavender", "sapphire", "peach", "pink", "teal", "flamingo"];
const colorOf = (index: number) =>
  state.items[index]?.inbox ? "var(--ctp-overlay1)" : `var(--ctp-${groupColors[index % groupColors.length]})`;
const lineOf = (hunkId: string) => hunks[hunkId]!.header.match(/\+(\d+)/)?.[1] ?? "1";

function topBar() {
  return h(
    "header",
    { class: "top" },
    h(
      "span",
      { class: "crumb" },
      h("span", { class: "muted" }, meta.repo),
      h("span", { class: "slash" }, "/"),
      h("span", {}, meta.title),
      h("code", { class: "muted" }, meta.scope),
    ),
    h("span", { class: "grow" }),
    state.sourceChanged &&
      h(
        "button",
        { class: "pill warn", onclick: refresh, title: "Files changed after this snapshot. Refresh to update it." },
        h("span", { class: "dot" }),
        "Source changed",
        kbd("r"),
      ),
    h("button", { class: "pill", onclick: () => openOverlay("palette") }, "Search", kbd("⌘", "K")),
  );
}

function statusLine() {
  const item = current();
  const members = item.hunkIds;
  const hunk = hunks[state.focus]!;
  return h(
    "footer",
    { class: "status" },
    h("span", { class: `mode ${item.inbox ? "inbox" : item.accepted ? "done" : ""}` }, item.inbox ? "Inbox" : item.accepted ? "Done" : "Review"),
    h("span", {}, `Group ${state.index + 1}/${state.items.length}`),
    h("span", {}, `Hunk ${members.indexOf(state.focus) + 1}/${members.length}`),
    h("span", { class: "ask", title: "What /gyst-ask will refer to" }, h("span", { class: "muted" }, "Agent focus "), `${hunk.file}:${lineOf(state.focus)}`),
    h("span", { class: "grow" }),
    h("span", { class: "hints" }, kbd("j"), kbd("k"), " hunk ", kbd("a"), " done ", kbd("f"), " files ", kbd("?"), " keys"),
  );
}

function groupPane() {
  const item = current();
  return h(
    "main",
    { class: "pane", "data-scroll": true, tabindex: -1 },
    h(
      "header",
      { class: "group-head" },
      h(
        "div",
        {},
        h("p", { class: "muted small" }, item.inbox ? "Inbox" : `Group ${state.index + 1} of ${groups().length}`),
        h("h1", {}, item.title),
      ),
      !item.inbox &&
        h(
          "button",
          { class: `done-btn ${item.accepted ? "is-done" : ""}`, onclick: toggleDone },
          item.accepted ? "Done" : "Mark done",
          kbd("a"),
        ),
    ),
    item.inbox && h("p", { class: "muted lede" }, "The agent hasn’t grouped these hunks yet. Read ahead; they become reviewable once published."),
    item.hunkIds.map((hunkId) => {
      const hunk = hunks[hunkId]!;
      const note = noteFor(item, hunkId);
      const { added, removed } = counts(hunkId);
      return h(
        "section",
        { class: `hunk ${hunkId === state.focus ? "focused" : ""}`, "data-hunk": hunkId, onclick: () => focusHunk(hunkId, false) },
        h(
          "div",
          { class: "hunk-head" },
          h("span", { class: "path" }, h("span", { class: "muted" }, dirname(hunk.file) + "/"), basename(hunk.file)),
          h("code", { class: "ctx muted" }, hunk.header.replace(/^@@ .* @@ ?/, "")),
          h("span", { class: "stat" }, h("span", { class: "add" }, `+${added}`), h("span", { class: "del" }, `−${removed}`)),
        ),
        note && h("p", { class: "note" }, note),
        diffElement(hunkId),
      );
    }),
    !item.inbox &&
      h(
        "footer",
        { class: "group-foot" },
        h("button", { class: `done-btn ${item.accepted ? "is-done" : ""}`, onclick: toggleDone }, item.accepted ? "Mark not done" : "Mark done and continue", kbd("a")),
      ),
  );
}

function walkthroughList() {
  return h(
    "ol",
    { class: "walk" },
    state.items.map((item, index) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            class: `walk-row ${index === state.index ? "current" : ""} ${item.accepted ? "done" : ""} ${item.inbox ? "inbox" : ""}`,
            "aria-current": index === state.index && "step",
            style: `--row-color:${colorOf(index)}`,
            onclick: () => select(index),
          },
          h("span", { class: "glyph", "aria-hidden": true }, item.inbox ? "" : item.accepted ? "✓" : String(index + 1)),
          h("span", { class: "title" }, item.title),
          h("span", { class: "n" }, String(item.hunkIds.length)),
        ),
      ),
    ),
  );
}

function overlays() {
  if (state.overlay === "help")
    return h(
      "div",
      { class: "overlay", onclick: () => openOverlay("") },
      h(
        "div",
        { class: "modal", role: "dialog", "aria-label": "Keyboard shortcuts", onclick: (e: Event) => e.stopPropagation() },
        h("h2", {}, "Keyboard shortcuts"),
        h("dl", {}, actions.map((action) => [h("dt", {}, kbd(...action.keys)), h("dd", {}, action.label)])),
        h("button", { class: "pill", "data-autofocus": true, onclick: () => openOverlay("") }, "Close", kbd("esc")),
      ),
    );
  if (state.overlay !== "palette") return null;
  const entries = [
    ...state.items.map((item, index) => ({
      label: item.title,
      hint: item.inbox ? "Inbox" : item.accepted ? "Done" : `Group ${index + 1}`,
      run: () => select(index),
    })),
    ...allFiles().map((file) => ({
      label: file,
      hint: "File",
      run: () => focusHunk(Object.values(hunks).find((hunk) => hunk.file === file)!.id),
    })),
    ...actions.map((action) => ({ label: action.label, hint: action.keys.join(""), run: action.run })),
  ];
  let active = 0;
  let shown = entries;
  const list = h("ul", { role: "listbox" });
  const paint = (query: string) => {
    shown = entries.filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase()));
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...shown.map((entry, i) =>
        h(
          "li",
          { role: "option", "aria-selected": i === active, onclick: () => ((state.overlay = ""), entry.run()) },
          h("span", {}, entry.label),
          h("span", { class: "muted small" }, entry.hint),
        ),
      ),
    );
  };
  paint("");
  return h(
    "div",
    { class: "overlay", onclick: () => openOverlay("") },
    h(
      "div",
      { class: "palette", onclick: (e: Event) => e.stopPropagation() },
      h("input", {
        "data-autofocus": true,
        placeholder: "Go to a group, file or command",
        "aria-label": "Go to a group, file or command",
        oninput: (e: Event) => paint((e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(shown.length, 1);
            paint((e.target as HTMLInputElement).value);
          }
          if (e.key === "Enter" && shown[active]) {
            state.overlay = "";
            shown[active]!.run();
          }
        },
      }),
      list,
    ),
  );
}

function shell(style: string, side: Node, main: Node) {
  return h(
    "div",
    {
      class: `app ${style} f-${state.flavor} ${state.sidebar ? "" : "no-sidebar"}`,
      style: `--group:${colorOf(state.index)}`,
    },
    side,
    h("div", { class: "panel" }, topBar(), main, statusLine()),
    overlays(),
    state.toast && h("div", { class: "toast", role: "status" }, state.toast),
  );
}

// ─── tree plumbing ───────────────────────────────────────────────────────────

// Trees live across shell re-renders: each variant keeps one instance and re-attaches its element.
type Mounted = { tree: FileTree; element: HTMLElement; syncing: boolean };
const trees = new Map<string, Mounted>();
function mountTree(key: string, options: (mounted: Mounted) => FileTreeOptions): Mounted {
  let mounted = trees.get(key);
  if (!mounted) {
    const element = h("div", { class: "tree" });
    mounted = { element, syncing: false } as Mounted;
    mounted.tree = new FileTree({ density: "compact", flattenEmptyDirectories: true, initialExpansion: "open", ...options(mounted) });
    mounted.tree.render({ containerWrapper: element });
    trees.set(key, mounted);
  }
  const { tree } = mounted;
  hooks.focusTree = () => {
    const path = tree.getSelectedPaths()[0];
    if (path) tree.focusPath(path);
    else tree.focusFirstItem();
  };
  hooks.searchTree = () => tree.openSearch();
  return mounted;
}
// Programmatic selection must not echo back through onSelectionChange.
function syncSelection(mounted: Mounted, paths: string[]) {
  const { tree } = mounted;
  const selected = tree.getSelectedPaths();
  if (selected.length === paths.length && paths.every((path) => selected.includes(path))) return;
  mounted.syncing = true;
  for (const path of selected) tree.getItem(path)?.deselect();
  for (const path of paths) tree.getItem(path)?.select();
  mounted.syncing = false;
  if (paths[0]) tree.scrollToPath(paths[0], { focus: false, offset: "nearest" });
}
const redecorate = (mounted: Mounted) => mounted.tree.setComposition(mounted.tree.getComposition());
const trimSlash = (path: string) => path.replace(/\/$/, "");
const gitStatus = (): GitStatusEntry[] =>
  allFiles().map((path) => ({ path, status: isNewFile(path) ? "added" : "modified" }));

// ─── the layout: walkthrough list above the snapshot's file tree ─────────────

function layout(style: string) {
  // One tree per style so each keeps its own scroll and expansion.
  const mounted = mountTree(style, (m) => ({
    paths: allFiles(),
    gitStatus: gitStatus(),
    onSelectionChange: (paths) => {
      if (m.syncing || paths.length !== 1) return;
      const file = trimSlash(paths[0]!);
      // A file may span groups: prefer its hunks in the current group, else its first group.
      const inCurrent = current().hunkIds.find((id) => hunks[id]!.file === file);
      const first = Object.values(hunks).find((hunk) => hunk.file === file);
      if (inCurrent ?? first) focusHunk(inCurrent ?? first!.id);
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind !== "file") return null;
      const owners = state.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.hunkIds.some((id) => hunks[id]!.file === row.path));
      const parts = owners.flatMap(({ item, index }, i) => [
        ...(i ? [{ text: "\u00a0" }] : []),
        {
          text: item.inbox ? "·" : item.accepted ? "✓" : String(index + 1),
          color: item.accepted ? "var(--done)" : colorOf(index),
        },
      ]);
      return {
        text: parts.map((part) => part.text).join(""),
        parts,
        title: owners.map(({ item }) => item.title).join(", "),
      };
    },
  }));
  syncSelection(mounted, filesOf(current()));
  redecorate(mounted);
  return shell(
    style,
    h(
      "nav",
      { class: "side", "aria-label": "Walkthrough and files" },
      h(
        "div",
        { class: "brand" },
        h(
          "span",
          { class: "avatar", "aria-hidden": true },
          groupColors.map((color) => h("span", { style: `background:var(--ctp-${color})` })),
        ),
        h("span", { class: "brand-name" }, "gyst"),
      ),
      h("p", { class: "side-head" }, "Walkthrough", h("span", { class: "muted" }, `${doneCount()}/${groups().length} done`)),
      walkthroughList(),
      h("p", { class: "side-head files-head" }, "Changed files", h("span", { class: "muted" }, String(allFiles().length))),
      mounted.element,
    ),
    groupPane(),
  );
}

export const variants = [
  { key: "N", name: "Sans", render: () => layout("t-sans") },
  { key: "O", name: "Mono", render: () => layout("t-mono") },
  { key: "P", name: "Split", render: () => layout("t-split") },
];
