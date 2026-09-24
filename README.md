# gyst

Review code changes with your coding agent, in your terminal.

Your agent plans a top-to-bottom walkthrough of all changes, then publishes
self-contained groups with short titles and concise notes attached to hunks. Each group contains one or more hunks, all shown for review. You decide
what to accept. Accepting marks a group reviewed—it does not stage, commit, or
modify your code.

## Install

```sh
npm install -g @gyst/cli
```

## Quick start

1. Install the skills for your coding agent:

   ```sh
   gyst skills
   ```

2. Open your agent in the repository you want to review and ask:

   ```text
   /gyst uncommitted changes
   ```

   You can also specify a range (`/gyst main...HEAD`) or a PR (`/gyst PR 42`).
   The agent plans coverage and order first, then publishes complete groups
   progressively. Start reviewing at the top while later groups are prepared;
   remaining hunks stay visible in the inbox.

3. Open another terminal in the same repository:

   ```sh
   gyst
   ```

Use `/gyst-ask <question>` in your agent's chat to ask about the current group.

## Review keys

Gyst opens with a compact item sidebar and the selected diff preview, including on
narrow terminals. `Enter` hides the sidebar to read; `Esc` restores it and `s` toggles
it. Optional Agent notes appear above their hunks only with the sidebar hidden.
Each is one or two concise plain-text sentences, at most 400 Unicode code points.
An item can have no notes. Notes explain; the whole group receives the verdict.

Sidebar toggles retain the focused member and a stable reading position. While
reading, the hunk at the top of the diff is the shared focus that `/gyst-ask` and the
editor use. Passive browse previews do not change that focus.

| Key                                  | Sidebar visible                                  | Sidebar hidden (reading)                              |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| `j` / `k`                            | Select next / previous item                      | Scroll one line                                       |
| `Enter`                              | Hide sidebar                                     | No-op                                                 |
| `Esc`                                | No-op                                            | Show sidebar                                          |
| `s`                                  | Hide sidebar                                     | Show sidebar                                          |
| `[` / `]`                            | No-op                                            | Previous / next member hunk                           |
| `p` / `n`                            | Previous / next item without a verdict           | Same, opening its first hunk                          |
| `Ctrl+D` / `Ctrl+U`, `PgDn` / `PgUp` | No-op                                            | Scroll half a page                                    |
| `a`                                  | Mark the group done and advance; again to unmark | Same, covering all group members                      |
| `u`                                  | Undo the last verdict and return to its group    | Same, staying in reading mode                         |
| `o`                                  | No-op                                            | Open the focused hunk's working-tree file in `EDITOR` |
| `1` / `2` / `0`                      | Split / stacked / automatic diff layout          | Same                                                  |
| `r`                                  | Refresh the Git snapshot                         | Same                                                  |
| `?`                                  | Show all keys; Esc dismisses help first          | Same                                                  |

## Sessions

Snapshots stay fixed when files change. Gyst warns when the recorded Git scope
changes; press `r` to refresh explicitly. `gyst session check` reports `unchanged`,
`changed`, `unavailable`, or `stdin` without modifying review progress. Checks are
periodic and cached, not a real-time guarantee. Stdin snapshots have no source to
check; replace them explicitly with `gyst session refresh --stdin`.

Use `/gyst-refresh` in your agent's chat to refresh the existing review and revise
its affected groups and explanations while preserving unrelated review progress.
If you already pressed `r`, ask it to regroup the current snapshot instead.
Refresh retains notes and verdicts only for wholly surviving groups; losing any
member clears that group's notes and verdict without changing unrelated groups.

Installing a new CLI does not itself restart the background daemon. On the next
command, gyst checks compatibility before sending review operations. It automatically
restarts an older daemon that supports the handshake only when all saved sessions
are readable by the new version and no command is in flight. Saved review state
is preserved; older clients cannot downgrade a newer daemon.

Incompatible saved sessions or a legacy daemon without a handshake block automatic
recovery with an explicit error. Keep using the old version, or inspect your saved
reviews before manually restarting and recreating incompatible sessions. Gyst never
kills an unverified PID, migrates a session, or deletes its file during recovery.

Run `gyst` again to resume. There is one session per repository. When you are done,
close it before starting a review with a different scope:

```sh
gyst session close
```

For CLI options, run `gyst --help` or `gyst session --help`.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
