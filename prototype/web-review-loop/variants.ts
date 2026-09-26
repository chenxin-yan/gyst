// PROTOTYPE, throwaway. The locked-in design (sidebar walkthrough above the snapshot's file tree,
// inset panel, Catppuccin with lavender as the only accent, Inter UI, JetBrains Mono code) carrying
// the review loop: per-hunk Viewed, rich agent notes and inline discussions the agent pulls through
// its gyst skill. No real agent is connected; agent replies are simulated and labelled as such.
import { FileTree, type GitStatusEntry } from "@pierre/trees";
import {
  actions,
  activateNote,
  cursorLabel,
  onCursorMove,
  allFiles,
  cancelComposer,
  closeThread,
  counts,
  current,
  drafts,
  fileDiffElement,
  filesOf,
  goToHunk,
  goBack,
  groups,
  h,
  hooks,
  hunks,
  isNewFile,
  isViewed,
  layout,
  meta,
  notesOf,
  openFile,
  openOverlay,
  openThread,
  painters,
  paintMarkdown,
  refresh,
  reply,
  sectionOf,
  select,
  setFilesFolded,
  setNoteOpen,
  sortedThreads,
  state,
  submitComment,
  targetKey,
  toast,
  toggleFile,
  toggleResolved,
  toggleViewed,
  toggleInputMode,
  noteKey,
  type Item,
  type Target,
  type Thread,
} from "./engine.ts";

const kbd = (...keys: string[]) => keys.map((key) => h("kbd", {}, key));
const basename = (path: string) => path.split("/").at(-1)!;
const dirname = (path: string) => path.split("/").slice(0, -1).join("/");
const unresolved = () => state.threads.filter((thread) => !thread.resolved);
const viewedGroups = () => groups().filter((item) => isViewed(item.hunkIds)).length;

function topBar() {
  return h(
    "header",
    { class: "top" },
    state.back.length > 0 &&
      h("button", { class: "pill back", onclick: goBack, title: "Back to where you were reading (⌫)" }, "← Back", kbd("⌫")),
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
        kbd("R"),
      ),
    state.threads.length > 0 &&
      h("button", { class: "pill", onclick: () => openOverlay("threads") }, `Comments ${unresolved().length}`, kbd("C")),
    h("button", { class: "pill", onclick: () => openOverlay("palette") }, "Search", kbd("⌘", "K")),
  );
}

function statusLine() {
  const item = current();
  const members = item.hunkIds;
  const viewed = isViewed(members);
  return h(
    "footer",
    { class: "status" },
    h("span", { class: `mode ${item.file ? "file" : viewed ? "done" : ""}` }, item.dir ? "Folder" : item.file ? "File" : viewed ? "Viewed" : "Review"),
    h("button", { class: "input-mode", onclick: toggleInputMode, title: "Switch between vim and mouse mode" }, state.inputMode === "vim" ? "Vim" : "Mouse"),
    !item.file && h("span", {}, `Group ${state.index + 1}/${groups().length}`),
    item.file && h("span", {}, item.file),
    state.visual && h("span", { class: "mode visual" }, "Visual"),
    h("span", { class: "ask", title: "Cursor" }, cursorLabel()),
    h("span", { class: "grow" }),
    h(
      "span",
      { class: "layout", title: "Diff layout: 1 split, 2 stacked, 0 auto" },
      state.layoutMode === "auto" ? `auto · ${layout() === "split" ? "split" : "stacked"}` : layout() === "split" ? "split" : "stacked",
    ),
    h("span", { class: "hints" }, kbd("j"), kbd("k"), state.inputMode === "vim" ? " move " : " scroll ", state.inputMode === "vim" && [kbd("V"), " select "], kbd("n"), kbd("p"), " next ", kbd("i"), " notes ", kbd("c"), " comment ", kbd("r"), " reply ", kbd("m"), " viewed ", kbd("?"), " keys"),
  );
}

