# gyst

Keyboard-centric agent/human co-review TUI.

## Local gate

Bun's version comes from `packageManager` in `package.json`; `mise` reads it too.

```sh
bun install --frozen-lockfile
bun run check  # oxlint, oxfmt, typecheck
bun run test   # workspace tests
```

`bun run check:fix` applies lint and format fixes.

## Local build

```sh
bun run --cwd apps/gyst build
./apps/gyst/.crust/linux-x64/bin/gyst-bun-linux-x64 --help   # or darwin-arm64/..., see .crust/manifest.json
```

`crust build` stages the npm packages under `apps/gyst/.crust/`: `root/` holds
`@gyst/cli` with its Node launcher `bin/gyst.js` and the packaged skills,
and each `<os>-<arch>/` directory holds the platform package with the compiled
`bin/gyst-bun-<os>-<arch>` binary. `manifest.json` indexes them. `build`
stages the current machine (`--target host`); `build:release` stages the six
published targets.

## Docs

`bun run dev:docs` serves the fumadocs site in `apps/docs`; `bun run build:docs` builds it.
Deploy is manual (`bun run --cwd apps/docs deploy`) until Cloudflare is set up.

## Distribution

The root `@gyst/cli` package and its platform-specific optional-dependency
packages are published from `.crust/`; the root's optional dependencies let npm
select the platform package. Platform packages contain a standalone
Bun-compiled `gyst`, not a JavaScript CLI that requires Bun.

The build is configured by the `crust` block in `apps/gyst/package.json`:
`crust.bunPlugins` lists `@opentui/solid/bun-plugin` so the Solid JSX
transform is applied at compile time; `bun src/index.tsx`, `bun test`, and
crust's build-time validation run of the entry get the same transform from the
`bunfig.toml` preload. The six published targets are the glibc Linux, macOS,
and Windows binaries; musl/Alpine is not published.

Local dry run for the current machine:

```sh
cd apps/gyst
bun run build
bun run package:smoke
bun run release -- --dry-run
```

The smoke packs and inspects both tarballs, installs them globally under a
temporary prefix, confirms no wrong-platform package appeared, removes Bun
from `PATH`, and runs `gyst --help` through the packed Node launcher.

### First prerelease

One-time npm setup: publishing uses npm trusted publishing (OIDC), not a
stored token. On npmjs.com, add a GitHub Actions trusted publisher with
repository `chenxin-yan/gyst` and workflow `release.yml` to each of the seven
packages: `@gyst/cli`, `@gyst/cli-linux-x64`, `@gyst/cli-linux-arm64`,
`@gyst/cli-darwin-x64`, `@gyst/cli-darwin-arm64`, `@gyst/cli-windows-x64`,
and `@gyst/cli-windows-arm64`. npm only lets you configure a trusted publisher
on a package that already exists, so bootstrap each package once by hand from
a shell where `npm whoami` succeeds, using a throwaway prerelease version that
no tag will ever reuse:

```sh
# apps/gyst/package.json version: 0.0.1-bootstrap.0 (do not commit)
cd apps/gyst
bun run build:release
bun run release -- --tag bootstrap
```

Configure the seven trusted publishers, revert the version edit, then, from a
clean `main` checkout:

```sh
# 1. Set apps/gyst/package.json version to the intended prerelease, for example
#    0.1.0-alpha.0, refresh the lockfile, and run the frozen-install gate above.
bun install --lockfile-only
bun run check
git add apps/gyst/package.json bun.lock
git commit -m "chore: release 0.1.0-alpha.0"
git push origin main

# 2. The tag must exactly be v<package version>; pushing it starts release.yml.
#    Push one release tag at a time and wait for its run: publish jobs share one
#    concurrency group and GitHub keeps only the newest pending run, so a second
#    tag pushed while one is still queued drops the intermediate one.
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
backward, and creates a GitHub prerelease containing the six raw binaries, the
authored skill archive, and the MIT license.
Stable versions publish without an override (npm's `latest`). There is no curl
installer or self-update; update through npm or replace the release binary.

A partially completed publish is not safely rerunnable: `crust publish` stops
on the first package whose version already exists on npm, and `gh release
create` fails if the release exists. Inspect `npm view @gyst/cli-<platform>
versions` for every platform package and the GitHub release before retrying
a failed run; do not push a second tag for the same version. Skipping an
already-published `name@version` belongs upstream in `crust publish`, so until
it lands a rerun after a partial publish needs the remaining packages published
manually.

## License

[MIT](LICENSE)
