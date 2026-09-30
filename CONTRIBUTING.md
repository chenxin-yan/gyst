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

`build` builds the browser viewer (`apps/web`) into `apps/web/dist/`, copies it to
`apps/gyst/dist/web-ui/`, then runs [`crust build`](https://crustjs.com/docs/guide/build-and-distribution) for a Node
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

The viewer is the private [`@gyst/web`](apps/web/) package, a client-rendered React app
bootstrapped with `@tanstack/cli create --router-only --blank` (file-based TanStack Router, no
SSR). Routes live in `apps/web/src/routes/`; the router plugin regenerates the committed
`src/routeTree.gen.ts` on `dev` and `build`. It imports browser-safe contracts only from
`@gyst/core/wire` and the shared HTTP paths from `@gyst/core/web`. `@gyst/cli` ships only the
built `dist/`, so the published package does not depend on React or the router. The launcher
serves the installed `dist/web-ui/`. `pnpm --dir apps/web dev` serves the viewer with Fast
Refresh but no daemon behind it, so its pages show the request error.

`pnpm test` includes browser tests (`apps/gyst/tests/e2e/browser.test.ts`) that drive the
installed package, its real launches, daemon and a private key-authenticated SSH local forward on
127.0.0.1 from a sandboxed Chromium. They need Google Chrome (or
`CHROMIUM_PATH=/path/to/chromium`), git and OpenSSH (`sshd`, `ssh` and `ssh-keygen` on `PATH`, or
`sshd` in `/usr/sbin`). Their scratch directory lives under `$HOME`, since sshd's `StrictModes`
rejects a world-writable `/tmp` ancestor, and is removed after.

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
