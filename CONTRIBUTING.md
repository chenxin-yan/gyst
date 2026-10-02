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
serves the installed `dist/web-ui/`.

### Run it from source

```sh
pnpm dev
```

This starts the Vite dev server with a real gyst launcher and daemon running from source behind it.
Nothing is built. It prints one URL:

```
  gyst  http://g-<hex>.localhost:3000/session/<id>#<secret>
```

Open that URL. Vite's own `http://localhost:3000/` links are deliberately not printed: the
launcher refuses any host but its launch hostname, so they only return 403.

How it works: the dev-only plugin in [`apps/web/dev-launcher.ts`](apps/web/dev-launcher.ts) runs
`node apps/gyst/src/index.ts` (Node runs the TypeScript directly) and proxies the bridge paths
(`/bootstrap`, `/api/operation`) to it with their `Host` and `Origin` unchanged. The browser
opens the launch's `g-<hex>.localhost` hostname on Vite's port, just as it would behind an SSH
forward, so sign-in, the cookie and the host and origin checks run as in production. Vite serves
everything else, so viewer edits apply with Fast Refresh. The launcher starts the daemon as usual.

- **What it reviews:** by default, the uncommitted changes of a demo repository built in
  `.dev/demo` from [`apps/gyst/tests/demo-repo.ts`](apps/gyst/tests/demo-repo.ts), the same
  fixture the browser tests use. Set `GYST_DEV_RANGE` to review a range of it, such as
  `GYST_DEV_RANGE=stress~1...stress pnpm dev` (400 changed files) or `main...feature`. Set
  `GYST_DEV_REPO=/path/to/repo` to review another repository.
- **Where state lives:** sessions are saved in `.dev/data` (`GYST_DATA_DIR`), never your own
  gyst data, and persist across runs. `rm -rf .dev` starts over and rebuilds the demo.
- **After changing `apps/gyst` or `packages/core`:** press `r` in the dev server. Vite reruns the
  plugin, which replaces the daemon and launcher with ones from the current source and prints a
  new URL. The old URL then fails sign-in, because every launch has its own hostname and
  credentials. A changed `vite.config.ts` or `dev-launcher.ts` restarts it the same way.
- **Signing in again:** a launch URL signs in only within 10 minutes of its launch. After that,
  press `r` for a new one. Reloading an already signed-in tab keeps working.
- **Stopping:** Ctrl-C stops Vite and the launcher. The daemon outlives them, as it does in
  production, and the next `pnpm dev` replaces it.
- **Placeholder viewer:** the source launcher needs an `index.html` where the package keeps the
  built viewer, so the plugin writes a placeholder to the git-ignored
  `apps/gyst/src/dist/web-ui/`. Vite serves the real viewer.

This checks behaviour by hand. It is not a substitute for `pnpm test`, which tests the packed
npm install.

Viewer styles use [StyleX](https://stylexjs.com/docs/learn/): each component calls
`stylex.create` and `stylex.props` in its own file, and colours, fonts and the narrow-layout media
query come from `src/tokens.stylex.ts`. Give a child its variants through props or composed styles
(or `stylex.when.*` for hover-driven ones) rather than descendant selectors, and share a styled
piece as a component, since styles imported from another file need the StyleX runtime.
`src/styles.css` holds only element resets and globals, in `@layer reset` so any StyleX style
beats them. `pnpm check` runs StyleX's `valid-styles` and `no-unused` lint rules; TypeScript does
not check style keys or values. The browser tests find elements by role, text or structure,
because StyleX class names are hashed.

The session reader renders diffs with [`@pierre/diffs`](https://diffs.com) (its React `CodeView`).
Its markup and stylesheet live in each file's open shadow root, in the renderer's own `base`,
`theme`, `rendered` and `unsafe` layers, so none of its CSS enters the page cascade and the page's
layer order stays `reset`, then StyleX's. Style it only through its documented inputs: the
`--diffs-*` custom properties, set with StyleX on the `CodeView` root from our tokens (they
inherit into the shadow roots), the `theme` options, and `unsafeCSS` for the file box's `:host`
alone. Our file headers are slotted light DOM, styled with StyleX like any component. Never query
or style inside its shadow roots, and use only its public API.

`pnpm test` includes browser tests (`apps/gyst/tests/e2e/browser.test.ts`) that drive the
installed package, its real launches, daemon and a private key-authenticated SSH local forward on
127.0.0.1 from a sandboxed Chromium. They need Google Chrome (or
`CHROMIUM_PATH=/path/to/chromium`), git and OpenSSH (`sshd`, `ssh` and `ssh-keygen` on `PATH`, or
`sshd` in `/usr/sbin`). Their scratch directory lives under `$HOME`, since sshd's `StrictModes`
rejects a world-writable `/tmp` ancestor, and is removed after.

CI runs them with the Google Chrome preinstalled on GitHub's `ubuntu-latest` runner image, which
also has git and OpenSSH, so the workflow installs nothing extra. mise does not manage a browser.
Where Chrome isn't installed, point `CHROMIUM_PATH` at any Chromium. On Nix, for example:

```sh
CHROMIUM_PATH="$(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium" pnpm test:e2e
```

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

Every commit publishes a preview of the built CLI to [pkg.pr.new](https://pkg.pr.new)
(`npx https://pkg.pr.new/@gyst/cli@<pr|sha|branch>`) and PRs get a comment with the command. The
[preview workflow](.github/workflows/preview.yml) owns it; nothing reaches npm.

### Maintainer setup (once)

- Enable **Allow GitHub Actions to create and approve pull requests** in repository settings.
- Configure npm trusted publishing on `@gyst/cli`: repository `chenxin-yan/gyst`,
  workflow `release.yml`, no environment restriction, with direct publishing allowed.
- Install the [pkg.pr.new GitHub App](https://github.com/apps/pkg-pr-new) on `chenxin-yan/gyst`.
