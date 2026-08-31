# Code Context

## Files Retrieved
1. `src/ui/themes.ts` (lines 158-275) — derives all semantic surfaces, signs, tints, badges, and foregrounds from a Shiki theme.
2. `src/ui/diff/rowStyle.ts` (lines 32-185, 426-459) — diff rails, cell palettes, line-number gutters, and gutter text.
3. `src/ui/diff/CodeCellView.tsx` (lines 62-66, 131-147, 196-230) — maps styled spans/palettes to OpenTUI `fg`/`bg` chunks.
4. `src/ui/diff/diffRows.ts` (lines 66-74, 115-195, 213-255, 563-612) — Pierre options, word emphasis, flattening, and highlight cutoff.
5. `src/ui/diff/worker/highlightHast.ts` (lines 72-118) and `src/ui/diff/syntaxHighlightTheme.ts` (lines 9-78) — Shiki/Pierre HAST-to-terminal mapping and theme registration.
6. `src/ui/components/panes/DiffFileHeaderRow.tsx` (lines 13-55), `src/ui/components/panes/FileListItem.tsx` (lines 19-40, 117-208), `src/ui/lib/files.ts` (lines 60-177) — headers and file tree/sidebar.
7. `src/ui/components/chrome/MenuBar.tsx` (lines 23-69), `StatusBar.tsx` (lines 30-105), `ExtensionToast.tsx` (lines 17-41), `MenuDropdown.tsx` (lines 5-107), `ModalFrame.tsx` (lines 56-104), `VerticalScrollbar.tsx` (lines 194-232) — shell chrome.
8. `src/ui/App.tsx` (lines 418-437, 1162-1176, 1263-1416) and `src/ui/components/panes/DiffPane.tsx` (lines 2659-2715) — shell composition, title, pinned header, and conditional bars.
9. `src/core/theme/catalog.ts` (lines 102-190, 233-299) — bundled theme backgrounds/foregrounds and generated semantic diff colors.

# Visual design brief

## 1. Diff rendering

- **Row backgrounds:** additions use `addedBg`, deletions `removedBg`, context `contextBg`; in both split and stack layouts the same color is used for changed gutter and code content (`rowStyle.ts:115-185`). Context gutter uses `lineNumberBg`, normally the editor background; context code uses `contextBg`. Empty split cells use `panelAlt` for content.
- **Default palette (actual resolved values):** for `github-dark-default`, background/context `#0d1117`, added row `#12251d`, removed row `#3c1e21`, added word-content tint `#163923`, removed word-content tint `#4f2325`; for `github-light-default`, background/context `#ffffff`, added row `#e2ece5`, removed row `#f9e4e6`, added word tint `#d4e3d8`, removed word tint `#f6d7d9`.
- **Signs/rails:** every code row has a leading `▌` rail (`rowStyle.ts:32-35`). In split mode the old/left rail is `removedSignColor` only for deletions and the new/right rail is `addedSignColor` only for additions; otherwise neutral `lineNumberFg` (`CodeRowView.tsx:186-197`, `rowStyle.ts:95-113`). Rail background is `theme.panel`, distinct from the cell tint. Default signs: dark added `#2ea043`, removed `#f85149`; light added `#116329`, removed `#cf222e` (catalog `:251-256`).
- **Line numbers:** fixed-width, right-aligned with spaces; split gutter is `<number> <sign>`, stack gutter is `<old-number> <new-number> <sign>` (`rowStyle.ts:426-459`). Changed-line numbers take the semantic sign color; context/empty numbers use `lineNumberFg`; gutter background is `lineNumberBg` (`rowStyle.ts:121-153`). Default line-number foreground is dark `#878c92`, light `#616161`.
- **Active hunk:** code row backgrounds do not become a large selection block. The selected hunk gets full-strength rails and hunk marker; inactive hunk rails blend 35% toward `panel` (`rowStyle.ts:70-113`). Hunk metadata rows are `panelAlt`; marker `▌` is active `lineNumberFg` or dimmed, and hunk-header label is `badgeNeutral` while collapsed label is `muted` (`DiffMetaRowView.tsx:78-104`).
- **Hunk/gap labels:** collapsed gaps render `··· N unchanged line(s) ···`, or `▾ N unchanged line(s)` when expandable (`DiffMetaRowView.tsx:31-40`); one-row `panelAlt` background. Separators are one-cell-height `─` lines in `border` over `panel` (`HunkReviewStream.tsx:62-74`; main stream equivalent `DiffSection.tsx:102-131`).
- **Word-level diff:** Pierre uses `lineDiffType: "word-alt"` (`diffRows.ts:66-74`). A `data-diff-span` becomes a semantic `wordDiff` flag, preserving token foreground; renderer adds only a background (`highlightHast.ts:95-110`, `diffRows.ts:239-245`). Word tint normally uses `addedContentBg`/`removedContentBg` (the values above), with a minimum channel-distance separation of 28 and up to 20% strengthening toward the sign color (`diffRows.ts:115-195`).
- **Other paint layers:** copy selection blends each base cell background 75% toward `selectedHunk`; current-line paint blends 20% toward text (`rowStyle.ts:6-8, 37-67`). Current-line extension tone can reverse-video using text as `bg` and effective theme background as `fg` (`rowStyle.ts:401-409`).

