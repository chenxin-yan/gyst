# OpenCode TUI visual-design brief

Scope: the built-in `opencode` theme (dark/light variants) and the reusable TUI patterns in `packages/tui`.

## 1. Theme palette

Exact source palette is in `packages/tui/src/theme/assets/opencode.json:4-150`; token shape is `packages/tui/src/theme/index.ts:36-65`.

| role | dark | light |
|---|---:|---:|
| base/background | `#0a0a0a` | `#ffffff` |
| panel | `#141414` | `#fafafa` |
| elevated element | `#1e1e1e` | `#f5f5f5` |
| menu | same as elevated (`backgroundMenu` falls back to `backgroundElement`) | same |
| text | `#eeeeee` | `#1a1a1a` |
| muted text | `#808080` | `#8a8a8a` |
| subtle/border-subtle | `#3c3c3c` | `#d4d4d4` |
| border | `#484848` | `#b8b8b8` |
| active border | `#606060` | `#a0a0a0` |
| primary (selection/accent fill) | `#fab283` | `#3b7dd8` |
| secondary | `#5c9cf5` | `#7b5bb6` |
| accent | `#9d7cd8` | `#d68c27` |
| error / warning / success / info | `#e06c75` / `#f5a742` / `#7fd88f` / `#56b6c2` | `#d1383d` / `#d68c27` / `#3d9a57` / `#318795` |

There is no `textSubtle` token: use `borderSubtle` for the dimmest hierarchy (the which-key skin does exactly this at `packages/tui/src/feature-plugins/system/which-key.tsx:101-109`). `selectedListItemText` is omitted by this theme; resolution therefore sets it to `background` (`packages/tui/src/theme/index.ts:274-289`), i.e. selected foreground is dark `#0a0a0a` / light `#ffffff`. `selectedForeground()` also computes black/white contrast for transparent terminal backgrounds (`packages/tui/src/theme/index.ts:95-110`).

Diff palette (`packages/tui/src/theme/assets/opencode.json:104-150`):

- dark: add `#4fd6be`, remove `#c53b53`, context/hunk `#828bb8`, highlight-add `#b8db87`, highlight-remove `#e26a75`, add-bg `#20303b`, remove-bg `#37222c`, context-bg `#141414`, line number `#8f8f8f`, add-line-number-bg `#1b2b34`, remove-line-number-bg `#2d1f26`.
- light: add `#1e725c`, remove `#c53b53`, context/hunk `#7086b5`, highlight-add `#4db380`, highlight-remove `#f52a65`, add-bg `#d5e5d5`, remove-bg `#f7d8db`, context-bg `#fafafa`, line number `#595959`, add-line-number-bg `#c5d5c5`, remove-line-number-bg `#e7c8cb`.

## 2. Chrome: status bars, headers, footers

- **Main/home chrome:** the home content is centered with horizontal padding `2`; logo and prompt are separated by a one-row spacer. Footer is a full-width slot (`packages/tui/src/routes/home.tsx:70-92`). Built-in home footer has one-line content, vertical padding `1`, horizontal padding `2`, and `gap={2}`; it has no background or separator, so whitespace is the separator (`packages/tui/src/feature-plugins/home/footer.tsx:64-79`). Directory/MCP are left, version is right; MCP uses `⊙` and `/status` (`packages/tui/src/feature-plugins/home/footer.tsx:28-52`).
- **Session sidebar:** fixed width `42`, full height, `backgroundPanel`, vertical padding `1`, horizontal padding `2`; content scrolls and footer is separated by `gap={1}` plus top padding `1` (`packages/tui/src/routes/session/sidebar.tsx:28-48,87-99`). Title is bold text; ID, workspace, and URL are muted (`packages/tui/src/routes/session/sidebar.tsx:56-82`).
- **Prompt chrome:** elevated input surface uses `backgroundElement`, left/right padding `2`, top padding `1`; metadata below uses top padding `1`, `gap={1}` (`packages/tui/src/component/prompt/index.tsx:1345-1362,1431-1473`). A one-row lower separator uses a custom `▀` when the element background is opaque, and the active left rail uses `╹` (`packages/tui/src/component/prompt/index.tsx:1476-1501`).
- **Dialogs:** full-screen modal scrim is black with alpha 150; modal is vertically placed at terminal height/4, centered, with widths medium `60`, large `88`, xlarge `116`, panel background, and top padding `1` (`packages/tui/src/ui/dialog.tsx:21-59`). Dialog headers are a bold title on the left and muted `esc` on the right; body is muted; actions sit right-aligned (`packages/tui/src/ui/dialog-confirm.tsx:56-89`, `packages/tui/src/ui/dialog-alert.tsx:29-55`).
- **Keybind hints:** render the key/trigger in normal text and the description in muted text, e.g. `esc interrupt`, `agents`, `commands` (`packages/tui/src/component/prompt/index.tsx:1576-1581,1636-1665`); avoid keyboard-chip borders. The which-key panel is an explicit 30%-height dock/overlay clamped to 8..16 rows, with 1-row top/side padding, 1-row tab/header gap, 1-row footer, and 1-row footer margin (`packages/tui/src/feature-plugins/system/which-key.tsx:37-48,395-409,454-455,512-524`). Its footer places `toggle <key>` left and layout `<key>` right, with the key in subtle color (`packages/tui/src/feature-plugins/system/which-key.tsx:512-524`).

