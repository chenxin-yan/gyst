# @gyst/cli

## 0.2.0

### Minor Changes

- [#101](https://github.com/chenxin-yan/gyst/pull/101) [`3d14945`](https://github.com/chenxin-yan/gyst/commit/3d14945f0ea9b4239b9fc2ed7d65a499196d0106) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Add a browser viewer for saved sessions. `gyst`, `gyst <range>` and `gyst --session <id>` open (or create) the session, serve a private viewer on a new `*.localhost` host name bound to `127.0.0.1`, and open it in your browser or print a private link; stop it with Ctrl-C. The link's secret expires 10 minutes after launch, after which that browser stays signed in until the viewer stops. The viewer lists saved sessions, shows each one's captured diff and deletes a session after confirmation. Over SSH, forward a local port to the printed port and open the link with your local port.

- [#102](https://github.com/chenxin-yan/gyst/pull/102) [`ec0c900`](https://github.com/chenxin-yan/gyst/commit/ec0c900013239f9059dcfe8b2aadb9b5f54a0c56) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Read a session's captured snapshot without its checkout. `gyst session files` lists the current snapshot's files, including unchanged ones, with each side's availability, and `gyst session code` returns one side's exact captured text a page (up to 64 KiB) at a time by line or continuation offset; both name `--session` and `--snapshot`, and an older snapshot fails with `stale_revision`. `session diff` now includes its `snapshotId`. The browser viewer lists captured files and shows their code or why a side was not captured. On a terminal, capture shows its progress on stderr.

- [#100](https://github.com/chenxin-yan/gyst/pull/100) [`8f0f096`](https://github.com/chenxin-yan/gyst/commit/8f0f09611162ef3d0fc93256b3a5d2f97653218f) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Run the CLI and background daemon on Node.js 24 or later instead of Bun; install with `npm install -g @gyst/cli`. Remove the terminal review viewer. The CLI now sends validated structured operations to the daemon. Hunk identities are computed differently than in earlier versions and saved sessions are not migrated, so close existing sessions and create them again after upgrading.

- [#101](https://github.com/chenxin-yan/gyst/pull/101) [`3d14945`](https://github.com/chenxin-yan/gyst/commit/3d14945f0ea9b4239b9fc2ed7d65a499196d0106) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Replace `gyst session create` and `close` with `gyst session open [<range>]`, `list` and `delete`. A session is identified by its repository and recorded scope (uncommitted changes or a Git range as written): reopening returns the saved session without refreshing it, even after refs move, and different scopes coexist. `open` prints the session and snapshot identity as JSON without launching a viewer. Every other session command requires `--session <id>`; the current directory no longer selects a session. `delete --session <id> --request-id <id>` is retry-safe across daemon restarts. Stdin patches and pathspec scopes are removed, and sessions saved by earlier versions are not migrated.

### Patch Changes

- [#112](https://github.com/chenxin-yan/gyst/pull/112) [`fb5dcab`](https://github.com/chenxin-yan/gyst/commit/fb5dcab2433583753661979a5b94ac0cba1a7e9a) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Update Crust to 0.5.3. Running gyst from a source checkout no longer repoints the installed CLI's agent skill links to that checkout; the installed CLI still repairs stale or dangling links before commands.

## 0.1.2

### Patch Changes

- [#58](https://github.com/chenxin-yan/gyst/pull/58) [`b77edbe`](https://github.com/chenxin-yan/gyst/commit/b77edbe3e96af909367e3b2f3242b71981aaa0df) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Check the running daemon's version and instance before sending review commands. Automatically restart an older cooperative daemon only after validating saved sessions and confirming that no request or saved-state change raced the restart. Preserve review files unchanged, refuse downgrades, and report legacy daemons or incompatible saved sessions without automatically restarting them. Never replay a mutation after losing its reply.

## 0.1.1

### Patch Changes

- [#56](https://github.com/chenxin-yan/gyst/pull/56) [`7239806`](https://github.com/chenxin-yan/gyst/commit/72398063d9f7d76cc41dea8dcae48a6aabcdf212) Thanks [@chenxin-yan](https://github.com/chenxin-yan)! - Show a compact item sidebar beside the selected diff. Enter hides the sidebar, Esc restores it, and s toggles the same two-state view. Optional plain-text Agent notes appear above their owning hunks only while reading. Preserve member focus and reading position across sidebar reflow; remove the separate overview pane, Tab switching and z expansion.

  Replace group overviews with notes throughout authoring, status, persistence and exact historical receipts. Notes have unique own-group hunk anchors and a 400-Unicode-code-point limit; empty arrays are valid. Partial refresh invalidation clears the affected group's notes and verdict while unrelated work survives. Existing saved sessions require recreation; files are left untouched rather than migrated. Use the updated CLI/TUI and daemon together.

  Retain atomic progressive publication, group-only done-reviewing verdicts, frozen snapshots, guarded scroll-derived focus and synchronized editor handoff. Update gyst, gyst-refresh and gyst-ask authoring and focus guidance.

  Update runtime dependencies and development tooling, including @pierre/diffs 1.4.3 and Effect 4 RC117. Git-quoted filename decoding still awaits an upstream release.

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