// ─── annotations: notes, discussions, composer ───────────────────────────────

function composer(draftKey: string, label: string) {
  const submit = () => submitComment(textarea.value);
  const textarea = h("textarea", {
    "data-composer": draftKey,
    rows: 3,
    placeholder: label === "Reply" ? "Reply…" : "Comment on this line…",
    "aria-label": label === "Reply" ? "Reply" : "Comment",
    oninput: (event: Event) => drafts.set(draftKey, (event.target as HTMLTextAreaElement).value),
    // Enter sends, Shift+Enter breaks the line; Enter that confirms an IME composition does neither.
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    },
  }) as HTMLTextAreaElement;
  textarea.value = drafts.get(draftKey) ?? "";
  return h(
    "div",
    { class: "composer" },
    textarea,
    h(
      "div",
      { class: "thread-actions" },
      h("button", { class: "act primary", onclick: submit }, label, kbd("↵")),
      h("button", { class: "act", onclick: cancelComposer }, "Cancel", kbd("esc")),
    ),
  );
}

const linesOf = (thread: Thread) =>
  thread.target.kind === "line" && thread.target.from
    ? `Lines ${Math.min(thread.target.from.line, thread.target.line)}–${Math.max(thread.target.from.line, thread.target.line)}`
    : "";
// A code thread opens with a comment; a note's thread is all replies, the note being its start.
function threadSummary(thread: Thread) {
  const replies = thread.messages.length - (thread.target.kind === "line" ? 1 : 0);
  const counted = replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "";
  const summary = thread.target.kind === "line" ? [linesOf(thread) || "Comment", counted].filter(Boolean).join(" · ") : counted;
  return thread.resolved ? `Resolved · ${summary}` : summary;
}

function threadView(thread: Thread) {
  if (state.activeThread !== thread.id) {
    return h(
      "button",
      { class: `thread-chip ${thread.resolved ? "resolved" : ""}`, onclick: () => openThread(thread.id) },
      h("span", { class: "thread-dot", "aria-hidden": true }),
      threadSummary(thread),
      h("span", { class: "thread-snippet" }, thread.messages[0]!.text),
    );
  }
  return h(
    "div",
    { class: `thread ${thread.resolved ? "resolved" : ""}`, "data-thread": thread.id },
    linesOf(thread) && h("p", { class: "thread-lines" }, linesOf(thread)),
    thread.messages.map((message) =>
      h(
        "div",
        { class: "msg" },
        h(
          "span",
          { class: "msg-author" },
          message.author === "you" ? "You" : "Agent · simulated",
          message.unread && h("span", { class: "queued" }, " · not yet read by agent"),
        ),
        h("p", {}, message.text),
      ),
    ),
    state.replying
      ? composer(`reply:${thread.id}`, "Reply")
      : h(
          "div",
          { class: "thread-actions" },
          h("button", { class: "act", onclick: reply }, "Reply", kbd("r")),
          h("button", { class: "act", onclick: () => toggleResolved(thread.id) }, thread.resolved ? "Reopen" : "Resolve", kbd("x")),
          h("button", { class: "act", onclick: closeThread }, "Close", kbd("esc")),
        ),
  );
}

