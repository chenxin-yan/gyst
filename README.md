# gyst

Review code changes with your coding agent, in your terminal.

Your agent groups repetitive changes and summarizes the rest. You review the diff
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
   The agent prepares the review and tells you when it is ready.

3. Open another terminal in the same repository:

   ```sh
   gyst
   ```

Use `/gyst-ask <question>` in your agent's chat to ask about the current review item.

## Review keys

| Key       | Action                      |
| --------- | --------------------------- |
| `j` / `k` | Next / previous item        |
| `e`       | Expand / collapse a group   |
| `a`       | Toggle accepted             |
| `u`       | Undo the last verdict       |
| `r`       | Refresh the diff from Git   |
| `?`       | Show all keyboard shortcuts |
| `q`       | Quit and keep the session   |

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
