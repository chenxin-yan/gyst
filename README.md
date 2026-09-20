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
bun install --frozen-lockfile --os='*' --cpu='*'    # every platform's native deps, needed to cross-compile
bun run --cwd apps/gyst build                       # the six published targets
bunx --cwd apps/gyst crust build --target host      # just this machine, faster
./apps/gyst/.crust/linux-x64/bin/gyst-bun-linux-x64 --help   # or darwin-arm64/..., see .crust/manifest.json
```

`crust build` stages the npm packages under `apps/gyst/.crust/`: `root/` holds
`@gyst/cli` with its Node launcher `bin/gyst.js` and the agent skills (authored in
`apps/gyst/skills/`, plus the generated `gyst-cli` command reference),
and each `<os>-<arch>/` directory holds the platform package with the compiled
`bin/gyst-bun-<os>-<arch>` binary. `manifest.json` indexes them. The
`prebuild` hook copies the repository `LICENSE` and `README.md` into
`apps/gyst/` (gitignored) so `crust build` ships them in the packages.

## Distribution

The root `@gyst/cli` package and its platform-specific optional-dependency
packages are published from `.crust/`; the root's optional dependencies let npm
select the platform package. Platform packages contain a standalone
Bun-compiled `gyst`, not a JavaScript CLI that requires Bun.

The build is configured by the `crust` block in `apps/gyst/package.json`:
`crust.bunPlugins` lists `@opentui/solid/bun-plugin` so the Solid JSX
transform is applied at compile time; `bun src/index.tsx`, `bun test`, and
crust's build-time validation run of the entry get the same transform from the
`bunfig.toml` preload. `crust.targets` lists the six published targets, the
glibc Linux, macOS, and Windows binaries, so a bare `crust build` stages exactly
those; musl/Alpine is not published because OpenTUI selects its musl native
only through `OPENTUI_LIBC` at run time.

Local dry run:

```sh
cd apps/gyst
bun run build
bun run release -- --dry-run   # crust publish order, nothing written
```

### Releasing

Releases follow [changesets](https://changesets.dev): a PR that changes `@gyst/cli`
adds a changeset, the merge opens (or updates) a `chore: release @gyst/cli` PR, and
merging that PR publishes. Versions move only through that PR.

```sh
bun run changeset        # pick the bump, describe the change; commit the .changeset/*.md file
```

`release.yml` runs `check` on every push to `main`, then:

- with pending changesets, `changesets/action/version` runs `release:version`
  (`changeset version` + lockfile refresh) and pushes the release PR;
- with none pending and a version not yet on npm, it stages every platform package
  and `changesets/action/publish` runs
  `release:publish`: `crust publish` (platform packages before the root, versions
  already on the registry skipped, so a rerun after a partial failure finishes the
  cohort), then `changeset git-tag`, from which the action pushes the
  `@gyst/cli@<version>` tag and creates the GitHub release with the changelog entry.
  The six raw binaries, the skills archive, and the MIT license are attached to it.

Prerelease mode (`bun run changeset pre enter <tag>`) publishes under that npm
dist-tag; stable versions publish to `latest`. There is no curl installer or
self-update; update through npm or replace the release binary.

One-time setup: enable **Allow GitHub Actions to create and approve pull requests**
(Settings → Actions → General), and give each of the seven packages (`@gyst/cli` and
`@gyst/cli-{linux,darwin,windows}-{x64,arm64}`) a GitHub Actions trusted publisher on
npmjs.com for repository `chenxin-yan/gyst` and workflow `release.yml`. npm only
accepts a trusted publisher on an existing package, so a brand-new package is
published once by hand from a shell where `npm whoami` succeeds.

## License

[MIT](LICENSE)