## 3. Selected/focused rows and lists/sidebars

- **General select row:** active row fills with `theme.primary` (transparent otherwise); selected title becomes selected-foreground and bold. If focus is in an action submode, active rows use `backgroundElement` and muted text instead. Current item gets a `●` marker and primary text (`packages/tui/src/ui/dialog-select.tsx:592-621,670-711`). Categories are bold accent text, indented `paddingLeft={3}`, with one blank row between categories; list rows use left `1`/`3` and right `3` padding (`packages/tui/src/ui/dialog-select.tsx:543-559,592-629`).
- **Tabs/options:** focused question tabs fill with `accent` and use contrast foreground; hovered tabs use `backgroundElement`. Question options highlight only the row's number/label cells with `backgroundElement`, use secondary-colored active text, and use `✓` for picked options (`packages/tui/src/routes/session/question.tsx:305-351,364-395`). Permission choices use warning fill plus contrast foreground (`packages/tui/src/routes/session/permission.tsx:678-694`).
- **File tree:** focused row fills `primary` and every glyph/text/status switches to base `background`; selected-but-not-focused file name is primary-colored. Directories/reviewed files are muted (`packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx:69-114`). Tree indentation uses `│  `, `├─ `, `└─ ` and directory expand markers `▸`/`▾` (`packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx:125-148`).
- **Sidebar sections:** section headers are bold normal text with collapsible `▼`/`▶`; modified-file names are muted while additions/removals use diff colors (`packages/tui/src/feature-plugins/sidebar/files.tsx:20-48`). Todo rows use `[✓]`, `[•]`, or `[ ]`; in-progress content/marker is warning, all other content muted (`packages/tui/src/component/todo-item.tsx:8-25`). Workspace status uses `●` colored success/error/muted, with name normal and type muted (`packages/tui/src/component/workspace-label.tsx:7-16`).
- **Which-key selected tab:** selected tab is `primary` background, selected-list-item foreground, and bold; unselected tabs are muted (`packages/tui/src/feature-plugins/system/which-key.tsx:426-445`). Binding descriptions are muted; actual key strings are normal bold; pending continuation labels are accent (`packages/tui/src/feature-plugins/system/which-key.tsx:474-495`).

## 4. Border usage

- The code does **not** select a named `rounded` or `single` style. It mostly composes side arrays (`left`, `right`, `top`, `bottom`), `both`, or `none`; the reusable `Panel` helper defaults to the start side and maps axis/start/end/both to those sides (`packages/tui/src/feature-plugins/system/diff-viewer-ui.tsx:31-58`). `Panel border="none"` is used where whitespace separates diff regions; the file tree alone uses `border="both"` (`packages/tui/src/feature-plugins/system/diff-viewer.tsx:737-785`, `packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx:54-60`).
- Shared chrome intentionally uses a heavy vertical rail rather than a box: `EmptyBorder` blanks all joins and uses a space for horizontals; `SplitBorder` draws only left/right as `┃` (`packages/tui/src/ui/border.ts:1-20`). This is used for prompt rails, toasts, autocomplete and semantic blocks. Toasts are panel background with only left/right variant-colored rails (`packages/tui/src/ui/toast.tsx:23-45`).
- Separators are one-cell lines: vertical `border=["left"]`, horizontal `border=["top"]`; optional junction glyphs are `├`, `┤`, `┬`, `┴` (`packages/tui/src/feature-plugins/system/diff-viewer-ui.tsx:60-102`). Semantic message/permission/error blocks use only a colored left rail, not a surrounding box (`packages/tui/src/routes/session/permission.tsx:475-490`, `packages/tui/src/routes/session/permission.tsx:633-665`).
- Prefer background layers plus whitespace for ordinary regions: sidebar/home footer and dialogs have no border; reserve rails for focus/status/error and full borders for a contained file-tree panel.

