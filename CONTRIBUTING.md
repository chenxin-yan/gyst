# Contributing

Run commands from the repository root. Node.js and pnpm are pinned once in
[`package.json`](package.json)'s `devEngines`. [`mise.toml`](mise.toml) enables mise's
[idiomatic version files](https://mise.jdx.dev/lang/node.html#package-json), so `mise install`
and GitHub Actions' `mise-action` read the same pins. Use `mise ls --current` to inspect them.

`onFail: "ignore"` leaves tool installation to mise rather than
[pnpm's runtime/package-manager management](https://pnpm.io/package_json#devenginesruntime).
Activate mise in your shell or prefix commands with `mise exec --`. Gyst runs on Node;
Crust's build tool embeds Bun, so no separate Bun installation is needed.

## Develop

```sh
pnpm install
pnpm check
pnpm test
```

Commands are `package.json` scripts. Scripts worth caching call a `<name>:task`
[Vite+ task](https://viteplus.dev/guide/run) in [`vite.config.ts`](vite.config.ts) or
[`apps/gyst/vite.config.ts`](apps/gyst/vite.config.ts). `check` runs formatting, lint and type
checks (`pnpm exec vp check --fix` fixes formatting and lint issues) and is cached. `test` runs
`test:unit` and `test:e2e` in parallel. `test:unit` covers the unit and integration tests beside
the code and is cached. `test:e2e` builds the CLI, packs it, installs it globally with npm into a
temporary prefix and tests that install; it is never cached. Run both checks and tests before
opening a PR.

## Build

```sh
pnpm build
node apps/gyst/.crust/root/bin/gyst.js --help
```

`build` builds the browser viewer with `vp build src/web-ui` into `apps/gyst/dist/web-ui/`,
then runs [`crust build`](https://crustjs.com/docs/guide/build-and-distribution) for a Node
runtime package. Crust bundles the CLI and its dependencies, invokes the skills extension's
build hook, copies `dist/web-ui/` through `crust.include`, and stages the package in
`apps/gyst/.crust/root/`. Vite+ caches the build and copies the repository README/LICENSE before
it. `publishConfig.directory` points pnpm and Changesets at Crust's output; no custom publisher or
skill-generation script is needed.

Pack and install it to try the release artifact outside the checkout:

```sh
pnpm --dir apps/gyst pack --pack-destination /tmp/gyst-pack
npm install -g --prefix /tmp/gyst-prefix /tmp/gyst-pack/gyst-cli-*.tgz
/tmp/gyst-prefix/bin/gyst --help
```

## Browser viewer

The viewer in [`apps/gyst/src/web-ui/`](apps/gyst/src/web-ui/) is a client-rendered React app
with a standalone TanStack Router route tree, built by Vite+'s native JSX transform (no React
plugin, Fast Refresh, SSR or hydration). It imports browser-safe contracts only from
`@gyst/core/wire` and the shared HTTP paths from `apps/gyst/src/web/contract.ts`. React and the
router are devDependencies bundled into `dist/web-ui/`, so the published package does not
depend on them. The launcher serves the installed `dist/web-ui/`; there is no separate dev
server backed by a daemon.

After `pnpm build`, check the built viewer in a real sandboxed Chromium against a mocked
launcher (this is a component check, not an installed-product test):

```sh
CHROMIUM_PATH=/path/to/chromium node apps/gyst/scripts/check-web-ui.mjs
```

It uses `playwright-core` with your Chromium executable, keeps Chromium's sandbox on, and writes
`gyst-web-ui-{desktop,narrow}.png` screenshots to the temporary directory.

The installed-product check builds, packs and privately installs the package, then drives real
foreground `gyst` launches, their daemon and a private key-authenticated SSH local forward on
127.0.0.1 from a real sandboxed Chromium. It needs git and OpenSSH (`sshd`, `ssh`, `ssh-keygen`
in `SSH_BIN_DIR`, default `/run/current-system/sw/bin`), creates its scratch directory under
`$HOME` (sshd's `StrictModes` rejects a world-writable `/tmp` ancestor), and removes it after:

```sh
CHROMIUM_PATH=/path/to/chromium node apps/gyst/scripts/check-installed-browser.mjs
```

`CHECK_INJECT=fail-after-ssh` or `CHECK_INJECT=launch-timeout` makes it fail on purpose, to
confirm that it still stops every process it started; it then exits 1 with an empty
`cleanup.failures` and `cleanup.leftoverPids`.

Neither browser check runs in CI; `pnpm test` covers the installed CLI without a browser.

To try the viewer over SSH, see the README's [Over SSH](README.md#over-ssh) section.

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
