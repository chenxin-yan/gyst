# ADR 0001: Effect as the application runtime

Status: accepted (2026-09-20); platform and UI assumptions revised by the
[web review handoff](../plans/web-review-ui.md); the foreground bridge and its per-launch login are
replaced by [ADR 0002](0002-daemon-serves-the-viewer.md). The Node/web target below is an accepted plan,
not a claim that the current Bun/TUI implementation has migrated.

## Context

Gyst is a per-user daemon plus a CLI and, in the revised target, a foreground web client. The first implementation used Effect only for
`Schema` decoding; git, the socket daemon, persistence and the client were hand-written async code
with thrown payload objects, `Bun.spawn`, `Bun.listen` and `node:fs`. Nothing below the compiled
binary was testable in isolation, and every concurrency guarantee (single daemon instance, serialised
mutations, idle shutdown) was a bespoke mechanism.

## Decision

Capabilities are Effect services composed with layers; crust stays the process runtime through its
Effect adaptor.

- **Effect v4**, pinned exactly with compatible Node platform adapters; workspace manifests own the
  selected version. `@crustjs/effect` requires v4, and a second copy of `effect` breaks service identity,
  so every package resolves the one copy. Replace Bun platform services rather than retaining a second
  runtime. Verify the selected Node adapter interfaces against their installed source when porting.
- **Services** (`Context.Service` + `static layer`): `Paths` (Config), `Git` (`ChildProcessSpawner`),
  `SessionStore` (`FileSystem`), `Sessions` (the use cases: one `Semaphore`, an idle `Latch`),
  `DaemonServer` (`effect/unstable/socket` `SocketServer`), `DaemonClient` (`Socket`, `Schedule`).
  Platform layers are provided at process entry points; platform-specific I/O stays in adapters.
  The daemon owns review mutations and persistence. Source acquisition, captured inputs and disposable
  analysis remain separate from mutable review state, without speculative storage/hosting adapters.
- **crust boundary**: commands are `handler()` actions; `layer("daemonClient", …)` on the `session`
  command and `layer("daemonServer", …)` on the hidden `daemon run`; unprovided services are a compile
  error. Keep compatible command/skill handling but replace the Bun-dependent builder/publisher.
  The foreground Node process serves the React SPA and bridges HTTP/SSE to the Unix-socket daemon;
  it does not own another review store. CLI parsing and browser transport adapt to shared structured
  review operations. The TUI, Solid and `TuiClient` are removed, not ported.
- **Errors**: one `Schema.TaggedError` per `ErrorCode` in core; on the wire and on stderr the shape
  stays `{code, message, detail?}` through a single `Schema.decodeTo` bridge (`ErrorPayloadSchema`).
  Anything outside that union is a defect and leaves as `internal_error`; only crust's own parse,
  validation and command-not-found verdicts are `bad_args`. Cancellation is crust's: Ctrl-C aborts the invocation
  signal, `handler()` interrupts the fiber, exit 130 with no JSON; the daemon reacts to SIGTERM only.
  A finalizer failing after a rendered error adds crust's `Cleanup failed:` lines after the JSON.
- **Single instance**: the daemon listens on `daemon.sock.<pid>` and publishes it with an atomic hard
  link to `daemon.sock`. A starter that finds the link taken probes it: a live daemon answers and the
  starter exits; a stale file is removed only if its inode is unchanged since the probe. Ownership is
  the inode; a one-second poll ends a daemon that lost the path and heals `daemon.pid`. `server.close()`
  unlinks only the private name, so a loser never removes the winner's socket. (Rejected: socket path as
  lock with rename reclaim — `node:net` unlinks the bound path on close, so an orphan's exit unlinked
  the rival's live socket; pid-file `wx` lock — read-then-remove of a stale lock is a TOCTOU.)
- **core stays pure by convention**: schemas, tagged errors, `parseSnapshot`/`statusOf`/`applyBatch`/
  `refreshSession`/`applyHumanAction` as plain functions returning `Result`. No Effect runtime, no
  platform I/O, no persisted-format migration (gyst is unreleased; the schema is the contract). The
  guard is review, not a second runtime-specific tsconfig. Replace Bun-specific hashing as part of the
  Node migration; old saved-session hash identity is not a compatibility requirement.

## Consequences

- `Sessions` remains tested over `Layer.succeed` doubles; packaged global-npm integration checks cover
  real process/transport behavior (spawn, persistence across kill, socket reclaim and large frames).
  Browser checks cover the HTTP/SSE bridge and installed SPA; fixture spikes do not verify this port.
- The `unstable/` process/socket dependency surface still warrants deliberate version bumps.
- Node/npm and Vite+ replace compiled Bun binaries and Bun build/test/release tooling. The
  [handoff](../plans/web-review-ui.md#runtime-and-packaging) owns runtime/platform bounds and release gates.
- Contributors need services, layers and `Effect.gen`; pure core and React rendering stay approachable.
  Future hosting reuses review operations/UI but still requires real remote authentication, source
  provisioning and isolation; local tokens are not a multi-tenant security model.

## Sources

- Effect v4 migration notes: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- crust Effect adaptor docs: crust `apps/docs/content/docs/modules/effect.mdx`
- Original Bun decision verified against `effect@4.0.0-rc.116` and matching Bun platform source;
  this is historical evidence, not the current dependency pin or verification of Node adapters.
- [Runtime and distribution](https://github.com/chenxin-yan/gyst/issues/73#issuecomment-5849387828)
- [Hosted-ready architecture seams](https://github.com/chenxin-yan/gyst/issues/74#issuecomment-5851460434)
- [Spike: serve the React SPA from gyst's distributable](https://github.com/chenxin-yan/gyst/issues/75#issuecomment-5852481515): fixture packaging evidence only.
