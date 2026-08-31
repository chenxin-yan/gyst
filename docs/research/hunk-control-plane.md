# Hunk control plane under the hood — research for pith ticket #7

## Scope and source attestation

This report describes the checked-out Hunk source at commit [`2454101d326fc0513e40e38c47a6a945b4b733b1`](https://github.com/modem-dev/hunk/tree/2454101d326fc0513e40e38c47a6a945b4b733b1), not the aspirational SDK design in `docs/session-broker-sdk.md`. The repository was shallow-cloned read-only to `/tmp/pith-src/hunk`; no pith working-tree files were touched. All claims below cite Hunk’s own source or its official repository documentation.

## Executive answer

Hunk uses **one detached Bun daemon per configured TCP host/port**, shared by all TUI windows. It is not a Unix-domain socket design: `/session` is a **WebSocket URL path** on a fixed HTTP listener, defaulting to `127.0.0.1:47657`; signed HTTP calls use `/session-api`. Each interactive Hunk window acts as a producer: it starts or finds the daemon, authenticates, registers a random session ID plus metadata/snapshot, maintains heartbeats, and executes commands forwarded over the WebSocket. Each `hunk session ...` invocation is a short-lived signed HTTP caller; it discovers the daemon from the same fixed configuration and **does not start it**. [Source: `brokerConfig.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerConfig.ts#L3-L17), [source: `runInteractiveApp.tsx`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/runInteractiveApp.tsx#L40-L57), [source: `commands.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/commands.ts#L54-L82)

## 1. Daemon and broker lifecycle

### Topology and startup

```text
interactive Hunk TUI (producer)                 hunk session ... (caller)
  SessionBrokerClient                            signed HTTP request
  ws://127.0.0.1:47657/session                         |
            \                                         /
             one detached `hunk daemon serve` process
             HTTP: /health, /session-api, browser-review routes
             WS:   /session
```

- The defaults are `HUNK_MCP_HOST=127.0.0.1` and `HUNK_MCP_PORT=47657`; `HUNK_MCP_HOST`, `HUNK_MCP_PORT`, and `HUNK_MCP_DISABLE=1` are the compatibility/configuration controls. The confusing constant `SESSION_BROKER_SOCKET_PATH = "/session"` names a WebSocket path, not a filesystem socket. [Source: `brokerConfig.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerConfig.ts#L3-L17), [source: `brokerClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L81-L102)
- The interactive path constructs a `SessionBrokerClient` before mounting OpenTUI and calls `start()`. That client checks `/health`, coordinates launch, and then opens an authenticated WebSocket. [Source: `runInteractiveApp.tsx`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/runInteractiveApp.tsx#L40-L57), [source: `brokerClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L118-L164)
- The launcher uses a per-host/port `wx` lock file to collapse concurrent starts, then spawns the same executable as `daemon serve` with `detached: true`, ignored stdio, and `unref()`. Source runs preserve the runtime plus script entrypoint; compiled executables invoke themselves directly. [Source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L257-L297), [source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L503-L525), [source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L528-L602)
- Coordination files live under `$XDG_RUNTIME_DIR/hunk-mcp`, or `~/.hunk/hunk-mcp` on Unix when XDG runtime state is unavailable; names include the host and port. They are launch coordination and change-detection hints, **not endpoint discovery or authority**. Discovery is the configured host/port plus health probe. [Source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L95-L104), [source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L302-L318), [source: `brokerLauncher.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerLauncher.ts#L414-L435)
- `hunk daemon serve` is also public for manual startup/debugging; `hunk mcp serve` remains a parser alias. The main process awaits the server’s `stopped` promise. [Source: `cli.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/cli.ts#L297-L301), [source: `main.tsx`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/main.tsx#L23-L27)

### Registration, liveness, reconnect, and shutdown

- A new TUI session gets `randomUUID()` as `sessionId`; registration also publishes PID, process CWD, inferred repository root, launch time, terminal metadata, diff summaries, and a review-resource catalog. Reload replaces metadata/snapshot while preserving this identity. [Source: `registration.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/registration.ts#L81-L132)
- The TUI sends snapshots whenever selection, notes, highlights, or publication revision changes. Commands are executed in the TUI by a bridge; the daemon is a router/mirror, not the owner of UI semantics. [Source: `useHunkSessionBridge.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/hooks/useHunkSessionBridge.ts#L67-L135), [source: `bridge.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/bridge.ts#L68-L128)
- Producers heartbeat every 10 seconds and reconnect after 3 seconds. The daemon prunes sessions stale for 45 seconds on a 15-second sweep. It exits after 60 seconds only when no live sessions or pending commands remain; public `/health` returns only `{ "ok": true }`. [Source: `brokerClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L27-L31), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L56-L59), [source: `daemon.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker/src/daemon.ts#L404-L417), [source: `daemon.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker/src/daemon.ts#L770-L825)
- TUI teardown stops its producer connection. Daemon `SIGINT`/`SIGTERM` closes browser review and force-stops the server. An incompatible incumbent is never killed from PID metadata; the TUI polls until it disappears, then reconnects. [Source: `runInteractiveApp.tsx`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/runInteractiveApp.tsx#L80-L116), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L713-L730), [source: `brokerClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L170-L226)

### What a session CLI process does *not* do

A session CLI invocation probes the configured port. `list` returns `{ "sessions": [] }` when no daemon exists; every other action says no sessions are registered. If TCP is occupied by something that does not answer Hunk health, it reports a port conflict. It does not call the daemon launcher, so a one-shot caller cannot accidentally become lifecycle owner. [Source: `commands.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/commands.ts#L54-L82), [source: `commands.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/commands.ts#L94-L107)

## 2. Session identity and matching

Selector precedence in the broker is `sessionId` → `sessionPath` → `repoRoot` → sole-session fallback, though Hunk’s CLI requires an explicit ID or `--repo` for all ordinary targeted commands. [Source: `brokerState.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/brokerState.ts#L126-L198), [source: `cli.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/cli.ts#L705-L757)

| Selector | Actual matching rule | Important consequence |
|---|---|---|
| positional `<session-id>` | Exact opaque UUID. | Best disambiguator; stable across reconnects and reloads, but not app restarts. |
| `--session-path <path>` | Absolute path equals registered `cwd` exactly. Reload-only CLI selector. | It targets the live window’s launch CWD, not the repository or the reload source. Multiple windows with the same CWD are ambiguous. |
| `--repo <path>` | Existing paths are realpath-canonicalized. A session is eligible when the selector lies in its registered `repoRoot`; the nearest containing root wins and equal-distance matches are ambiguous. | Despite help text saying “repo root matches,” subdirectories intentionally work. Symlinks are normalized on the CLI side. |
| `--source <path>` | Not a selector. It changes the CWD used to load replacement diff content after the session was selected. | Allows “control window A, read checkout B,” but only inside the session’s initial filesystem bounds. |

The path and containment rules are implemented in [`selectors.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/selectors.ts#L13-L74); CLI realpath and exclusivity checks are in [`cli.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/cli.ts#L691-L758). Reload realpath-normalizes existing ancestors, blocks symlink escapes and outside-root reads, rejects option-looking VCS revisions, and disallows stdin-backed reloads; see [`reloadBounds.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/reloadBounds.ts#L9-L31) and [`reloadBounds.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/reloadBounds.ts#L158-L240).

**Pitfall:** repository identity is mutable metadata. A VCS-backed reload updates `repoRoot` while keeping the same session ID, and non-VCS inputs may have no repository selector at all. Pith should therefore make its durable session ID authoritative and treat repo/path as mutable discovery aliases only. [Source: `registration.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/registration.ts#L109-L132)

## 3. Full `hunk session` command surface

The command manifest is the parser/help source of truth and covers 14 daemon actions. [Source: `surface.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/surface.ts#L220-L479)

| Command | Accepted surface | JSON success envelope |
|---|---|---|
| `session list` | `[--json]` | `{ "sessions": ListedSession[] }` |
| `session get` | `(<id> \| --repo <path>) [--json]` | `{ "session": ListedSession }` |
| `session context` | selector; `[--json]` | `{ "context": SelectedSessionContext }` |
| `session review` | selector; `[--include-patch] [--include-notes] [--json]` | `{ "review": SessionReview }` |
| `session navigate` | selector plus either `--file` and exactly one of `--hunk`, `--old-line`, `--new-line`; or `--comment`; or one of `--next-comment`, `--prev-comment` | `{ "result": NavigatedSelectionResult }` |
| `session reload` | `(<id> \| --repo \| --session-path) [--source] [--json] -- diff ...` or `-- show ...` | `{ "result": ReloadedSessionResult }` |
| `session comment add` | selector; required `--file`, exactly one old/new line, required `--summary`; optional `--rationale --markup --author --focus --json` | `{ "result": AppliedCommentResult }` |
| `session comment apply` | selector; required `--stdin`; optional `--focus --json` | `{ "result": { "applied": AppliedCommentResult[] } }` |
| `session comment list` | selector; optional `--file`; `--type live\|all\|ai\|agent\|user`; `--json` | `{ "comments": (LiveCommentSummary \| ReviewNoteSummary)[] }` |
| `session comment rm` | `<id> <comment-id>` or `--repo <path> <comment-id>`; `[--json]` | `{ "result": RemovedCommentResult }` |
| `session comment clear` | selector; optional `--file`; `--include-user`/`--all`; required `--yes`; `[--json]` | `{ "result": ClearedCommentsResult }` |
| `session highlight add` | selector; required `--file`, one old/new line, 0-based inclusive `--start`, exclusive `--end`; optional six-tone `--tone`, `--focus`, `--json` | `{ "result": AppliedHighlightResult }` |
| `session highlight clear` | selector; optional `--file --json` | `{ "result": ClearedHighlightsResult }` |

The exact synopses/options are in [`surface.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/surface.ts#L220-L479). The wire action union and response envelope mapping are in [`protocol.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocol.ts#L11-L140). JSON is pretty-printed with a trailing newline; text mode is separately formatted and terminal-control-sanitized. [Source: `cliClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/cliClient.ts#L263-L267), [source: `cliClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/cliClient.ts#L403-L411)

### JSON object contracts

The response parser uses strict Zod objects, so unknown/missing/wrong-typed fields fail the CLI rather than being silently stripped. [Source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L13-L21), [source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L408-L457)

- `ListedSession`: `sessionId`, `pid`, `cwd`, optional `repoRoot`, `launchedAt`, optional terminal metadata, `inputKind`, `title`, `sourceLabel`, optional experimental features, `fileCount`, file summaries, and snapshot. A snapshot includes focus, note visibility, live comments, optional review notes, and optional publication generation/revision. [Source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L245-L308)
- `SessionReview`: session metadata, nullable selected file/hunk, note visibility/counts, optional notes, and all files; each file has identity/path/stats plus hunks, and only `--include-patch` fills optional raw `patch`. [Source: `types.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/types.ts#L21-L51), [source: `types.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/types.ts#L320-L339)
- `AppliedCommentResult`: comment/file IDs, file path, zero-based hunk index, side, line, and optional markup width/notes. Navigation and highlight results similarly return canonical file/hunk coordinates; clear/remove operations return removed/remaining counts. Reload returns session ID, input kind, title/source, file count, and resulting focus. [Source: `types.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/types.ts#L174-L263), [source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L352-L407)
- HTTP requests are strict discriminated JSON and responses are strict per action. Non-2xx bodies expose a string `error` when present; malformed success JSON becomes `Invalid Hunk session daemon response for <action>`. [Source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L116-L206), [source: `cliClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/cliClient.ts#L59-L78), [source: `cliClient.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/cliClient.ts#L113-L139)

## 4. Batch comment application via stdin

`comment apply` accepts no filename or argv JSON: `--stdin` is mandatory. Its payload is:

```json
{
  "comments": [
    {
      "filePath": "src/App.tsx",
      "newLine": 42,
      "summary": "Explain why this is safe",
      "rationale": "Optional detail",
      "markup": "Optional experimental STML",
      "author": "agent"
    },
    {
      "filePath": "README.md",
      "hunk": 2,
      "summary": "This example is stale"
    }
  ]
}
```

Each item requires non-empty `filePath` and `summary`, and exactly one target from `hunk`/`hunkNumber` (aliases), `oldLine`, or `newLine`; numeric values are positive integers. Empty input, malformed JSON, an empty/missing comments array, wrong items, dual hunk aliases, or multiple/no targets fail before contacting the daemon. Unrecognized top-level/item fields are ignored by this CLI parser, unlike the later strict daemon request parser. [Source: `cli.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/cli.ts#L600-L687), [source: `cli.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/cli.ts#L1306-L1337)

The daemon lowers 1-based hunks to zero-based indexes and forwards **one** `comment_batch` command with a 30-second daemon-side timeout. The TUI resolves every target first, then performs one store dispatch, so target/markup validation is locally all-or-none; `--focus` reveals the first applied item. [Source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L393-L416), [source: `useTerminalReview.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/hooks/useTerminalReview.ts#L1183-L1233)

**Critical retry caveat:** local all-or-none mutation does not make the distributed operation exactly once. If the command executes but its response is lost or arrives after a timeout, retrying creates another batch with new request-derived IDs. Hunk exposes no idempotency key or delivery-certainty field. [Source: `brokerState.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/brokerState.ts#L510-L607), [source: `useTerminalReview.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/ui/hooks/useTerminalReview.ts#L1190-L1203)

## 5. Failure modes

| Severity | Failure | Observable behavior / consequence | Source |
|---|---|---|---|
| High | Mutating command times out after delivery | CLI reports timeout, but the TUI operation may still complete; a retry can duplicate comments or repeat reload/clear effects. The generic queue removes the pending request on timeout and ignores a late result; there is no CLI idempotency contract. | [`brokerState.ts#L510-L607`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/brokerState.ts#L510-L607) |
| Medium | Agent sandbox blocks loopback | A visibly open TUI may look absent; official guidance is to retry with network/sandbox permission rather than expose the daemon. | [`live-session-control.md`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/website/src/content/docs/docs/agents/live-session-control.md#L41-L43) |
| Medium (availability) | Fixed port is occupied or a foreign listener mimics/blocks health | Launcher refuses with a conflict or signed negotiation fails; it does not kill the listener. Explicitly select another loopback port or stop the process. | [`commands.ts#L54-L82`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/commands.ts#L54-L82), [`brokerClient.ts#L151-L160`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L151-L160) |
| Medium | Multiple windows match a repo/path | Selection fails and lists candidate session IDs; the caller must retry with an explicit ID. | [`brokerState.ts#L126-L198`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/brokerState.ts#L126-L198) |
| Medium | Daemon/TUI protocol skew | Capability check rejects missing actions or daemon revision and instructs the user to close older windows, wait for idle exit, and retry. Older authenticated-incompatible incumbents are not forcibly replaced. | [`commands.ts#L44-L52`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/commands.ts#L44-L52), [`brokerClient.ts#L170-L226`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerClient.ts#L170-L226) |
| Medium | Session reload crosses initial trust boundary | Reload is rejected for outside-root/symlink-escaped paths, option-like VCS revisions, unrooted/stdin sessions, or unsupported nested CLI operations. This is intentional containment, not arbitrary remote shell execution. | [`reloadBounds.ts#L123-L240`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/reloadBounds.ts#L123-L240) |
| Low/Medium | Session disappears during action or patch-resource read | Caller receives “no longer connected,” stale removal, timeout, or “Could not read the raw diff”; rerun review, preferably without patch when structure suffices. | [`brokerState.ts#L503-L539`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/brokerState.ts#L503-L539), [`errors.ts#L48-L58`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/errors.ts#L48-L58) |
| Low | Slow/hung daemon HTTP | Whole CLI operation, including body parsing, is bounded to 5 seconds; reload/batch have a 30-second broker command timeout, but the outer CLI HTTP timeout is still 5 seconds. | [`daemonHttp.ts#L7-L54`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/client/daemonHttp.ts#L7-L54), [`brokerServer.ts#L372-L416`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L372-L416) |
| Low | Capacity/input limits | Requests can fail `busy`, `queue-full`, or `capacity-exceeded`; defaults include 256 sessions, 64 commands/session, 1,024 total, 1 MiB command input/result, and 4 MiB HTTP body. | [`budgets.ts#L40-L74`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/budgets.ts#L40-L74), [`brokerServer.ts#L469-L477`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L469-L477) |

The 5-second outer timeout versus 30-second reload/batch timeout is particularly easy to miss: from a CLI user’s perspective the 30-second setting is mostly unreachable unless the HTTP timeout is changed/injected. That widens the unknown-outcome window for long reloads.

## 6. Security posture

### What the current implementation protects

- It refuses non-loopback binds unless `HUNK_MCP_UNSAFE_ALLOW_REMOTE=1`. Loopback recognition includes `localhost`, IPv6 loopback, IPv4-mapped loopback, and all `127/8`. [Source: `brokerConfig.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerConfig.ts#L19-L71)
- It checks `Host` and optional browser `Origin` against the listener port and loopback policy, limiting DNS-rebinding/cross-origin attacks; it emits no permissive CORS path here. [Source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L126-L235), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L637-L665)
- Loopback alone is **not** authorization. Producer and caller bootstrap credentials use Ed25519; hello is challenge/proof, requests are signed over method/target/body digest/generation/session/sequence, and replayed sequences are rejected. Unauthenticated old clients receive HTTP 401. [Source: `authentication.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker/src/authentication.ts#L599-L679), [source: `authentication.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker/src/authentication.ts#L821-L895), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L650-L663)
- Credentials are stored in `security-v1` under the private runtime namespace. Unix directories/files are checked for owner and `0700`/`0600`-equivalent privacy, symlinks are rejected, reads use no-follow when available, and creation publishes complete files atomically. [Source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L73-L139), [source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L216-L259), [source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L329-L366)
- Runtime boundaries are parsed and bounded. Examples: strict action objects, bounded WebSocket/HTTP/retained data, owner-bound command results, and liveness-only public health. [Source: `protocolSchemas.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/protocolSchemas.ts#L116-L206), [source: `budgets.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker-core/src/budgets.ts#L40-L74), [source: `daemon.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/packages/session-broker/src/daemon.ts#L404-L417)

### Residual trust and risks

1. **Medium — same-user ambient authority.** The shared caller credential lasts ten years and grants list/get/diagnostics plus dispatch for all Hunk mutation command families; Hunk’s app authorizer currently returns `true`. Any process that can read the same user’s credential files can operate all sessions. This protects against other OS users and browser/network callers without credentials, not malware or an untrusted coding agent already running as the user. [Source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L29-L46), [source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L275-L301), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L587-L617)
2. **High when enabled — unsafe remote mode.** Setting `HUNK_MCP_UNSAFE_ALLOW_REMOTE=1` permits a non-loopback **plain HTTP/WebSocket** listener and makes Host/Origin acceptance remote-friendly. Signatures still protect control calls, but metadata/traffic confidentiality and network deployment hardening are absent; credential compromise becomes remotely exploitable. It should never be part of pith’s supported design. [Source: `brokerConfig.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerConfig.ts#L48-L71), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L173-L235)
3. **Medium — sandbox mismatch is a product constraint.** An agent sandbox may block TCP loopback even though the process can access the repository. Hunk’s official remedy is sandbox/network escalation. Pith must make this failure distinguishable from “no session” and must not suggest remote exposure as the workaround. [Source: `live-session-control.md`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/website/src/content/docs/docs/agents/live-session-control.md#L41-L43), [source: `errors.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/agent/errors.ts#L76-L88)
4. **Medium — no user approval boundary.** Caller scopes distinguish operations, but the one installed caller grant has all current command scopes and `authorizer: () => true`; writes execute without per-session consent. Pith’s co-review UX should expose a deliberate “agent may annotate/navigate/reload” policy rather than equating possession of a general local credential with consent. [Source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L34-L46), [source: `brokerServer.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/brokerServer.ts#L611-L617)
5. **Low/Medium — Windows assurance is weaker.** The code rejects symlinks and validates object type on Windows, but Unix ownership/mode checks are conditional on non-Windows; no equivalent DACL ownership check appears in this credential implementation. [Source: `credentials.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/credentials.ts#L73-L104)

## 7. Concrete design lessons for pith

### Adopt

1. **One per-user daemon, many sessions; no per-TUI ports.** This simplifies agent discovery and avoids leaking a growing set of listeners. Keep transport and session identity separate.
2. **Make the TUI producer lifecycle owner; keep one-shot CLI calls side-effect-free for daemon startup.** `list` can safely return an empty array while targeted calls explain that no live session exists.
3. **Use an opaque random session ID as authority; treat repo root/CWD/title/PID as untrusted, mutable lookup metadata.** Preserve the ID across review reloads.
4. **Expose deterministic selectors with explicit ambiguity errors.** For pith, use exact canonical repo identity first; only add Hunk-style nearest-containing-root behavior if nested worktree use cases require it.
5. **Separate compact metadata from heavy diff resources.** Hunk registers file/hunk summaries and fetches patch text on demand in bounded, digest-verified chunks, so normal discovery does not copy every patch into daemon memory. [Source: `registration.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/app/session/registration.ts#L36-L78), [source: `state.ts`](https://github.com/modem-dev/hunk/blob/2454101d326fc0513e40e38c47a6a945b4b733b1/src/session/broker/state.ts#L263-L320)
6. **Keep one strict command manifest and derive help/parser/contracts from it.** Hunk’s 14-action manifest prevents docs/parser drift. Pith should do the same, but with its smaller independent surface.
7. **Validate batch targets completely before one state transition.** Return a per-item result array, and define whether an empty batch is invalid.
8. **Bound everything crossing the process boundary and keep health liveness-only.** Host/Origin checks remain useful even on loopback.
9. **Authenticate loopback.** Owner-private credentials plus signed challenge/request protocols are substantially safer than “localhost is trusted.” If pith can use a Unix-domain socket with owner-only permissions on Unix, that can reduce exposure and fixed-port conflicts, but Windows still needs a first-class authenticated transport.
10. **Constrain filesystem-affecting reloads to launch-established roots and canonicalize through symlinks.** Never accept a nested arbitrary CLI/argv as an execution protocol; send a typed reload request instead.

### Do not copy without fixing

1. **Do not use a 5-second outer HTTP timeout around a 30-second mutation.** Use one end-to-end deadline and report a structured outcome.
2. **Do not claim exactly-once behavior.** Add client-generated idempotency keys for comment batches and other retryable mutations, persist enough result/digest state for the intended retry window, and return delivery certainty (`not-delivered`, `delivered`, `unknown`) on timeout/disconnect.
3. **Do not install one broad ten-year caller credential for every local process.** Prefer short-lived per-session capabilities, narrowed to read/navigate/comment operations, with reload separately granted and revocable.
4. **Do not include a supported remote escape hatch.** Pith is local-only; fail closed on non-loopback/non-owner transports.
5. **Do not make a predictable TCP port the only rendezvous.** Prefer an owner-private runtime record pointing to a random endpoint, authenticated before use; retain collision-safe election. If fixed port is the first implementation, classify foreign listeners as availability failures and never kill by PID alone.
6. **Do not collapse “sandbox blocked,” “no daemon,” “no registered session,” “ambiguous selector,” and “authentication failed” into one message.** These require different remedies.
7. **Do not expose internal runtime indices as durable addresses.** Hunk correctly makes hunk numbers CLI-facing and 1-based but returns zero-based indexes internally; pith’s pattern-group IDs should be semantic/stable across refresh rather than array positions.
8. **Do not let control-plane scope grow into artifact export.** Pith’s stated product contract is live co-review only; compact JSON responses should be ephemeral observation/command results, not an export subsystem.

## Review findings

- **High — `packages/session-broker-core/src/brokerState.ts:510-607`:** delivered mutating commands can time out without delivery certainty or idempotency, making retries capable of duplicate side effects.
- **High when explicitly enabled — `src/session/broker/brokerConfig.ts:48-71`:** unsafe remote mode exposes plaintext HTTP/WebSocket beyond loopback; signatures do not provide confidentiality.
- **Medium — `src/session/broker/credentials.ts:29-46,275-301` + `src/session/broker/brokerServer.ts:614`:** a long-lived broad caller credential plus allow-all app authorization makes same-user credential possession equivalent to full live-session control.
- **Medium — `src/session/client/daemonHttp.ts:7-54` + `src/session/broker/brokerServer.ts:372-416`:** the 5-second caller timeout is shorter than the 30-second reload/batch broker timeout, increasing unknown outcomes.
- **Medium — `src/session/broker/brokerLauncher.ts:302-318,528-602`:** fixed-port discovery has an unavoidable local availability/foreign-listener collision mode, though authenticated negotiation prevents trusting it as authority.
- **No blocker for research use:** source provides a complete lifecycle, selector, CLI, batch, failure, and security picture at the attested commit.

## Residual research risks

- The checkout is a single master snapshot; released binaries may lag or differ. The source commit is pinned above so the conclusions are reproducible.
- The repository’s `docs/session-broker-sdk.md` explicitly describes a target/migration contract; this report used running implementation files for current behavior and did not treat future random-endpoint/coordinator or delivery-certainty language as shipped behavior.
- A focused test command could not load `zod` because this shallow research clone had no installed workspace dependencies; source-surface and selector tests did run, and CLI help generation ran successfully.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete severity-tagged findings cite exact Hunk source paths/lines in the Review findings section; remaining uncertainty is listed under Residual research risks."
    }
  ],
  "changedFiles": [
    "/tmp/pith-research/r6-hunk-control-plane.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git clone --depth 1 https://github.com/modem-dev/hunk /tmp/pith-src/hunk",
      "result": "passed",
      "summary": "Cloned and pinned Hunk at 2454101d326fc0513e40e38c47a6a945b4b733b1."
    },
    {
      "command": "bun src/main.tsx session --help && bun src/main.tsx session comment apply --help",
      "result": "passed",
      "summary": "Generated the complete session command overview and batch stdin help from source."
    },
    {
      "command": "bun test src/session/agent/surface.test.ts src/session/protocolSchemas.test.ts packages/session-broker-core/src/selectors.test.ts",
      "result": "failed",
      "summary": "13 tests passed; protocolSchemas.test.ts could not resolve the uninstalled zod package in the research clone."
    },
    {
      "command": "python3 Markdown acceptance checks; git -C /tmp/pith-src/hunk status --short and rev-parse HEAD",
      "result": "passed",
      "summary": "Validated report structure/final gist/94 primary-source citations and confirmed the source clone is clean and pinned."
    }
  ],
  "validationOutput": [
    "Hunk source checkout remained clean after inspection.",
    "Session help listed all 14 daemon actions represented in the source manifest.",
    "13 focused source-surface and selector tests passed; one suite was dependency-blocked."
  ],
  "residualRisks": [
    "Released Hunk binaries may differ from the pinned master commit.",
    "Full protocol-schema tests were not runnable without installing clone dependencies."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added one external research Markdown report; made no changes to the pith repository.",
  "reviewFindings": [
    "high: packages/session-broker-core/src/brokerState.ts:510-607 - mutation timeouts lack idempotency and delivery certainty.",
    "high-when-enabled: src/session/broker/brokerConfig.ts:48-71 - unsafe remote mode exposes plaintext non-loopback control transport.",
    "medium: src/session/broker/credentials.ts:29-46,275-301 - broad ten-year shared caller authority makes same-user credential access equivalent to control.",
    "medium: src/session/client/daemonHttp.ts:7-54 - 5s outer timeout undercuts 30s reload/batch timeout."
  ],
  "manualNotes": "Primary-source-only report based on actual cloned source; no current-working-directory repository files were touched."
}
```

One-line gist: Hunk routes signed CLI HTTP actions through one auto-spawned fixed-port loopback daemon to UUID-identified TUI WebSocket producers, a useful model for pith if pith adds narrower capabilities, unambiguous discovery, and idempotent delivery-aware mutations.
