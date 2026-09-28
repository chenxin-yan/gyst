# Contributing

Run commands from the repository root with Node.js `>=24.11.0 <25` and npm (see
`engines` and `packageManager` in [`package.json`](package.json)). Bun is not used.

## Develop

```sh
npm ci
npm run check
npm test
```

`check` runs formatting, lint and type checks through Vite+ (`vp check`); `npm run check:fix`
fixes formatting and lint issues. `npm test` runs Vitest (`vp test`): the `unit` project, and
the `installed` project, which first builds, packs and globally installs the CLI into a
temporary prefix. `npm test -- --project unit` skips that build. Configuration lives in
[`vite.config.ts`](vite.config.ts). Run both checks and tests before opening a PR.

## Build

```sh
npm run build
node apps/gyst/dist/cli.mjs --help
```

`build` bundles the CLI with `vp pack` into `apps/gyst/dist/` (the private `@gyst/core`
workspace is bundled; npm dependencies stay external), renders the packaged skills into
`apps/gyst/.crust/root/skills/`, and stages the publishable package in `apps/gyst/stage/`.
Pack and install that staged directory to try the release artifact outside the checkout:

```sh
mkdir -p /tmp/gyst-pack
npm pack ./apps/gyst/stage --pack-destination /tmp/gyst-pack
npm install -g --prefix /tmp/gyst-prefix /tmp/gyst-pack/gyst-cli-*.tgz
/tmp/gyst-prefix/bin/gyst --help
```

## Releases

For changes to the CLI, add a changeset and commit the generated file:

```sh
npm run changeset
```

Merging the change opens or updates the release PR. Merging that PR publishes the
staged `@gyst/cli` npm package, creates the Git tag and GitHub Release, and attaches
the skills archive and the license. Do not bump versions or create release tags by hand.

For prereleases, use `npm run changeset -- pre enter <tag>`; publication uses that npm
dist-tag. The [release workflow](.github/workflows/release.yml) owns the automation.

### Maintainer setup (once)

- Enable **Allow GitHub Actions to create and approve pull requests** in repository settings.
- Configure npm trusted publishing on `@gyst/cli`: repository `chenxin-yan/gyst`,
  workflow `release.yml`, no environment restriction, with direct publishing allowed.