## 2. Syntax highlighting

- **Theme:** each bundled Shiki theme id is also the syntax theme (`themes.ts:272`; catalog has 64 ids). Defaults are `github-dark-default` / `github-light-default`; custom themes inherit a base and append exact TextMate scope colors. If passed only an appearance string, the fallback syntax theme is `pierre-dark` or `pierre-light` (`syntaxHighlightTheme.ts:9-12, 40-55`).
- **Terminal mapping:** Pierre returns nested HAST. The collector recursively inherits `--diffs-token-dark` or `--diffs-token-light`, falling back to CSS `color`, and carries `data-diff-span` as `wordDiff` (`highlightHast.ts:79-118`). Flattening turns each run into `{text, fg, bg}`; normal runs have Shiki token `fg`, word runs get the semantic emphasis `bg` (`diffRows.ts:213-255`). `CodeCellView` converts these to OpenTUI `TextChunk`s / `<span fg={...} bg={...}>`, parsing and caching colors (`CodeCellView.tsx:46-66, 131-147`).
- **Worth it:** yes for normal source-sized diffs: token colors remain visible over semantic row tints, and flattened spans are cached by HAST node/theme/background/tab width (`diffRows.ts:224-255`). It intentionally degrades to flat `syntaxColors.default` (all semantic role slots initially equal the text color in `themes.ts:71-86`) for diffs over 10,000 changed lines (`diffRows.ts:563-595`), where generated/lockfile output gains little from syntax. Eligible >=40-line bundled-theme jobs can offload to a worker (`diffRows.ts:598-612`).

## 3. File headers / file tree

- **Main file header:** one row, `panel` background, one-cell left/right padding; filename is `text`, special suffix `(new)`, `(deleted)`, or `(untracked)` is `muted`. Right-aligned stats are `+N` in `badgeAdded`, a muted separator space, `-N` in `badgeRemoved`, trailing muted space (`DiffFileHeaderRow.tsx:21-55`). Long paths use explicit `...` overflow marker and retain the suffix only when it fits (`fileHeader.ts:5-18, 29-45`).
- **Header stats:** zero-value sidebar stats are hidden; truncated additions display `+N+` (`files.ts:81-84, 141-155`).
- **Sidebar projections:** narrow content (<32 cells) is flat grouped mode; wide content is an always-expanded tree (`files.ts:55-63`). Flat group labels are `./` or `dir/`; tree directory rows are `dir/`, `muted`, indented 2 cells per depth (`FileListItem.tsx:43-71, 74-114`).
- **File markers:** status icon is `?` untracked, `A` new, `D` deleted, `R` rename, `M` modified, each in its corresponding semantic color (`FileListItem.tsx:19-40`). Names are `text`; stats at right are `*N` agent notes in `noteBorder`, `+N` in `badgeAdded`, `-N` in `badgeRemoved` (`FileListItem.tsx:174-202`).
- **Current file:** selected sidebar row uses `panelAlt` and a one-cell `accent` strip at its left; unselected rows use `panel` (`FileListItem.tsx:135-175`). Main review pins the current file header in a dedicated row above the scrollbox (`DiffPane.tsx:2677-2694`).
- **Current hunk:** no full-row fill; hunk selection is communicated by bright vs dim rails/metadata marker as described in section 1. Reusable `HunkReviewStream` passes selected hunk index as the active file's index and uses `panel` as the stream/file surface (`HunkReviewStream.tsx:47-60, 84-97`).

