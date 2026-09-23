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

| Key                                  | Queue                                       | Zoom: diff                        | Zoom: overview                |
| ------------------------------------ | ------------------------------------------- | --------------------------------- | ----------------------------- |
| `j` / `k`                            | Next / previous entry                       | Next / previous hunk, wrapping    | Scroll one line               |
| `Enter`                              | Zoom into the first hunk                    | No-op                             | No-op                         |
| `Tab` / `Shift+Tab`                  | No-op                                       | Focus overview                    | Focus diff                    |
| `Esc`                                | No-op                                       | Return to queue                   | Return to queue               |
| `Ctrl+D` / `Ctrl+U`, `PgDn` / `PgUp` | Scroll diff preview half a page             | Scroll diff half a page           | Scroll overview half a page   |
| `a`                                  | Toggle whole-group acceptance               | Same, including all group members | Same                          |
| `u`                                  | Undo last acceptance and return to its item | Same, staying zoomed              | Same, returning to diff focus |
| `o`                                  | No-op                                       | Open selected working-tree file   | Open retained selected file   |

## Sessions

Snapshots stay fixed when files change. Gyst warns when the recorded Git scope
changes; press `r` to refresh explicitly. `gyst session check` reports `unchanged`,
`changed`, `unavailable`, or `stdin` without modifying review progress. Checks are
periodic and cached, not a real-time guarantee. Stdin snapshots have no source to
check; replace them explicitly with `gyst session refresh --stdin`.

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
