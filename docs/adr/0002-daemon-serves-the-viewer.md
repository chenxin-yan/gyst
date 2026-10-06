# ADR 0002: The daemon serves the viewer, without login

Status: accepted (2026-10-06). Revises the transport and local-security parts of
[ADR 0001](0001-effect-architecture.md) and the [web review handoff](../plans/web-review-ui.md).

## Context

The first web design served the SPA from a foreground `gyst` process: each launch bound an
ephemeral loopback port, minted a random `g-<hex>.localhost` hostname and a bootstrap token
exchanged for a cookie, and stopped serving on Ctrl-C. That shape left three problems in daily use:

- An agent could not show the human a review without keeping a long-running process alive, which
  harnesses support unevenly; the skill had to ask the human to start the viewer.
- Over SSH, every launch needed a new port forward.
- The agent's one-shot `session open` and the human's long-running `gyst` could not be the same
  kind of command.

## Decision

The daemon, already the long-lived owner of every session, also serves the SPA, the browser
operations and their SSE stream over loopback HTTP. Every command is one-shot: `gyst` and
`gyst session open` both open or reuse a session and return its link; `gyst` also opens a local
browser.

- **One stable port.** 4978 ("gyst" on a phone keypad). If it is taken, the daemon tries the next
  port, up to 4987, and keeps the port it bound for its lifetime. Every link names the actual
  port. `GYST_PORT` sets the starting port for development and tests.
- **No login.** Links are plain `http://localhost:<port>/session/<id>` URLs. Loopback binding plus
  strict checks stop other origins: `Host` must be a loopback name (any port, so SSH forwards with
  a different local port work), `Origin` must match `Host` on every mutation, and forwarding
  headers are refused. Gyst assumes a single-user machine: any local OS user can reach the port.
- **The HTTP adapter and the Unix socket share the same review operations.** Browser-specific
  validation and human authority stay in the HTTP adapter; the bridge process is removed.
- **Invocation environment travels explicitly.** The navigation add-on is discovered from the
  PATH of the latest CLI invocation that opened the session, sent over the socket, never from the
  daemon's inherited environment or from a browser request.

## Considered options

- **Keep the foreground launcher; let the agent run it in the background and relay the URL, with
  a fixed port.** Cheapest, but it still ties viewing to a process the harness may kill, and two
  launchers cannot share one fixed port.
- **A separate auto-started viewer server next to the daemon.** Keeps the old process boundary
  but adds a second singleton with its own ownership, upgrade and recovery story, for no isolation
  requirement we have.
- **Daemon-served viewer with expiring per-link logins.** Protects against other local OS users,
  at the cost of token minting, expiry policy and re-authentication. Deferred until shared hosts
  matter.

## Consequences

- Same-user processes, including the agent, can reach the HTTP surface and so act as the human.
  They could already reach the daemon's socket; human authority remains a contract of the CLI and
  skills, not a sandbox.
- Gyst is unsuitable for shared multi-user hosts until a login is added; that is a new ticket,
  not configuration.
- Closing the browser ends nothing; the viewer lives as long as the daemon, which still exits when
  no saved session remains.
- A future hosted deployment still needs real authentication, provisioning and isolation; this
  local shape neither provides nor blocks it.

## Sources

- [Hosted-ready architecture seams](https://github.com/chenxin-yan/gyst/issues/74#issuecomment-5851460434)
- [Reaching gyst from a laptop when developing on a remote machine](https://github.com/chenxin-yan/gyst/issues/65#issuecomment-5829612875)
