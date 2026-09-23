# @gyst/cli

## 0.1.0

### Minor Changes

- [#55](https://github.com/chenxin-yan/gyst/pull/55) [`7b14494`](https://github.com/chenxin-yan/gyst/commit/7b144948ab2276796598256f3b5cd59f8ae0e824) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Upgrade Crust to 0.4.0 (`@crustjs/core`, `@crustjs/extensions`, `@crustjs/skills`, `@crustjs/crust`) and `@crustjs/effect` to 0.1.2. Breaking: `gyst skills update` is replaced by `gyst skills repair`. `gyst skills install` (same as the root `gyst skills`) and `gyst skills uninstall` are new.

- [#54](https://github.com/chenxin-yan/gyst/pull/54) [`3126712`](https://github.com/chenxin-yan/gyst/commit/31267121e33a320255abd838b4064047a1ed28d3) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Add the `/gyst-refresh` skill to update an existing walkthrough after code edits or an explicit TUI refresh, revising affected groups and explanations while preserving unrelated human review progress.

  Make the shared `gyst` authoring rules agent-accessible and streamline the walkthrough skills with name-only cross-skill references.

- [#53](https://github.com/chenxin-yan/gyst/pull/53) [`b0a56b7`](https://github.com/chenxin-yan/gyst/commit/b0a56b7b533109c3aa168760b88342d67f0bc3e8) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Use groups of one or more hunks as the only reviewable walkthrough steps. Plan the whole diff before publishing complete groups in order, with self-contained explanations and source-located context.

  Add informational Git-source checks in the TUI and `gyst session check`. Checks respect the recorded scope, preserve the frozen snapshot and review progress, and never refresh automatically. Stdin and unavailable sources are reported explicitly.

- [#51](https://github.com/chenxin-yan/gyst/pull/51) [`66e164d`](https://github.com/chenxin-yan/gyst/commit/66e164d474c4530514aebcf0daac0b802da37dee) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Open the selected working-tree file with EDITOR from zoom, with validated repository containment, direct executable arguments and a supervised terminal handoff. Returning never refreshes the reviewed snapshot automatically.

- [#49](https://github.com/chenxin-yan/gyst/pull/49) [`39cdab5`](https://github.com/chenxin-yan/gyst/commit/39cdab57b44386561d12e1dcb74e2da2959b2507) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Publish coherent review items progressively with titles and Markdown overviews, show every group member, and invalidate verdicts when any member changes.

- [#50](https://github.com/chenxin-yan/gyst/pull/50) [`5049dd2`](https://github.com/chenxin-yan/gyst/commit/5049dd24d6162baff826711a882568ac7548ad3a) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Add shared diff/overview focus, responsive zoom with native Markdown, and atomic accept/undo navigation. Preserve pane scrolling during progressive publication and keep the current view when prepared work is reviewed. Remove the obsolete expansion and sidebar controls.

### Patch Changes

- [#46](https://github.com/chenxin-yan/gyst/pull/46) [`cfaa9fc`](https://github.com/chenxin-yan/gyst/commit/cfaa9fce5524ceae9c169eb004c32b1a4bff6ab5) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Press Enter to step into the current item and j / k to move between a group's hunks; Esc returns to the list. The focused hunk is shared with the agent as `cursor.hunkId` in `gyst session status`.

- [#45](https://github.com/chenxin-yan/gyst/pull/45) [`fac26d6`](https://github.com/chenxin-yan/gyst/commit/fac26d6387412f92374060dc8ea2d7fafd611d5a) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Highlight diffs with tree-sitter. JavaScript, TypeScript, Markdown and Zig work offline; other languages download their grammar on first use.

- [#44](https://github.com/chenxin-yan/gyst/pull/44) [`4166e99`](https://github.com/chenxin-yan/gyst/commit/4166e99f0bd6d5833f5701a26aca0e8e3b7b3c02) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Scroll the current item with Ctrl+D / Ctrl+U instead of J / K.

## 0.0.1

### Patch Changes

- [#32](https://github.com/chenxin-yan/gyst/pull/32) [`0950694`](https://github.com/chenxin-yan/gyst/commit/09506948743923cfe7a6ea8814d74ff66fc6600e) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Initial release: the `gyst` daemon, `gyst session` commands, the co-review TUI, and the `/gyst` and `/gyst-ask` skills.
