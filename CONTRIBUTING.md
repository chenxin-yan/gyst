# Contributing

Run commands from the repository root. [mise](https://mise.jdx.dev) installs the Node.js and
pnpm versions pinned in [`mise.toml`](mise.toml) (`mise install`). Bun is not used.

## Develop

```sh
pnpm install
pnpm exec vp run check
pnpm exec vp run test
```

Commands are [Vite+ tasks](https://viteplus.dev/guide/run) defined in
[`vite.config.ts`](vite.config.ts) and [`apps/gyst/vite.config.ts`](apps/gyst/vite.config.ts);
with a global `vp`, drop the `pnpm exec`. `check` runs formatting, lint and type checks
(`vp check --fix` fixes formatting and lint issues) and is cached. `test` runs Vitest: the `unit`
project, and the `installed` project, which builds the CLI, packs it and installs it globally
with npm into a temporary prefix. `pnpm exec vp test --project unit` skips that. Run both checks
and tests before opening a PR.

## Build

```sh
pnpm exec vp run @gyst/cli#build
node apps/gyst/dist/index.mjs --help
```

`build` bundles the CLI with `vp pack` into `apps/gyst/dist/` (the private `@gyst/core`
workspace is bundled; npm dependencies stay external), then renders the packaged skills into
`apps/gyst/.crust/root/skills/` and copies the README beside them. Unchanged inputs replay from
the task cache. Pack and install it to try the release artifact outside the checkout:

```sh
pnpm --dir apps/gyst pack --pack-destination /tmp/gyst-pack
npm install -g --prefix /tmp/gyst-prefix /tmp/gyst-pack/gyst-cli-*.tgz
/tmp/gyst-prefix/bin/gyst --help
```

## Releases

For changes to the CLI, add a changeset and commit the generated file:

```sh
pnpm exec changeset
```

Merging the change opens or updates the release PR. Merging that PR publishes the
`@gyst/cli` npm package, creates the Git tag and GitHub Release, and attaches
the skills archive and the license. Do not bump versions or create release tags by hand.

For prereleases, use `pnpm exec changeset pre enter <tag>`; publication uses that npm
dist-tag. The [release workflow](.github/workflows/release.yml) owns the automation.

### Maintainer setup (once)

- Enable **Allow GitHub Actions to create and approve pull requests** in repository settings.
- Configure npm trusted publishing on `@gyst/cli`: repository `chenxin-yan/gyst`,
  workflow `release.yml`, no environment restriction, with direct publishing allowed.