## 4. Chrome

- **Top bar:** one row. Outer `background` with one-cell gutters; inner band is `panelAlt`. Menu labels are `muted`, active menu uses `accentMuted` background + `text`; right-aligned changeset title is `muted` (`MenuBar.tsx:23-69`). The title is concrete: `<changeset title>  N files  +A  -D` (`App.tsx:1162-1172`).
- **Diff frame:** when top chrome is enabled, DiffPane has a top `border` in `border`, `panel` fill, and one row vertical padding; pager mode removes the top chrome/padding (`DiffPane.tsx:2659-2672`).
- **Bottom bars:** no permanent footer/progress counter. Status is conditional: it appears only for filter focus, an active filter, a notice, or a keyboard-mode hint (`App.tsx:424-436`). Both status and extension toast are one-row `panelAlt` bars. Status text is `muted`; `filter:` is `badgeNeutral`; mode hint is an inverse badge (`badgeNeutral` background with `panelAlt` foreground) (`StatusBar.tsx:34-105`). Extension toast prefixes `ext` in type color (error `badgeRemoved`, warning `fileModified`, info `badgeNeutral`) and message in `muted` (`ExtensionToast.tsx:27-41`, `extensionNotifications.ts`).
- **Keybind hints:** dropdown rows are fixed one-cell rows with two-cell horizontal padding. Optional checkboxes are literal `[x]`/`[ ]`; labels are `text`; the right-aligned hint is `muted`, promoted to `text` when selected (`MenuDropdown.tsx:5-34, 88-103`). Hints are generated from resolved command chords, so remaps stay accurate (`appMenus.ts:75-85`). Help modal uses an accent-colored, padded key column and muted descriptions (`HelpDialog.tsx:50-60`). Confirm footers render `key label · key label` with keys in `accent`, labels in `muted`, and hovered action background `accentMuted` (`ConfirmDialog.tsx:26-66`).
- **Dialogs:** centered absolute modal, `panel` fill, one-cell padding, `accent` border; title `text`, close `[Esc]` `badgeNeutral` (`ModalFrame.tsx:56-104`).
- **Progress indicator:** there is no review completion bar or file/hunk `x/y` indicator in the core shell. The only scroll/progress visualization is an auto-hidden one-cell vertical scrollbar: `border` track, `accentMuted` thumb, `accent` thumb while dragging, minimum thumb height 2, hidden after 2 seconds (`VerticalScrollbar.tsx:13-16, 194-232`).

## 5. Palette and layering

`AppTheme` exposes the reusable slots (`src/ui/themes/types.ts:1-42`). Actual resolved canonical palettes are:

| token | github-dark-default | github-light-default |
|---|---|---|
| `background`, `contextBg`, `contextContentBg`, `lineNumberBg` | `#0d1117` | `#ffffff` |
| `panel` | `#1e2329` | `#f6f6f6` |
| `panelAlt` | `#272b31` | `#ededee` |
| `border` | `#34393f` | `#dddedf` |
| `text` / syntax fallback | `#e6edf3` | `#1f2328` |
| `muted` / `badgeNeutral` | `#adaeb1` | `#5a5a5a` |
| `accent`, `noteBorder`, modified | `#bb8009` | `#9a6700` |
| `accentMuted`, `selectedHunk` | `#392d14` | `#ede4d1` |
| `addedSignColor` | `#2ea043` | `#116329` |
| `removedSignColor` | `#f85149` | `#cf222e` |
| `addedBg` (row + gutter/content) | `#12251d` | `#e2ece5` |
| `removedBg` (row + gutter/content) | `#3c1e21` | `#f9e4e6` |
| `addedContentBg` (word emphasis) | `#163923` | `#d4e3d8` |
| `removedContentBg` (word emphasis) | `#4f2325` | `#f6d7d9` |
| `movedAddedBg`, `movedRemovedBg` | `#302714` | `#f3ede0` |
| `lineNumberFg` | `#878c92` | `#616161` |
| `badgeAdded` / file new/untracked | `#77c185` | `#116329` |
| `badgeRemoved` / file deleted | `#fa8e89` | `#cf222e` |
| `badgeModified` / file rename/modified | `#d3ac5f` | `#644300` |
| note background/title background | `#1e2329` | `#f6f6f6` |
| note title text | `#e6edf3` | `#1f2328` |

