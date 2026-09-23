# Contributing

Run commands from the repository root. Use the Bun version in
[`package.json`](package.json) (`mise` reads it automatically).

## Develop

```sh
bun install --frozen-lockfile
bun run --cwd apps/gyst dev --help
bun run check
bun run test
```

`check` runs lint, formatting, and type checks. `bun run check:fix` fixes lint and
formatting issues. Run both checks and tests before opening a PR.

For editor lifecycle changes, also run the Linux PTY regression (Python 3 and Vim
must be available; artifacts go outside the repository):

```sh
python3 apps/gyst/tests/pty/editor.py --evidence /path/outside/repo/editor-pty
```

It exercises real OpenTUI/App handoff with fake editors and Vim, signals, resize,
input/poll gating, terminal restoration and child reaping. Cross-builds do not
substitute for macOS/Windows terminal runtime verification.

## Build

Build for your machine:

```sh
bun run --cwd apps/gyst build --target host
bun run --cwd apps/gyst start --help
```

Build all configured release targets and inspect the publish plan without publishing:

```sh
bun install --frozen-lockfile --os='*' --cpu='*'
bun run --cwd apps/gyst build
bun run --cwd apps/gyst release -- --dry-run
```

Output is in `apps/gyst/.crust/`. Targets and build settings live in
[`apps/gyst/package.json`](apps/gyst/package.json).

## Releases

For changes to the CLI, add a changeset and commit the generated file:

```sh
bun run changeset
```

Merging the change opens or updates the release PR. Merging that PR publishes the
platform packages and CLI, creates the Git tag and GitHub Release, and attaches
binaries, skills, and the license. Do not bump versions or create release tags by hand.

For prereleases, use `bun run changeset pre enter <tag>`; publication uses that npm
dist-tag. The [release workflow](.github/workflows/release.yml) owns the automation.

### Maintainer setup (once)

- Enable **Allow GitHub Actions to create and approve pull requests** in repository settings.
- Configure npm trusted publishing on `@gyst/cli` and all six platform packages:
  repository `chenxin-yan/gyst`, workflow `release.yml`, no environment restriction,
  with direct publishing allowed. New packages need an initial manual publish before
  npm allows this setup.
