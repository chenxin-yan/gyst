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
sidebar (`tab`) that tracks all groups/spotlight hunks with verdict marks
(`✓` done, `▸` current, `·` pending) and a header progress bar.

**Verdict model** (deliberately minimal):

- `a` **accept** is the only verdict: "done reviewing this part". Auto-advances
  to the next pending item; `u` undoes.
- `e` **expand** is a view toggle on groups (peek at all members inline), an
  action, not a verdict.
- **No flag, no prompt box.** All conversation happens in the harness window;
  the agent reads the human's cursor + verdict state via the control plane
  (`pith session status`).

Full grammar: `j/k` move · `a` accept→next · `e` expand · `u` undo ·
`tab` sidebar · `q` quit.

## Solid spike notes

- `@opentui/solid` 0.5.9 works: render/useKeyboard/scrollbox/flex/testRender all fine under Bun with the `@opentui/solid/preload` bunfig entry.
- Wart: `SpanProps` omits `fg`/`bg` at the type level though runtime applies them (`Sp` cast wrapper in `src/main.tsx`). Dynamic string tags need `Dynamic`, plain variables crash the universal renderer.
- `@opentui/core` ships lib type errors — `skipLibCheck` required.
- `testRender` + `mockInput.pressKey` + `captureCharFrame` give free headless interaction tests (`src/smoke.tsx`); named keys use `KeyCodes` names (`"TAB"`).
