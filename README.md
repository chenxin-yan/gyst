# gyst

[![pkg.pr.new](https://pkg.pr.new/badge/chenxin-yan/gyst)](https://pkg.pr.new/~/chenxin-yan/gyst)

Review code changes with your coding agent.

Your agent plans a top-to-bottom walkthrough of all changes, then publishes
self-contained groups with short titles and concise notes attached to hunks. Each group contains one or more hunks, all shown for review. You mark
hunks Viewed as you read them. Viewed means read, not approved—it does not stage,
commit, or modify your code.

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
browser viewer, served by the daemon, that shows each saved session's captured diff. The terminal review viewer
has been removed; the browser viewer does not show agent guidance yet.

## Review in the browser

```sh
gyst                   # uncommitted changes, including untracked files
gyst main...feature    # a Git range
gyst --session <id>    # a saved session
```

`gyst` opens the saved session for that scope (creating it only if there is none), prints its
link, `http://localhost:4978/session/<id>`, opens it in your browser when there is one on this
machine, and exits. The background daemon serves the viewer for as long as it runs, so the link
keeps working after `gyst` exits; closing the browser keeps every saved session. The viewer's
home page lists saved sessions; deleting one there asks for confirmation and removes only that
session.

The daemon listens on `127.0.0.1` only, at port 4978. If another program holds it, the daemon
tries each next port up to 4987 and keeps the port it got until it exits; a restarted daemon takes
that port again while it is free. Every link names the actual port. Set `GYST_PORT` to start from another port (for development and tests). When every
port in the range is taken, `gyst` fails with an error naming the range.

There is no login. The viewer accepts only loopback host names (`localhost`, `127.0.0.1`), on any
port, and refuses requests from other web origins, so a web page you visit cannot use it. Gyst
assumes a single-user machine: any user logged in to it can reach the port, and programs you run,
including your agent, can act as you in the viewer. Do not run gyst on a machine you share with
other users.

The viewer has been tested with Chromium on Linux, directly and through a local SSH forward to the
same machine; other browsers, platforms and a separate remote machine are untested.

### Over SSH

Run `gyst` on the remote machine and forward the viewer's port from your computer once:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4978:127.0.0.1:4978 user@remote
```

Then open the printed links in your local browser. One forward serves every session for as long
as the remote daemon runs. If the link names another port than 4978, forward that port instead;
if your local 4978 is taken, forward another local port (`-L 127.0.0.1:LOCAL:127.0.0.1:4978`) and
use it in the link. The viewer only listens on the remote machine's loopback address; there is no
LAN or reverse-proxy mode.

## Sessions

Agents open a session with `gyst session open` for uncommitted changes (including
untracked files) or `gyst session open <range>` for a Git range such as `main...feature`.
It prints the session id, snapshot identity and viewer link as JSON, without opening a browser.
Every other session command names that exact session with `--session <id>`.

Snapshots stay fixed when files change. Refresh explicitly with
`gyst session refresh --session <id>`. `gyst session check --session <id>` reports
`unchanged`, `changed`, or `unavailable` without modifying review progress. Checks are
periodic and cached, not a real-time guarantee.

A snapshot keeps the exact text of every eligible project file, unchanged ones included, so
reviews keep working after the checkout changes or is removed. `gyst session files --session
<id> --snapshot <snapshot>` lists the snapshot's files a page at a time, with each side's
availability (absent, or unavailable as binary, non-UTF-8, a symlink, a submodule or left out by
a snapshot quota). `gyst
session code --session <id> --snapshot <snapshot> --file <path> --side old|new` returns up to
64 KiB of that side's exact text per page, from `--start-line` (optionally to `--end-line`) or
from the previous page's `next.offset` via `--offset`; a line longer than a page continues on
the next one. Reads never consult the checkout and name the session's current snapshot, from
`open`, `status` or `diff`; after a refresh an older one serves only the files the session's
guidance, conversations and drafts still point at, and anything else fails with
`stale_revision`. On a terminal, capturing (`gyst`, `open`, `refresh`) shows its progress on
stderr.

In the viewer, `c` comments on the selected lines or the cursor's line (in Mouse mode, select
lines with the hover + and press Comment), `r` replies to a note or thread, `x` resolves a thread
and `C` lists every conversation, where resolved ones are reopened. Each message is a Question or
a Change request and stays Pending, editable and deletable, until the agent retrieves it. Agents
retrieve them with `gyst session threads --session <id> --pending --request-id <request-id>`
(`--open` for every open thread, read work included): one step that returns each thread's history
and original code and reads exactly the Pending messages it returns. Retrying with the same request
id returns the same bundle. Agents answer with `thread.reply` ops in `gyst session apply`, together
with any guidance changes; they never resolve, reopen or start threads.

Use `/gyst-refresh` in your agent's chat to refresh the existing review and revise
its affected groups and explanations while preserving unrelated review progress.
Refresh retains notes only for wholly surviving groups, and Viewed only for exactly
matching hunks; losing any member clears that group's notes without changing
unrelated groups.

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

## Export a walkthrough

Once the agent's walkthrough is complete (every changed hunk in exactly one group, the overview
and every group overview written, nothing Outdated) you can share it as one standalone HTML file.
In the viewer, choose Export… in the top bar. Before anything is written it shows:

- every file side the file will carry, with its content identity: the changed files in full, and
  the files the guidance references, older pinned ones included, and nothing else of the project;
- the references it cannot show, and why; they stay visible in the file with that reason;
- where the sides came from: the recorded scope and the Git commits resolved when the snapshot was
  captured, a three-dot range's merge base included. Uncommitted changes are the working tree as
  captured, which no commit identifies; an unborn repository's old side is an empty baseline.

Full files and guidance may disclose secrets or confidential content. Check them before you share
the file; gyst neither scans nor redacts anything. Approve and download generates the file for
exactly the state you approved: if the walkthrough or its snapshot changed meanwhile, nothing is
exported and the new preview needs approving again. Exporting never refreshes, revalidates or
reads the checkout.

From a terminal, `gyst session export --session <id> [--output <file>]` shows the same preview
on stderr and writes the file only once you type `yes`. It needs an interactive terminal, so an
agent cannot export on your behalf through it. An existing file is never replaced, and a failed
write leaves nothing behind. On success it prints the path, size, snapshot and export time as
JSON.

The file opens from disk in a browser, offline, without gyst, the daemon or the checkout. It is
read-only: groups, files, notes, folds, layouts, full-file context, references with peek, expand
and Back, and the reading keys work; it carries no conversations, Viewed progress, session id or
local paths, makes no network request, and opens a web link only when you click it. It cannot be
imported back into gyst. The reader itself is about 15 MiB; a 1,000-file export is about 20 MiB.

## Storage

Sessions and their captured files live in gyst's data directory on the machine running the
daemon: `GYST_DATA_DIR`, else `$XDG_DATA_HOME/gyst`, else `~/.local/share/gyst`. A file's
content is stored once however many snapshots and sessions capture it. Saved sessions and their
review work are never deleted for you, by age or otherwise; only `gyst session delete` (or
deleting from the viewer's home page) removes one.

Gyst reclaims, in the background, only captured content that nothing needs any more:

- a snapshot a refresh replaced, apart from the files its notes and references, conversations
  (resolved ones included) and unsent drafts still point at. A draft keeps the whole snapshot it
  was begun on until you send or discard it, even after the browser closes or the daemon
  restarts;
- a deleted session's content, unless another session captured the same files;
- whatever a failed or interrupted capture, or a source check that found a change, left behind.

It never removes content a read, capture or another session still uses, nor what a saved
session file this version cannot read names. That is separate from the viewer's and
navigation's caches (loaded code, navigation's working copies), which are rebuilt from the
saved content whenever they are dropped; a capture short of space drops navigation's copies that
no query is using.

There is no built-in size limit. To bound what one snapshot keeps, set `GYST_SNAPSHOT_QUOTA` to
a size with a unit, such as `500 MiB`, in the environment gyst's daemon starts from:

- The files with reviewed text changes must fit whole, or the capture fails with
  `source_unavailable` (`quota_exceeded`) and nothing is saved; a review is never published
  truncated.
- Every other file's text, unchanged supporting files, mode-only changes and renames included,
  then fills the rest in path order; a rename keeps or leaves out both its paths together, and is
  still recorded as a rename. Text left out is never stored, and reads as unavailable with reason
  `quota`, in `files`, `code`, the viewer and navigation; it is never replaced by the file in
  your checkout. A source check of uncommitted changes reports `unavailable` while files are left
  out, since it cannot see whether they changed.

The daemon reads `GYST_SNAPSHOT_QUOTA` when it starts. It stops by itself once no saved session
remains; otherwise stop it with `SIGTERM` (its PID is in `daemon.pid` in the data directory)
and the next `gyst` command starts one with the current environment. Snapshots already captured
keep what they captured until you refresh them.

When a capture fails:

- `quota_exceeded`: raise or unset `GYST_SNAPSHOT_QUOTA` and restart the daemon, or review a
  smaller scope.
- `storage_full`: the data directory's disk is full. Gyst has already dropped unused navigation
  copies, reclaimed what nothing needs and tried once more; free space there, or delete sessions
  you no longer need, then retry.

A failed capture, refresh or cleanup leaves every saved session as it was.

## More

- [Development and releases](CONTRIBUTING.md)
- [Report an issue](https://github.com/chenxin-yan/gyst/issues)
- [MIT license](LICENSE)