## 5. Spacing and typography conventions

- Spacing is integer terminal cells, overwhelmingly `1` for local rhythm/gap, `2` for outer horizontal breathing room, `3` for indented detail/action content, and `4` for select-dialog title/list outer margins (`packages/tui/src/ui/dialog-select.tsx:485-499,530-547,592-629,642-650`).
- Hierarchy is color plus weight rather than font sizes: titles, section/category labels, and selected actions are bold; descriptions, IDs, paths, metadata, disabled options and inactive hints are muted. Examples: sidebar title (`packages/tui/src/routes/session/sidebar.tsx:56-82`), dialog category/active title (`packages/tui/src/ui/dialog-select.tsx:547-553,691-706`), and which-key bindings (`packages/tui/src/feature-plugins/system/which-key.tsx:474-495`).
- Use `·` between metadata fields and plain-text key/description pairs; the visual language favors Unicode markers (`●`, `•`, `✓`, `△`, `⊙`, `▼/▶`) over icon boxes (`packages/tui/src/component/prompt/index.tsx:1441-1460,1646-1665`; `packages/tui/src/feature-plugins/sidebar/footer.tsx:44-63`).

### Files retrieved
1. `packages/tui/src/theme/assets/opencode.json:4-150` — built-in exact palette and diff colors.
2. `packages/tui/src/theme/index.ts:36-110,266-292` — theme tokens, selection contrast and fallbacks.
3. `packages/tui/src/ui/border.ts:1-20` — reusable rail/empty border characters.
4. `packages/tui/src/routes/home.tsx:70-92`, `packages/tui/src/feature-plugins/home/footer.tsx:64-79` — home/footer chrome.
5. `packages/tui/src/routes/session/sidebar.tsx:28-99` — sidebar dimensions and hierarchy.
6. `packages/tui/src/component/prompt/index.tsx:1345-1501,1576-1665` — prompt rails, spacing and key hints.
7. `packages/tui/src/ui/dialog.tsx:21-59`, `packages/tui/src/ui/dialog-select.tsx:485-715` — modal/select treatment.
8. `packages/tui/src/feature-plugins/system/which-key.tsx:37-48,395-524` — explicit keybind panel geometry and styling.
9. `packages/tui/src/feature-plugins/system/diff-viewer-ui.tsx:31-102`, `packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx:54-148` — borders and focused tree.
10. `packages/tui/src/feature-plugins/sidebar/files.tsx:20-48`, `packages/tui/src/component/todo-item.tsx:8-25`, `packages/tui/src/component/workspace-label.tsx:7-16` — sidebar list markers.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete five-part visual brief with exact dark/light hex values, geometry, row/list treatments, border character techniques, spacing hierarchy, and source file/line citations."
    }
  ],
  "changedFiles": [
    "/home/cyan/.pi/agent/sessions/--home-cyan-dev-github.com-chenxin-yan-pith--/subagent-artifacts/outputs/d6d315d3-bf72-4a70-a04b-7670c96d0a15/opencode-visuals.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "nl -ba /home/cyan/dev/github.com/anomalyco/opencode/packages/tui/src/theme/assets/opencode.json | sed -n '1,230p'",
      "result": "passed",
      "summary": "Verified exact built-in palette and diff hex values."
    },
    {
      "command": "nl -ba /home/cyan/dev/github.com/anomalyco/opencode/packages/tui/src/ui/dialog-select.tsx | sed -n '460,715p'",
      "result": "passed",
      "summary": "Verified active-row, current-marker, category, indentation and footer styling."
    },
    {
      "command": "nl -ba /home/cyan/dev/github.com/anomalyco/opencode/packages/tui/src/feature-plugins/system/which-key.tsx | sed -n '30,70p;170,190p;395,525p'",
      "result": "passed",
      "summary": "Verified keybind panel dimensions, tab treatment and hints."
    }
  ],
  "validationOutput": [
    "Source-only inspection; no application code changed and no tests were needed."
  ],
  "residualRisks": [
    "Other selectable themes and the runtime-generated system theme intentionally vary these colors; the hex table is specifically the built-in opencode theme.",
    "OpenTUI's default border glyph behavior is external to this package; only explicitly customized glyphs are asserted here."
  ],
  "noStagedFiles": true,
  "diffSummary": "Wrote the requested compact OpenCode TUI visual-design brief artifact.",
  "reviewFindings": [
    "none — findings are source-cited and cover all five requested design areas."
  ],
  "manualNotes": "Use backgroundElement as elevated/menu surface and borderSubtle as the subtle text-like color; selected foreground falls back to background in the built-in theme."
}
```