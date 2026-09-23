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

Accepting advances atomically to the next unaccepted published item, wrapping once.
If none remain, the current view stays put; later arrivals do not steal focus.
Unaccepting does not advance. Inbox hunks can be inspected but not accepted.

`1` / `2` / `0` select split / unified / automatic diff layout. Auto uses the
available diff-pane width (120 columns), not the terminal width. Zoom hides the
queue and shows diff plus Markdown overview side by side at 120 terminal columns
or wider; narrower terminals show only the active pane. Each pane keeps its scroll
position across Tab and polls. Escape hides the overview; re-entering starts at
the first hunk and top of the overview.

`r` explicitly refreshes the Git snapshot (stdin snapshots must be replaced by the
harness). `?` shows help. `q` quits and keeps the session; `Ctrl+C` cancels.

## Editing a selected file

While zoomed, `o` opens the header's selected file in `$EDITOR`. This is the current
working-tree file, **not** a reconstruction of the reviewed snapshot; a historical
diff may not match it. The file must already exist, be regular, and resolve inside
the session's repository (including symlink resolution). Missing/deleted files are
not created. Stdin hunks work only when they identify such a local file. Filenames that
Git quotes in diff headers (non-ASCII under the default `core.quotePath`, backslashes,
quotes, control characters) are not decoded: `o` uses the literal header text, so
such files are usually reported missing.

Set `EDITOR` to one executable name or path. Paths containing spaces work without
extra quoting inside the value. There is no shell expansion, argument splitting,
`VISUAL` fallback or guessed line-number/wait flag. For flags, use an executable
wrapper that forwards its file argument, for example:

```sh
#!/bin/sh
exec vim -f "$@"
```

Point `EDITOR` at the wrapper. Gyst waits for that executable, so a GUI launcher
must be configured to wait itself. Gyst's inputs and polling pause during editing;
the editor owns its keys (Vim's Ctrl+C may cancel a command rather than exit).
An OS SIGINT interrupts the editor and returns to gyst after it exits; termination
shuts both down. Only the configured child is signalled; wrappers should `exec`
their editor rather than leave detached descendants. Unix job-control/descendant behavior and Windows
terminal behavior are not interchangeable.

Returning synchronizes session status but **never refreshes the snapshot**. Press
`r` to refresh a Git snapshot explicitly; the harness must replace stdin snapshots
with `gyst session refresh --stdin`. An editor error leaves navigation and quit usable.

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
Titles and overviews are proposals, not correctness claims. Overviews show native
Markdown headings, lists, code, references and tables. References are displayed
context, not automatic navigation. Mermaid remains ordinary fenced source text;
no diagram rendering is provided.

## Persistence

Sessions are saved on disk and survive daemon restarts. Saved files that fail schema
validation are skipped without being changed or migrated.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