painters.note = (element, note) => {
  const key = noteKey(note);
  const open = state.openNotes.has(key);
  // Resolved replies leave the note, unless opened from the Comments list.
  const threads = state.threads.filter(
    (t) => t.target.kind === "note" && t.target.note === key && (!t.resolved || state.activeThread === t.id),
  );
  const composing = state.composing?.kind === "note" && state.composing.note === key;
  const count = threads.filter((t) => !t.resolved).length;
  const body = h("div", { class: "note-md" });
  paintMarkdown(body, note.text);
  element.className = `anno line-note ${open ? "open" : ""} ${state.activeNote === key ? "active" : ""}`;
  element.replaceChildren(
    h(
      "button",
      {
        class: `note-toggle ${note.updated ? "updated" : ""}`,
        title: `${note.updated ? "Updated agent note" : "Agent note"}${count ? `, ${count} open ${count === 1 ? "discussion" : "discussions"}` : ""} (i)`,
        "aria-label": note.updated ? "Show updated agent note" : "Show agent note",
        onclick: () => setNoteOpen(key, true),
      },
      count > 0 && String(count),
    ),
    h(
      "div",
      { class: "note-body", onclick: (event: Event) => !(event.target as Element).closest("button") && activateNote(key) },
      h("span", { class: "note-label" }, note.updated ? "Updated" : "Agent"),
      body,
      h(
        "div",
        { class: "note-actions" },
        h("button", { class: "note-close", title: "Hide note", "aria-label": "Hide note", onclick: () => setNoteOpen(key, false) }, "×"),
      ),
    ),
    ...(open && (threads.length > 0 || composing)
      ? [h("div", { class: "note-threads" }, threads.map(threadView), composing && composer(`new:${targetKey(state.composing!)}`, "Reply"))]
      : []),
  );
};
painters.thread = (element, thread) => {
  element.className = "anno line-thread";
  element.replaceChildren(threadView(thread));
};
painters.draft = (element, target: Target) => {
  element.className = "anno line-thread";
  element.replaceChildren(composer(`new:${targetKey(target)}`, "Comment"));
};

// ─── files ───────────────────────────────────────────────────────────────────
// One compact block per file: an inset header bar, then the file's hunks as one continuous diff.

function fileRuns(item: Item) {
  const runs: { file: string; hunkIds: string[] }[] = [];
  for (const id of item.hunkIds) {
    const file = hunks[id]!.file;
    if (runs.at(-1)?.file === file) runs.at(-1)!.hunkIds.push(id);
    else runs.push({ file, hunkIds: [id] });
  }
  return runs;
}

function fileBlocks(item: Item) {
  return fileRuns(item).map(({ file, hunkIds }) => {
    const folded = state.foldedFiles.has(file);
    const viewed = isViewed(sectionOf(file));
    const { added, removed } = counts(hunkIds);
    const notes = notesOf(hunkIds).length;
    return h(
      "div",
      {
        class: `file ${folded ? "folded" : ""} ${viewed ? "viewed" : ""}`,
        "data-file": file,
      },
      h(
        "div",
        { class: "file-head" },
        h(
          "button",
          { class: "file-toggle", "aria-expanded": !folded, title: folded ? "Unfold file (z)" : "Fold file (z)", onclick: () => toggleFile(file) },
          h("span", { class: "chevron", "aria-hidden": true }),
          h("span", { class: "name" }, basename(file)),
          h("span", { class: "dir" }, dirname(file)),
        ),
        h("span", { class: "grow" }),
        notes > 0 && h("span", { class: "note-count", title: `${notes} agent ${notes === 1 ? "note" : "notes"} (i)` }, String(notes)),
        h("span", { class: "stat" }, h("span", { class: "add" }, `+${added}`), h("span", { class: "del" }, `−${removed}`)),
        h(
          "button",
          {
            class: "viewed-toggle",
            role: "checkbox",
            "aria-checked": viewed ? "true" : "false",
            title: item.file ? "Mark every change in this file viewed (v)" : "Mark this file's changes in the group viewed (v)",
            onclick: () => toggleViewed(file),
          },
          h("span", { class: "box", "aria-hidden": true }),
          "Viewed",
        ),
      ),
      !folded && fileDiffElement(item, file, hunkIds),
    );
  });
}

// The group's overview: the agent's big picture, read before the diff and its notes.
const overviewCache = new Map<string, HTMLElement>();
function overview(item: Item) {
  const key = `${state.flavor}:${item.id}:${item.overview}`;
  let element = overviewCache.get(key);
  if (!element) {
    const body = h("div", { class: "note-md" });
    paintMarkdown(body, item.overview!);
    element = h("section", { class: "overview", "aria-label": "Overview" }, body);
    overviewCache.set(key, element);
  }
  return element;
}