These values are computed from the theme's editor background/foreground and semantic diff colors: dark rows target 20% sign tint, dark word content 28%, dark selection 25%; light rows target 12%, word content 18%, selection 18% (`themes.ts:163-172, 193-230`). Readability guards enforce 4.5:1 for ordinary text/gutters, 3:1 for signs, and 28 channel-distance between row and word tints (`themes.ts:22-24, 31-68, 88-131`). The source catalog contains the exact per-theme base backgrounds/foregrounds and generated added/removed/modified colors (`catalog.ts:102-190, 233-299`).

## Architecture

`HunkDiffBody` resolves an `AppTheme`, builds split/stack rows, asynchronously obtains cached Pierre/Shiki spans, then delegates each row to `DiffRowView` (`src/opentui/HunkDiffBody.tsx:16-45`). `CodeRowView` chooses the active/inactive rail and delegates terminal cell painting to `CodeCellView`; `CodeCellView` applies semantic row backgrounds, word backgrounds, syntax foregrounds, and optional selection/current-line paint. File headers and the sidebar reuse the same `AppTheme` slots. The reusable OpenTUI stream deliberately excludes app navigation/chrome (`src/opentui/HunkReviewStream.tsx:17-18`); the full shell is composed by `App.tsx`.

## Start Here

Open `src/ui/themes.ts:158-275` first: it is the palette authority. Then read `src/ui/diff/rowStyle.ts:115-185` and `src/ui/diff/CodeCellView.tsx:196-230` to reproduce the exact fg/bg layering.

## Acceptance evidence

- **Review findings:** `[info]` Core Hunk has no persistent completion/progress bar; use the transient scrollbar and changeset totals if another app needs progress. `[info]` Syntax token foregrounds are Shiki-theme dependent; only semantic row/gutter colors are stable across themes.
- **Residual risks:** no terminal screenshot was captured; runtime Shiki package resolution is environment-dependent, so token-level colors should be sampled with the target theme/runtime. Canonical semantic palette values above were obtained from `resolveTheme` and source formulas.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete five-part visual brief with exact default dark/light hex values and citations to rowStyle, CodeCellView, themes, headers/sidebar, chrome, and catalog source paths."
    }
  ],
  "changedFiles": [
    "/home/cyan/.pi/agent/sessions/--home-cyan-dev-github.com-chenxin-yan-pith--/subagent-artifacts/outputs/d6d315d3-bf72-4a70-a04b-7670c96d0a15/hunk-visuals.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "bun -e 'import {resolveTheme} from ./src/ui/themes.ts; dump github-dark-default and github-light-default'",
      "result": "passed",
      "summary": "Resolved canonical semantic palette hex values."
    }
  ],
  "validationOutput": [
    "Source paths and line ranges were checked with nl/grep; output file exists at the authoritative path."
  ],
  "residualRisks": [
    "Token-level Shiki foregrounds vary by selected theme and should be sampled in the target runtime.",
    "No terminal screenshot was captured."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added the requested compact visual-design brief as an artifact; no project source files changed.",
  "reviewFindings": [
    "info: Core shell has no persistent review-completion progress bar; scrollbar and changeset totals are the progress-like chrome.",
    "info: Semantic diff palette is concrete and theme-derived; syntax foreground colors remain Shiki-dependent."
  ],
  "manualNotes": "Reusable HunkDiffStream intentionally omits app shell, keybindings, and scrolling; App.tsx supplies full chrome."
}
```