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

| Key                 | Action                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `j` / `k`           | Next / previous item                                                           |
| `Enter` / `Esc`     | Step into an item / back to the list; inside, `j` / `k` move between its hunks |
| `Ctrl+D` / `Ctrl+U` | Scroll the diff down / up                                                      |
| `a`                 | Toggle accepted for the whole item (all members of a group)                    |
| `u`                 | Undo the last verdict                                                          |
| `r`                 | Refresh the diff from Git                                                      |
| `?`                 | Show all keyboard shortcuts                                                    |
| `q`                 | Quit and keep the session                                                      |

## Sessions

Run `gyst` again to resume. There is one session per repository. When you are done,
close it before starting a review with a different scope:

```sh
gyst session close
```

For CLI options, run `gyst --help` or `gyst session --help`.

Published items can be accepted while the inbox still contains hunks. Reviewing
all prepared items is not completion until preparation finishes. Refresh preserves
unchanged work; changing or removing any group member resets that group's verdict.
Titles and overviews are proposals, not correctness claims. This model update shows
titles and all diffs; the focused Markdown overview pane follows in the next slice.
Mermaid remains ordinary fenced source text; no diagram rendering is provided.

## Upgrading existing sessions

Finish and close sessions with the old executable before upgrading, ensure the old
daemon has exited, then run `gyst skills` to refresh installed skills. Saved sessions
have an explicit format version: incompatible files remain untouched and block a
second session for that repository. They are not migrated. If you cannot finish
with the old version, manually archive the reported file before restarting gyst.
Mismatched daemon replies fail visibly; gyst never silently kills the old daemon.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
