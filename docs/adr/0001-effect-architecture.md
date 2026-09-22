# ADR 0001: Effect as the application runtime

Status: accepted (2026-09-20).

## Context

Gyst is a per-user daemon plus a CLI and a TUI. The first implementation used Effect only for
`Schema` decoding; git, the socket daemon, persistence and the client were hand-written async code
with thrown payload objects, `Bun.spawn`, `Bun.listen` and `node:fs`. Nothing below the compiled
binary was testable in isolation, and every concurrency guarantee (single daemon instance, serialised
mutations, idle shutdown) was a bespoke mechanism.

## Decision

Capabilities are Effect services composed with layers; crust stays the process runtime through its
Effect adaptor.

- **Effect v4** (`effect@4.0.0-rc.116`, `@effect/platform-bun` at the same version, pinned exactly).
  `@crustjs/effect` requires v4, and a second copy of `effect` breaks service identity, so the range is
  exact and every package resolves the one copy.
- **Services** (`Context.Service` + `static layer`): `Paths` (Config), `Git` (`ChildProcessSpawner`),
  `SessionStore` (`FileSystem`), `Sessions` (the use cases: one `Semaphore`, an idle `Latch`),
  `DaemonServer` (`effect/unstable/socket` `SocketServer`), `DaemonClient` (`Socket`, `Schedule`).
  Platform layers (`BunServices`) are provided once at the crust command edge; inner services never
  import `@effect/platform-bun` except the two socket adapters.
- **crust boundary**: commands are `handler()` actions; `layer("daemonClient", …)` on the `session`
  command and `layer("daemonServer", …)` on the hidden `daemon run`; unprovided services are a compile
  error. The TUI owns one `ManagedRuntime` over `DaemonClient` for its lifetime; Solid stays imperative
  behind the `TuiClient` Promise interface.
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
  guard is review, not the compiler: a `types: []` tsconfig was tried and dropped because it forced a
  second tsconfig for the tests and a `declare const Bun` shim for the one hash call.

## Consequences

- `Sessions` is unit-tested over `Layer.succeed` doubles; the compiled-binary e2e keeps only what
  needs the seam (spawn, persistence across kill, socket reclaim, large frames, source-mode start).
- Two `unstable/` modules (`process`, `socket`) are in the dependency surface; bump deliberately.
- The compiled binary carries the Effect runtime; v4 is roughly a third of v3's size.
- Contributors need services, layers and `Effect.gen`; core and Solid stay approachable.

## Sources

- Effect v4 migration notes: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- crust Effect adaptor docs: crust `apps/docs/content/docs/modules/effect.mdx`
- Verified against `effect@4.0.0-rc.116` and `@effect/platform-bun@4.0.0-rc.116` source and declarations.
