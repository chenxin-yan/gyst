# gyst

Review code changes with your coding agent, in your terminal.

Your agent organizes coherent changes into review items with short titles and
contextual Markdown overviews. Every member hunk is shown. You review the diff
and decide what to accept. Accepting marks an item reviewed—it does not stage,
commit, or modify your code.

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
   The agent publishes complete items progressively. You can review published
   items while the remaining hunks await preparation.

3. Open another terminal in the same repository:

   ```sh
   gyst
   ```

Use `/gyst-ask <question>` in your agent's chat to ask about the current review item.

## Review keys

| Key                                  | Queue                                       | Zoom: diff                        | Zoom: overview                |
| ------------------------------------ | ------------------------------------------- | --------------------------------- | ----------------------------- |
| `j` / `k`                            | Next / previous entry                       | Next / previous hunk, wrapping    | Scroll one line               |
| `Enter`                              | Zoom into the first hunk                    | No-op                             | No-op                         |
| `Tab` / `Shift+Tab`                  | No-op                                       | Focus overview                    | Focus diff                    |
| `Esc`                                | No-op                                       | Return to queue                   | Return to queue               |
| `Ctrl+D` / `Ctrl+U`, `PgDn` / `PgUp` | Scroll diff preview half a page             | Scroll diff half a page           | Scroll overview half a page   |
| `a`                                  | Toggle whole-item acceptance                | Same, including all group members | Same                          |
| `u`                                  | Undo last acceptance and return to its item | Same, staying zoomed              | Same, returning to diff focus |
| `o`                                  | No-op                                       | Open selected working-tree file   | Open retained selected file   |

## Sessions

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
