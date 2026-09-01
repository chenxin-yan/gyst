# Code Context

## Files Retrieved
1. `/tmp/gyst-src/hunk/src/ui/lib/responsive.ts` (lines 6-55) - effective auto/explicit layout policy and width thresholds.
2. `/tmp/gyst-src/hunk/src/ui/App.tsx` (lines 213-218, 418-423, 646-724, 813-817) - requested-mode state, terminal-vs-pane width inputs, viewport width, and mode-change scroll capture.
3. `/tmp/gyst-src/hunk/src/core/run/commandCatalog.ts` (lines 315-341) - default layout keybindings.
4. `/tmp/gyst-src/hunk/src/ui/diff/diffRows.ts` (lines 317-369, 767-885, 888-985) - split/stack row construction, hunk block pairing, and padding.
5. `/tmp/gyst-src/hunk/src/ui/diff/codeColumns.ts` (lines 8-11, 113-171) - split pane widths, separator/rail constants, gutters, and code viewports.
6. `/tmp/gyst-src/hunk/src/ui/diff/rowStyle.ts` (lines 116-185, 426-459) - cell palettes and exact gutter strings.
7. `/tmp/gyst-src/hunk/src/ui/diff/CodeCellView.tsx` (lines 151-266, 505-570, 1006-1078, 1093-1155, 1163-1262) - OpenTUI direct styled-text composition and wrap/nowrap behavior.
8. `/tmp/gyst-src/hunk/src/ui/diff/styledSpanLayout.ts` (lines 56-122, 153-229) - terminal-cell slicing and wrapping.
9. `/tmp/gyst-src/hunk/src/ui/lib/lineCursors.ts` (lines 50-107, 157-182, 224-243) - cursor semantics for context/change rows.
10. `/tmp/gyst-src/hunk/src/ui/components/panes/DiffPane.tsx` (lines 1191-1309, 2130-2275, 2719-2722) - measured cursor list, mode-aware cursor paint, scroll-anchor restoration, and content remount.
11. `/tmp/gyst-src/hunk/src/opentui/HunkDiffBody.tsx` (lines 19-47) and `/tmp/gyst-src/hunk/src/opentui/types.ts` (lines 4, 40-68) - reusable OpenTUI primitive accepts only resolved split/stack; app resolves auto before it.
12. `/tmp/gyst-src/hunk/src/ui/themes.ts` (lines 181-259) - semantic color derivation; evaluated default themes with the source's `resolveTheme`.

## Key Code

