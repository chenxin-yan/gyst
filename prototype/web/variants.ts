// PROTOTYPE, throwaway. The locked-in design: sidebar (walkthrough above the snapshot's file tree)
// framing an inset panel; Catppuccin with lavender as the only accent and every other colour used
// for its style-guide role (see the colour notes in styles.css); Inter UI, JetBrains Mono code.
// Hunks are grouped by file; t cycles Catppuccin flavors.
import { FileTree, type GitStatusEntry } from "@pierre/trees";
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
  isFolded,
  isNewFile,
  meta,
  noteFor,
  openOverlay,
  refresh,
  select,
  setFoldedMany,
  state,
  toggleDone,
  toggleFold,
  type Item,
} from "./engine.ts";

const kbd = (...keys: string[]) => keys.map((key) => h("kbd", {}, key));
const basename = (path: string) => path.split("/").at(-1)!;
const dirname = (path: string) => path.split("/").slice(0, -1).join("/");
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
    h("span", { class: "hints" }, kbd("j"), kbd("k"), " hunk ", kbd("z"), " fold ", kbd("a"), " done ", kbd("?"), " keys"),
  );
}

// ─── hunks, grouped by file ──────────────────────────────────────────────────
// Consecutive hunks of one file share a quiet sticky file row. Inside a file, a hunk is introduced
// only by a one-line separator with its enclosing context (the diff's own line numbers already carry
// the @@ range), then its note and code. No per-hunk borders, chevrons or counts.

function hunkParts(hunkId: string) {
  const hunk = hunks[hunkId]!;
  const firstChange = hunk.patch.split("\n").slice(1).find((line) => line[0] === "+" || line[0] === "-") ?? "";
  return { hunk, note: noteFor(current(), hunkId), context: hunk.header.replace(/^@@ .*? @@ ?/, ""), firstChange };
}

const pathLabel = (file: string) =>
  h("span", { class: "path" }, h("span", { class: "muted" }, dirname(file) + "/"), basename(file));

// A folded hunk keeps its separator and says what it holds: the agent's note, else its first change.
function preview(hunkId: string) {
  const { note, firstChange } = hunkParts(hunkId);
  if (note) return h("span", { class: "preview" }, note);
  return h("code", { class: "preview" }, firstChange.slice(1).trim());
}

function hunkBlock(hunkId: string) {
  const { note, context } = hunkParts(hunkId);
  const folded = isFolded(hunkId);
  return h(
    "section",
    {
      class: `hunk ${hunkId === state.focus ? "focused" : ""} ${folded ? "folded" : ""}`,
      "data-hunk": hunkId,
      onclick: () => focusHunk(hunkId, false),
    },
    h(
      "button",
      {
        class: "sep",
        "aria-expanded": !folded,
        title: folded ? "Unfold hunk (z)" : "Fold hunk (z)",
        onclick: (event: Event) => {
          event.stopPropagation();
          toggleFold(hunkId);
        },
      },
      h("span", { class: "chevron", "aria-hidden": true }),
      h("code", { class: "ctx" }, context || "…"),
      folded && preview(hunkId),
    ),
    !folded && note && h("p", { class: "note" }, h("span", { class: "note-label" }, "Agent"), note),
    !folded && diffElement(hunkId),
  );
}

function fileBlocks(item: Item) {
  const runs: { file: string; hunkIds: string[] }[] = [];
  for (const id of item.hunkIds) {
    const file = hunks[id]!.file;
    if (runs.at(-1)?.file === file) runs.at(-1)!.hunkIds.push(id);
    else runs.push({ file, hunkIds: [id] });
  }
  return runs.map(({ file, hunkIds }) => {
    const folded = hunkIds.every(isFolded);
    const { added, removed } = counts(hunkIds);
    return h(
      "div",
      { class: `file ${folded ? "folded" : ""}` },
      h(
        "button",
        {
          class: "file-head",
          "aria-expanded": !folded,
          title: folded ? "Unfold file" : "Fold file",
          onclick: () => setFoldedMany(hunkIds, !folded),
        },
        h("span", { class: "chevron", "aria-hidden": true }),
        pathLabel(file),
        h("span", { class: "grow" }),
        h("span", { class: "stat" }, h("span", { class: "add" }, `+${added}`), h("span", { class: "del" }, `−${removed}`)),
      ),
      !folded && hunkIds.map(hunkBlock),
    );
  });
}

