# PROTOTYPE — pith TUI, winning hybrid layout

Throwaway. Answers ticket #12: **layout + interaction model for a folded session.**
Doubles as the OpenTUI+Solid spike.

## Run

```sh
cd prototype/tui
bun install
bun start        # needs a real terminal
bun run smoke    # headless frame assertions
```

## The decided model

**Layout**: triage queue — one item fullscreen at a time — plus a collapsible
sidebar (`s`) that tracks all groups/spotlight hunks with verdict marks
(`✓` done, `▸` current, `·` pending) and a header progress bar.

**Verdict model** (deliberately minimal):

- `a` **accept** is the only verdict: "done reviewing this part". It toggles
  in place — no auto-advance; `u` jumps back to and unmarks the last accept.
- `e` **expand** is a view toggle on groups (peek at all members inline), an
  action, not a verdict.
- **No flag, no prompt box.** All conversation happens in the harness window;
  the agent reads the human's cursor + verdict state via the control plane
  (`pith session status`).

Full grammar: `j/k` move · `a` accept toggle · `e` expand · `u` undo ·
`s` sidebar · `1` split / `2` stack / `0` auto layout · `?` help overlay · `q` quit.

Chrome is minimal: one status row (layout · item · progress · `? help`), no
footer — the keymap lives in a centered `?` overlay (panel fill, key column
accent, closed by `?`/esc/q).

**Layout modes** (hunk semantics, see `research/` brief): `auto` resolves from
terminal width (≥120 → split, else stack). Split uses positional block pairing
(deletion *i* pairs with addition *i*; odd side gets a panelAlt empty cell);
stack emits all deletions then all additions per block with a dual
`<old> <new> <sign>` gutter.

**Agent notes**: accent-railed panel blocks — the group's pattern rationale and
a per-spotlight `tldr` summarizing what the change does.

## Visual system

Stolen deliberately, from source-mined briefs of hunk and opencode:

- **hunk (github-dark)**: diff row bg tints (`#12251d` add / `#3c1e21` del), tinted
  line-number gutters, sign-colored `+`/`-`, panel layering (`#0d1117` base,
  `#1e2329` panel, `#272b31` elevated), file-header band with right-aligned
  `+N -N` badges, accent strip `▌` on the current sidebar row.
- **opencode**: peach accent `#fab283`, key-normal/description-muted hint pairs,
  `·` metadata separators, unicode markers over icon boxes, whitespace over borders.

## Solid spike notes

- `@opentui/solid` 0.5.9 works: render/useKeyboard/scrollbox/flex/testRender all fine under Bun with the `@opentui/solid/preload` bunfig entry.
- Wart: `SpanProps` omits `fg`/`bg` at the type level though runtime applies them (`Sp` cast wrapper in `src/main.tsx`). Dynamic string tags need `Dynamic`, plain variables crash the universal renderer.
- `@opentui/core` ships lib type errors — `skipLibCheck` required.
- `testRender` + `mockInput.pressKey` + `captureCharFrame` give free headless interaction tests (`src/smoke.tsx`); named keys use `KeyCodes` names (`"TAB"`).
