# gyst

Review code changes with your coding agent.

Your agent plans a top-to-bottom walkthrough of all changes, then publishes
self-contained groups with short titles and concise notes attached to hunks. Each group contains one or more hunks, all shown for review. You decide
what to accept. Accepting marks a group reviewed—it does not stage, commit, or
modify your code.

## Install

Requires Node.js 24 or later on Linux or macOS.

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

This version ships the headless session CLI, background daemon, agent skills and a
browser viewer that shows each saved session's captured diff. The terminal review viewer
has been removed; the browser viewer does not show agent guidance or record review
progress (verdicts and focus) yet.

## Review in the browser

```sh
gyst                   # uncommitted changes, including untracked files
gyst main...feature    # a Git range
gyst --session <id>    # a saved session
```

`gyst` opens the saved session for that scope (creating it only if there is none), starts a
private viewer on this machine and opens it in your browser. When it cannot open a browser, it
prints a private link instead; open that link yourself. It stays in the foreground: stop it
with Ctrl-C when you are done. Closing the browser or stopping `gyst` keeps every saved session.

The link is for you only. Do not paste it into an agent chat or share it. Its secret part
expires 10 minutes after launch; once opened, that browser stays signed in (reloads, new tabs)
until `gyst` stops. If the viewer says it is no longer signed in, run `gyst` again and open the
new link. The viewer's home page lists saved sessions; deleting one there asks for confirmation
and removes only that session.

The viewer runs on a new `*.localhost` host name for each launch and has been tested with
Chromium on Linux.

### Over SSH

Run `gyst` on the remote machine and forward its port from your computer:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:LOCAL:127.0.0.1:REMOTE user@remote
```

`REMOTE` is the port in the printed link and `LOCAL` is any free port on your computer. Open
the printed link in your local browser with its port replaced by `LOCAL`, keeping the host name
and the rest of the link unchanged. The viewer only listens on the remote machine's loopback
address; there is no LAN or reverse-proxy mode.

## Sessions

Agents open a session with `gyst session open` for uncommitted changes (including
untracked files) or `gyst session open <range>` for a Git range such as `main...feature`.
It prints the session id and snapshot identity as JSON without launching anything.
Every other session command names that exact session with `--session <id>`.

Snapshots stay fixed when files change. Refresh explicitly with
`gyst session refresh --session <id>`. `gyst session check --session <id>` reports
`unchanged`, `changed`, or `unavailable` without modifying review progress. Checks are
periodic and cached, not a real-time guarantee.

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

Each repository and recorded scope has its own saved session, and different scopes
coexist. Reopening a scope returns its saved session as it is, even after the refs it
names move; only an explicit refresh recaptures it. Sessions are kept until you delete
one:

```sh
gyst session list
gyst session delete --session <id> --request-id <request-id>
```

Choose the request id once for that deletion. If the reply is lost, retry with the same
request id and session to get the recorded result; a request id already used for
another session is rejected.

For CLI options, run `gyst --help` or `gyst session --help`.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
