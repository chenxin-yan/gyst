# gyst

Review code changes with your coding agent, in your terminal.

Your agent plans a top-to-bottom walkthrough of all changes, then publishes
self-contained groups with short titles, explanations and relevant source
excerpts. Each group contains one or more hunks, all shown for review. You decide
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

Gyst opens on the group list (scope in the header) with the selected group's overview
beside it on wide terminals. `Enter` replaces the list with the group's diff; narrow terminals show one
pane at a time. While reading, the hunk at the top of the diff is the shared focus that
`/gyst-ask` and the editor use.

| Key                                  | Group list                                       | Reading (diff / overview)                                                     |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `j` / `k`                            | Select next / previous group                     | Scroll one line                                                               |
| `Enter`                              | Open the group's diff                            | No-op                                                                         |
| `Esc`                                | No-op                                            | Restore an expanded pane, otherwise return to the list                        |
| `[` / `]`                            | No-op                                            | Previous / next hunk in the group                                             |
| `p` / `n`                            | Previous / next group without a verdict          | Same, opening its first hunk                                                  |
| `Tab` / `Shift+Tab`                  | No-op                                            | Switch diff / overview, restoring an expanded pane                            |
| `z`                                  | No-op                                            | Expand the focused pane to full width / restore, keeping its reading position |
| `Ctrl+D` / `Ctrl+U`, `PgDn` / `PgUp` | Scroll the overview half a page                  | Scroll the focused pane half a page                                           |
| `a`                                  | Mark the group done and advance; again to unmark | Same, including all group members                                             |
| `u`                                  | Undo the last verdict and return to its group    | Same, staying in the diff                                                     |
| `o`                                  | No-op                                            | Open the focused hunk's working-tree file in `EDITOR`                         |
| `1` / `2` / `0`                      | Split / stacked / automatic diff layout          | Same                                                                          |
| `r`                                  | Refresh the Git snapshot                         | Same                                                                          |
| `?`                                  | Show all keys                                    | Same                                                                          |

## Sessions

Snapshots stay fixed when files change. Gyst warns when the recorded Git scope
changes; press `r` to refresh explicitly. `gyst session check` reports `unchanged`,
`changed`, `unavailable`, or `stdin` without modifying review progress. Checks are
periodic and cached, not a real-time guarantee. Stdin snapshots have no source to
check; replace them explicitly with `gyst session refresh --stdin`.

Use `/gyst-refresh` in your agent's chat to refresh the existing review and revise
its affected groups and explanations while preserving unrelated review progress.
If you already pressed `r`, ask it to regroup the current snapshot instead.

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
