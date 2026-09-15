# gyst

Keyboard-centric agent/human co-review TUI.

## Local gate

Use Bun 1.4.2. Crust is unpublished; point `CRUST_CHECKOUT` at a checkout of
`38e7298954c60ec0a45dcfa830b515b2bc32ece0` before setting up gyst:

```sh
export CRUST_CHECKOUT=/path/to/crust
(
  cd "$CRUST_CHECKOUT"
  bun install --frozen-lockfile
  bunx turbo run build --filter=@crustjs/core --filter=@crustjs/extensions --filter=@crustjs/skills...
  bun run --cwd packages/crust build:cli
)

bun run setup:crust
bun install --frozen-lockfile
bun run check
```

`bun run check` lints with oxlint, checks formatting with oxfmt, enforces the
pure-core import boundary, typechecks and tests all workspaces, then compiles
and runs the actual `apps/gyst/dist/gyst` executable. The final smoke runs bare `gyst`,
`gyst --help`, and `gyst session --help`; it fails unless the compiled binary
loads OpenTUI's native library, renders a Solid frame, exits cleanly, and prints
help generated from the crust command tree. `bun run check:fix` applies lint
and format fixes.

## Local build

```sh
bun run --cwd apps/gyst build
./apps/gyst/dist/gyst --help
```

## Distribution

The root `@gyst/cli` package and its platform-specific optional-dependency
packages are published. `crust build --package` stages them under the app's
`dist/npm`; the root's optional dependencies let npm select the platform
package. Platform packages contain a
standalone Bun-compiled `gyst`, not a JavaScript CLI that requires Bun.

Local dry run for the current machine:

```sh
cd apps/gyst
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=bun-linux-x64-baseline ;;
  Darwin-arm64) target=bun-darwin-arm64 ;;
  *) echo "unsupported package-smoke host" >&2; exit 1 ;;
esac
bun run package -- --target "$target"
bun run package:smoke
bun run publish -- --dry-run
```

The smoke packs and inspects both tarballs, installs them globally under a
temporary prefix, confirms no wrong-platform package appeared, removes Bun
from `PATH`, and runs `gyst --help` through the packed resolver.

### First prerelease

One-time repository setup: create an npm automation token allowed to publish
`@gyst/*` and save it as the GitHub Actions secret `NPM_TOKEN`. Then, from a
clean `main` checkout:

```sh
# 1. Set apps/gyst/package.json version to the intended prerelease, for example
#    0.1.0-alpha.0, and run the local gate above plus `bun run check`.
git add apps/gyst/package.json bun.lock
git commit -m "chore: release 0.1.0-alpha.0"
git push origin main

# 2. The tag must exactly be v<package version>; pushing it starts release.yml.
git tag v0.1.0-alpha.0
git push origin v0.1.0-alpha.0

# 3. Wait for the run for this commit, then watch both host smokes and publication.
for _ in {1..24}; do
  run_id=$(gh run list --repo chenxin-yan/gyst --workflow release.yml --commit "$(git rev-parse HEAD)" --limit 1 --json databaseId --jq '.[0].databaseId')
  [[ -n "$run_id" ]] && break
  sleep 5
done
test -n "$run_id"
gh run watch "$run_id" --repo chenxin-yan/gyst

# 4. Verify the npm dist-tag and GitHub assets after the workflow succeeds.
npm view @gyst/cli@next version
npm install -g @gyst/cli@next
gyst --help
gh release view v0.1.0-alpha.0 --repo chenxin-yan/gyst
```

The tag workflow rejects `0.0.0` and mismatched tags, runs both host package
smokes, publishes platform packages before the root via `crust publish`, uses
version-aware `next`/`latest` npm tags so older runs cannot move a channel
backward, and creates a GitHub prerelease containing
all raw binaries, the POSIX/Windows resolvers, the authored skill archive, and
the MIT license.
Stable versions publish without an override (npm's `latest`). There is no curl
installer or self-update; update through npm or replace the release binary.

## License

[MIT](LICENSE)
