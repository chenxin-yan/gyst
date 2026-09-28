# gyst

Review code changes with your coding agent.

Your agent plans a top-to-bottom walkthrough of all changes, then publishes
self-contained groups with short titles and concise notes attached to hunks. Each group contains one or more hunks, all shown for review. You decide
what to accept. Accepting marks a group reviewed—it does not stage, commit, or
modify your code.

## Install

Requires Node.js 24 (`>=24.11.0 <25`) on Linux or macOS.

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
   progressively into the session.

This version ships the headless session CLI, background daemon and agent skills. The
terminal review viewer has been removed and no replacement viewer is included yet, so
review progress (verdicts and focus) cannot be recorded from this version.

## Sessions

Snapshots stay fixed when files change. Refresh explicitly with `gyst session refresh`.
`gyst session check` reports `unchanged`, `changed`, `unavailable`, or `stdin` without
modifying review progress. Checks are
periodic and cached, not a real-time guarantee. Stdin snapshots have no source to
check; replace them explicitly with `gyst session refresh --stdin`.

Use `/gyst-refresh` in your agent's chat to refresh the existing review and revise
its affected groups and explanations while preserving unrelated review progress.
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

There is one session per repository. When you are done, close it before starting a
review with a different scope:

```sh
gyst session close
```

For CLI options, run `gyst --help` or `gyst session --help`.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