### 1. Mode selection / auto
- `App` keeps requested `layoutMode` (`"auto" | "split" | "stack"`) and calls `resolveResponsiveLayout(layoutMode, terminal.width)` (`App.tsx:213-218,418-421`). **Auto uses whole terminal width, not diff-pane width, line lengths, or content.** The actual diff pane width is separately computed as `diffPaneWidth - 2` (`App.tsx:646`), then passed to geometry (`App.tsx:718-724).
- `AUTO_SPLIT_MIN_WIDTH = 120`; auto is `split` when `terminal.width >= 120`, otherwise `stack` (`responsive.ts:6,30-55`). Boundaries are inclusive: 119 -> stack, 120 -> split.
- The same function also buckets viewport/sidebar state only: `tight < 160`, `medium >= 160`, `full >= 220` (`responsive.ts:6,16-26`). `showSidebar` is false only in tight. These buckets do **not** change auto's layout after the independent 120 cutoff: 120-159 is split/no sidebar; 160+ is split/sidebar. Explicit split and stack are never overridden by width; explicit split can remain extremely narrow (`responsive.ts:36-52`).
- There is no single cycle key in this source. Layouts are direct commands: `1` = split, `2` = stack, `0` = auto (`commandCatalog.ts:315-341`), dispatched as `selectLayoutMode("split"|"stack"|"auto")` (`App.tsx:1043-1049`; command handlers in `ui/lib/appCommands.ts:227-229`). Menus expose the same three choices. Do not implement a presumed cycle unless the prototype deliberately adds one.

### 2. Split row building
- Pierre groups each hunk into `context` and contiguous change blocks. Context lines produce one split row per line, consuming one old and one new line index/number in lockstep (`diffRows.ts:797-834`).
- For each non-context block, the builder does **positional pairing**: `pairedLines = max(content.deletions, content.additions)`, and row `i` gets deletion `i` on the left and addition `i` on the right (`diffRows.ts:834-875`). Thus a block of removals is aligned with the following block of additions, rather than globally matching text or interleaving by input order. It advances each side by its own count after the block (`diffRows.ts:876-885`). Example: `--- a,b,c` then `+++ x,y` => `(a,x),(b,y),(c,empty)`.
- A missing side is an `empty` cell: `sign: " "`, no line number, and `spans: []` (`diffRows.ts:317-334`). Its split palette uses `lineNumberBg` for the gutter and `panelAlt` for content, with `lineNumberFg` number color and `muted` sign color (`rowStyle.ts:116-156`). OpenTUI then fills the content viewport with spaces in that `panelAlt` background; no placeholder text or `+/-` is emitted (`CodeCellView.tsx:207-230`). The one-column prefix/rail still paints normally.

### 3. Stack / combined-unified row building
- Context is one `stack-line` carrying both old and new numbers and the new-side text/highlighting (`diffRows.ts:918-945`). For each change block, **all deletions are emitted first, then all additions** (`diffRows.ts:946-985`); no pairing rows are retained.
- With line numbers, `stackGutterText` is exactly `${oldNumber} ${newNumber} ${sign}` (`rowStyle.ts:426-444`): each number is right-aligned to `lineNumberDigits`; absent old/new number is `lineNumberDigits` spaces; sign is final `-`, `+`, or ` ` (`rowStyle.ts:427-443`). Rendering pads this string to `gutterWidth` (`CodeCellView.tsx:243-258`). The geometry reserves `2*lineNumberDigits + 5` columns, so the nominal string (`2*d + 3`) has two trailing padding columns. With line numbers hidden, gutter text is `${sign} ` and gutter width is 2 (`rowStyle.ts:437-439`; `codeColumns.ts:141-151`).
- Default `github-dark-default` semantic values (the source derives these dynamically, so custom themes can differ): additions sign `#2ea043`, row/content backgrounds `#12251d`/`#163923`; deletions sign `#f85149`, row/content backgrounds `#3c1e21`/`#4f2325`; context `#0d1117`. Light default: `+ #116329`, `addedBg #e2ece5`, `- #cf222e`, `removedBg #f9e4e6`, context `#ffffff`. The palette mapping/formulas are `themes.ts:181-259` and `rowStyle.ts:157-185`.

### 4. Split layout mechanics / OpenTUI geometry
- Constants are one terminal-cell rail prefix and one split separator (`DIFF_RAIL_PREFIX_WIDTH = 1`, `DIFF_SPLIT_SEPARATOR_WIDTH = 1`; `codeColumns.ts:8-11`). For input width `W`, `usable = max(0,W-2)`, `left = 1 + floor(usable/2)`, `right = 1 + (usable-floor(usable/2))` (`codeColumns.ts:113-122`). Total is exactly `W`; odd extra goes to the right. At width 80 this is 40/40; at width 81 it is 40/41.
- This is not two flex boxes with a CSS border. `CodeCellView` concatenates left chunks then right chunks in one OpenTUI `<text>`/`StyledText` (`CodeCellView.tsx:1006-1080`). Left prefix is one colored `▌` rail; right prefix is one colored `▌` that is the center separator (`CodeRowView.tsx:179-198`, `CodeCellView.tsx:1027-1075`). Each cell's own width includes its one prefix. A note-guide/add-note reservation can reduce only the right/outer available width in the full app (`codeRowLayout.ts:105-120`); a small prototype without notes can ignore it.
- Per split cell, `prefixWidth = 1`; with line numbers, `gutterWidth = min(available, lineNumberDigits + 3)`; without them it is 2. `contentWidth = max(0, cellWidth-prefixWidth-gutterWidth)` (`codeColumns.ts:125-138`). Stack uses `gutterWidth = min(available, 2*lineNumberDigits + 5)` (`codeColumns.ts:141-151`). All geometry clamps at zero; there is no hard per-cell minimum. The app's review pane policy has `DIFF_MIN_WIDTH = 48` and body padding 2 (`App.tsx:165-167,418-423`), but explicit split remains possible below its ideal width.
- **No-wrap (default):** each cell independently takes a terminal-cell window using `sliceSpansWindow(spans, horizontalOffset, contentWidth)` and pads the remainder with spaces (`CodeCellView.tsx:151-191,207-230`; `styledSpanLayout.ts:56-122`). Long content is clipped/truncated at the viewport edge with **no ellipsis**. Horizontal offset shifts code only; rails and gutters stay fixed.
- **Wrap:** each cell independently uses `wrapSpans(cell.spans, cell.contentWidth)` (`CodeCellView.tsx:533-536,558-561`; `styledSpanLayout.ts:153-229`). Split row height is `max(left wrapped line count, right wrapped line count)`; absent continuation side gets blank gutter/content lines (`CodeCellView.tsx:1163-1262`). First visual line has its number/sign gutter; continuation gutters are spaces (`CodeCellView.tsx:532-546`). Wrapping uses terminal display width/grapheme-safe slicing, not JS string length.

### 5. Subtleties / reimplementation traps
- Auto's width is terminal width, while split sizing is actual diff pane content width. Do not feed the pane width into the 120 heuristic unless intentionally changing behavior (`App.tsx:420` vs `App.tsx:646,718-724`).
- The reusable OpenTUI body itself defaults to split and branches only on `layout === "split"`; it has no auto branch (`HunkDiffBody.tsx:19-47`, `types.ts:4,40-68`). Resolve auto in the host first.
- Layout changes preserve the review position rather than blindly keeping a raw pixel offset. `selectLayoutMode` captures current `scrollTop` and increments a request id (`App.tsx:813-817`). `DiffPane` detects layout changes, finds a stable top-row anchor, scrolls to its new measured location, suppresses viewport-selection feedback, and retries at 0/16/48 ms (`DiffPane.tsx:2130-2275`). Diff content is remounted on layout/wrap/width changes so OpenTUI culling recomputes (`DiffPane.tsx:2719-2722`). A small prototype should at least retain the top visible row key when switching mode.
- Cursor stops come from measured rendered rows, not raw sign arrays (`lineCursors.ts:93-107`). A context row has one cursor even though it renders on both sides; changed split rows can have one cursor for each side (`lineCursors.ts:50-91`). A context cursor's new-side target also addresses its corresponding old-side number (`lineCursors.ts:224-243`). Cursor stepping is ordered by the current measured stream, and if line markers are off, the same keybinding scrolls by one step instead (`App.tsx:770-776`; `lineCursors.ts:157-182`). Cursor highlighting is side-specific for changed split rows but context highlights both halves (`DiffPane.tsx:1298-1309`, `CodeRowView.tsx:105-145`).

## Architecture
`App` stores requested mode -> `resolveResponsiveLayout` yields concrete split/stack from terminal width -> `DiffPane` receives concrete layout and pane content width -> each section builds `buildSplitRows` or `buildStackRows` -> `planCodeRowLayout` computes fixed terminal columns -> `CodeCellView` emits one OpenTUI styled text stream with per-cell backgrounds, gutters, clipping, or wrapping. Cursor and scroll geometry are based on this same measured render plan, so a mode switch changes row heights/keys but should preserve stable row identity.

## Start Here
Open `/tmp/gyst-src/hunk/src/ui/diff/diffRows.ts:767-985` first: it contains the exact semantic difference between split positional pairing and stack deletion-then-addition ordering. Then use `codeColumns.ts:113-171` and `rowStyle.ts:426-459` to reproduce geometry and gutters.

## Suggested minimal pairing algorithm
```text
splitRows(lines):
  rows = []
  i = 0
  while i < lines.length:
    if lines[i].sign == " ":
      rows.push({ left: lines[i], right: lines[i] })
      i += 1
      continue

    removed = []; added = []
    while i < lines.length and lines[i].sign != " ":
      if lines[i].sign == "-": removed.push(lines[i])
      else if lines[i].sign == "+": added.push(lines[i])
      i += 1
    for j in 0 .. max(removed.length, added.length)-1:
      rows.push({
        left: removed[j] ?? { sign: " ", text: "", kind: "empty" },
        right: added[j] ?? { sign: " ", text: "", kind: "empty" },
      })
  return rows

stackRows(lines):
  // Preserve each context line once; for each contiguous +/- block emit all '-' then all '+'.
```
For the requested `{sign,text}[]`, use `text: ""` only as the internal empty-cell sentinel and paint it with `panelAlt`; do not display that empty string as a placeholder.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete mode, pairing, stack gutter, OpenTUI geometry, color, and scroll/cursor findings are documented with /tmp/gyst-src/hunk file:line citations."
    }
  ],
  "changedFiles": [
    "/home/cyan/.pi/agent/sessions/--home-cyan-dev-github.com-chenxin-yan-gyst--/subagent-artifacts/outputs/c776a59c-50b5-484d-90ea-9f61ffceef58/context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "bun -e 'resolveTheme github-dark-default/github-light-default'",
      "result": "passed",
      "summary": "Confirmed concrete default semantic colors quoted above."
    }
  ],
  "validationOutput": [
    "Inspected implementation and tests; no source files were modified."
  ],
  "residualRisks": [
    "Theme colors are derived per Shiki/custom theme; quoted hex values are only the two built-in defaults.",
    "The minimal prototype model lacks hunk metadata, so context/change-block boundaries must be inferred from sign runs.",
    "A prototype that omits stable-row scroll restoration will jump on mode changes."
  ],
  "noStagedFiles": true,
  "diffSummary": "Wrote the requested compact implementation brief; no project source changes.",
  "reviewFindings": [
    "info: /tmp/gyst-src/hunk/src/core/run/commandCatalog.ts:315-341 - there is no built-in cycle key; 1/2/0 directly select split/stack/auto.",
    "none: no correctness blocker found in the reviewed layout implementation."
  ],
  "manualNotes": "Auto uses terminal.width (120 cutoff), not the diff pane width; resolved OpenTUI body layout is only split or stack."
}
```