function groupPane() {
  const item = current();
  const files = filesOf(item);
  const anyOpen = files.some((file) => !state.foldedFiles.has(file));
  const viewedCount = files.filter((file) => isViewed(sectionOf(file))).length;
  const next = !item.file && state.items[state.index + 1];
  return h(
    "main",
    { class: "pane", "data-scroll": true, tabindex: -1 },
    h(
      "header",
      { class: "group-head" },
      h(
        "div",
        {},
        h(
          "p",
          { class: "muted small" },
          item.file
            ? `All changes in this ${item.dir ? `folder · ${files.length} files` : "file"} · ${item.hunkIds.filter((id) => state.viewed.has(id)).length}/${item.hunkIds.length} hunks viewed`
            : `Group ${state.index + 1} of ${groups().length} · ${viewedCount}/${files.length} files viewed`,
        ),
        h("h1", {}, item.dir ? `${item.file}/` : item.file ? basename(item.file) : item.title),
      ),
      h(
        "div",
        { class: "head-actions" },
        files.length > 1 &&
          h("button", { class: "pill", onclick: () => setFilesFolded(files, anyOpen) }, anyOpen ? "Fold all" : "Unfold all", kbd(anyOpen ? "zM" : "zR")),
      ),
    ),
    item.overview && overview(item),
    h("div", { class: "stack" }, fileBlocks(item)),
    next &&
      h(
        "footer",
        { class: "group-foot" },
        h("button", { class: "pill next-group", onclick: () => select(state.index + 1) }, h("span", { class: "muted" }, "Next "), next.title, kbd("J")),
      ),
  );
}

function walkthroughList() {
  return h(
    "ol",
    { class: "walk" },
    state.items.map((item, index) => {
      const viewed = isViewed(item.hunkIds);
      const here = !state.file && index === state.index;
      return h(
        "li",
        {},
        h(
          "button",
          {
            class: `walk-row ${here ? "current" : ""} ${viewed ? "done" : ""}`,
            "aria-current": here && "step",
            title: viewed ? "Every hunk viewed" : undefined,
            onclick: () => select(index),
          },
          h("span", { class: "glyph", "aria-hidden": true }, viewed ? "✓" : String(index + 1)),
          h("span", { class: "title" }, item.title),
          h("span", { class: "n" }, String(item.hunkIds.length)),
        ),
      );
    }),
  );
}

