# gyst

## Working in this repo

- `bun run check` is the gate: oxlint, oxfmt, the pure-core import boundary, types, tests, and the
  compiled-binary smoke. `bun run check:fix` applies lint and format fixes.
- Test placement: `packages/core` tests live in `packages/core/test/`, outside `src`, so core source
  typechecks without ambient Bun types. App tests sit next to their source as `*.test.ts`. Root
  scripts test in `scripts/*.test.ts`. TUI smokes are `*smoke.tsx` files run explicitly by a
  script, never discovered by `bun test`.
- Change docs (`README.md`, `CONTEXT.md`, `docs/`) in the same commit as the behaviour they
  describe.
- Commit subjects follow Conventional Commits (`feat:`, `fix:`, `build:`, `ci:`, `docs:`, `style:`,
  `chore:`), with an optional scope.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`chenxin-yan/gyst`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