function groupPane() {
  const item = current();
  const members = item.hunkIds;
  const anyOpen = members.some((id) => !isFolded(id));
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
      h(
        "div",
        { class: "head-actions" },
        members.length > 1 &&
          h(
            "button",
            { class: "pill", onclick: () => setFoldedMany(members, anyOpen) },
            anyOpen ? "Fold all" : "Unfold all",
            kbd("Z"),
          ),
        !item.inbox &&
          h(
            "button",
            { class: `done-btn ${item.accepted ? "is-done" : ""}`, onclick: toggleDone },
            item.accepted ? "Done" : "Mark done",
            kbd("a"),
          ),
      ),
    ),
    item.inbox && h("p", { class: "muted lede" }, "The agent hasn’t grouped these hunks yet. Read ahead; they become reviewable once published."),
    h("div", { class: "stack" }, fileBlocks(item)),
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

// ─── file tree: every changed file, marked with the groups it belongs to ────

// The tree lives across re-renders; the shell re-attaches its element and re-syncs selection.
let syncing = false;
const trimSlash = (path: string) => path.replace(/\/$/, "");
const gitStatus = (): GitStatusEntry[] =>
  allFiles().map((path) => ({ path, status: isNewFile(path) ? "added" : "modified" }));
const treeElement = h("div", { class: "tree" });
const tree = new FileTree({
  density: "compact",
  flattenEmptyDirectories: true,
  initialExpansion: "open",
  paths: allFiles(),
  gitStatus: gitStatus(),
  // Only a file's status letter carries git colour: names stay body text, and folders drop their
  // "contains changes" dot, since every folder in a changed-files tree contains changes.
  unsafeCSS: `[data-item-section="content"] { color: var(--trees-fg) !important; }
    [data-item-type="folder"] > [data-item-section="git"] { visibility: hidden; }`,
  onSelectionChange: (paths) => {
    if (syncing || paths.length !== 1) return;
    const file = trimSlash(paths[0]!);
    // A file may span groups: prefer its hunks in the current group, else its first group.
    const inCurrent = current().hunkIds.find((id) => hunks[id]!.file === file);
    const first = Object.values(hunks).find((hunk) => hunk.file === file);
    if (inCurrent ?? first) focusHunk(inCurrent ?? first!.id);
  },
  // Group numbers stay neutral; only a completed group earns the success colour.
  renderRowDecoration: ({ row }) => {
    if (row.kind !== "file") return null;
    const owners = state.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.hunkIds.some((id) => hunks[id]!.file === row.path));
    const parts = owners.flatMap(({ item, index }, i) => [
      ...(i ? [{ text: "\u00a0" }] : []),
      item.accepted ? { text: "✓", color: "var(--done)" } : { text: item.inbox ? "·" : String(index + 1) },
    ]);
    return { text: parts.map((part) => part.text).join(""), parts, title: owners.map(({ item }) => item.title).join(", ") };
  },
});
tree.render({ containerWrapper: treeElement });
hooks.focusTree = () => {
  const path = tree.getSelectedPaths()[0];
  if (path) tree.focusPath(path);
  else tree.focusFirstItem();
};
hooks.searchTree = () => tree.openSearch();

function syncTree() {
  const paths = filesOf(current());
  const selected = tree.getSelectedPaths();
  if (!(selected.length === paths.length && paths.every((path) => selected.includes(path)))) {
    syncing = true;
    for (const path of selected) tree.getItem(path)?.deselect();
    for (const path of paths) tree.getItem(path)?.select();
    syncing = false;
    if (paths[0]) tree.scrollToPath(paths[0], { focus: false, offset: "nearest" });
  }
  tree.setComposition(tree.getComposition());
}

function render() {
  syncTree();
  return h(
    "div",
    { class: `app f-${state.flavor} ${state.sidebar ? "" : "no-sidebar"}` },
    h(
      "nav",
      { class: "side", "aria-label": "Walkthrough and files" },
      h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": true }), h("span", { class: "brand-name" }, "gyst")),
      h("p", { class: "side-head" }, "Walkthrough", h("span", { class: "muted" }, `${doneCount()}/${groups().length} done`)),
      walkthroughList(),
      h("p", { class: "side-head files-head" }, "Changed files", h("span", { class: "muted" }, String(allFiles().length))),
      treeElement,
    ),
    h("div", { class: "panel" }, topBar(), groupPane(), statusLine()),
    overlays(),
    state.toast && h("div", { class: "toast", role: "status" }, state.toast),
  );
}

export const variants = [{ key: "final", name: "By file", render }];