function listOverlay(
  entries: { label: string; hint: string; run: () => void }[],
  placeholder: string,
) {
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
          { role: "option", "aria-selected": i === active ? "true" : "false", onclick: () => ((state.overlay = ""), entry.run()) },
          h("span", { class: "entry-label" }, entry.label),
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
        placeholder,
        "aria-label": placeholder,
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

const threadPlace = (thread: Thread) => {
  const file = basename(hunks[thread.target.hunkId]!.file);
  return thread.target.kind === "note" ? `${file} · note` : `${file}:${thread.target.line}`;
};

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
  if (state.overlay === "threads")
    return listOverlay(
      [...sortedThreads().filter((t) => !t.resolved), ...sortedThreads().filter((t) => t.resolved)].map((thread) => ({
        label: `${threadPlace(thread)} — ${thread.messages[0]!.text}`,
        hint: thread.resolved ? "Resolved" : state.queue.includes(thread.id) ? "Unread by agent" : "Open",
        run: () => openThread(thread.id),
      })),
      "Go to a discussion",
    );
  if (state.overlay !== "palette") return null;
  return listOverlay(
    [
      ...state.items.map((item, index) => ({
        label: item.title,
        hint: isViewed(item.hunkIds) ? "Viewed" : `Group ${index + 1}`,
        run: () => select(index),
      })),
      ...allFiles().map((file) => ({ label: file, hint: "All changes in file", run: () => openFile(file) })),
      { label: "Star gyst on GitHub", hint: "Link", run: () => window.open(`https://github.com/${REPO}`, "_blank", "noopener") },
      ...actions.map((action) => ({ label: action.label, hint: action.keys.join(""), run: action.run })),
    ],
    "Go to a group, file or command",
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
  unsafeCSS: `[data-item-section="content"] { color: var(--trees-fg) !important; }
    [data-item-type="folder"] > [data-item-section="git"] { visibility: hidden; }`,
  // A file in the current view scrolls there; any other file opens all its changes, which is also
  // where ungrouped hunks live.
  onSelectionChange: (paths) => {
    if (syncing || paths.length !== 1) return;
    const file = trimSlash(paths[0]!);
    const inCurrent = current().hunkIds.find((id) => hunks[id]!.file === file);
    if (inCurrent) goToHunk(inCurrent);
    else openFile(file);
  },
  // Group numbers stay neutral; ✓ in the success colour once that group's part of the file is viewed.
  renderRowDecoration: ({ row }) => {
    if (row.kind !== "file") return null;
    const owners = state.items
      .map((item, index) => ({ item, index, ids: item.hunkIds.filter((id) => hunks[id]!.file === row.path) }))
      .filter(({ ids }) => ids.length);
    const parts = owners.flatMap(({ index, ids }, i) => [
      ...(i ? [{ text: "\u00a0" }] : []),
      isViewed(ids) ? { text: "✓", color: "var(--done)" } : { text: String(index + 1) },
    ]);
    if (!parts.length) return null;
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

// Beside the name: shadcn/ui's pattern, a ghost link with the GitHub mark and a muted star count.
const REPO = "chenxin-yan/gyst";
let stars: number | null = null;
// PROTOTYPE: fetched live (unauthenticated, rate-limited). A shipped build shouldn't call out on every
// start; bake the count in at release or cache it for a day.
fetch(`https://api.github.com/repos/${REPO}`)
  .then((response) => (response.ok ? response.json() : null))
  .then((repo) => {
    if (typeof repo?.stargazers_count !== "number") return;
    stars = repo.stargazers_count;
    document.querySelector(".star-link")?.replaceWith(starLink());
  })
  .catch(() => {});
const githubMark = () => {
  const icon = h("span", { class: "github-mark", "aria-hidden": true });
  icon.innerHTML =
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
  return icon;
};
function starLink() {
  return h(
    "a",
    {
      class: "star-link",
      href: `https://github.com/${REPO}`,
      target: "_blank",
      rel: "noopener noreferrer",
      title: `Star ${REPO} on GitHub`,
      "aria-label": `Star ${REPO} on GitHub${stars === null ? "" : `, ${stars} stars`}`,
    },
    githubMark(),
    stars !== null && h("span", { class: "star-count" }, stars >= 1000 ? `${Math.round(stars / 1000)}k` : String(stars)),
  );
}

function render() {
  syncTree();
  return h(
    "div",
    { class: `app f-${state.flavor} ${state.sidebar ? "" : "no-sidebar"} ${state.inputMode}` },
    h(
      "nav",
      { class: "side", "aria-label": "Walkthrough and files" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-name" }, "gyst"),
        starLink(),
      ),
      h("p", { class: "side-head" }, "Walkthrough", h("span", { class: "muted" }, `${viewedGroups()}/${groups().length} viewed`)),
      walkthroughList(),
      h("p", { class: "side-head files-head" }, "Changed files", h("span", { class: "muted" }, String(allFiles().length))),
      treeElement,
    ),
    h("div", { class: "panel" }, topBar(), groupPane(), statusLine()),
    overlays(),
    state.toast && h("div", { class: "toast", role: "status" }, state.toast),
  );
}

// The cursor moves per keystroke; only the status line follows it.
onCursorMove(() => document.querySelector(".status")?.replaceWith(statusLine()));

export const variants = [{ key: "review-loop", name: "Review loop", render }];
