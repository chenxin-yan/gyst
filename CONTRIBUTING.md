# Contributing

Run commands from the repository root. Node.js and pnpm are pinned once in
[`package.json`](package.json)'s `devEngines`. [`mise.toml`](mise.toml) enables mise's
[idiomatic version files](https://mise.jdx.dev/lang/node.html#package-json), so `mise install`
and GitHub Actions' `mise-action` read the same pins. Use `mise ls --current` to inspect them.

`onFail: "ignore"` leaves tool installation to mise rather than
[pnpm's runtime/package-manager management](https://pnpm.io/package_json#devenginesruntime).
That is why pnpm is pinned in `devEngines.packageManager` rather than the top-level
`packageManager` field: only `devEngines` carries that policy beside the version, and adding both
would pin pnpm twice.
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

## Run gyst from source

[`apps/gyst/dev/gyst`](apps/gyst/dev/gyst) is the checkout's `gyst`, run from source. Nothing is
built for the CLI, the daemon or the viewer. It takes the same arguments as `gyst` and reviews the
repository you run it in. With its directory first on `PATH`, plain `gyst` is the source CLI, for
you and for agents and the skills they run:

- **In this checkout:** [`mise.toml`](mise.toml) does it for everyone with mise activated, so
  `gyst` here (and an agent started here) reviews with the code being changed. Run the released
  CLI by its full path; `type -a gyst` lists both.
- **In test repositories:** keep them under one personal directory with a `mise.toml` naming your
  checkout, then trust it once with `mise trust ~/dev/gyst-playground/mise.toml`:

  ```toml
  # ~/dev/gyst-playground/mise.toml
  [env]
  _.path = ["~/dev/gyst/apps/gyst/dev"]

  [tools]
  node = "24" # the shim runs `node` from PATH
  ```

  A test repository's own Node pin still wins over this one; gyst needs Node 24.

- **In any other repository, now and then:** wrap one command, such as `gyst-dev pi`, with
  `gyst-dev() { PATH="$HOME/dev/gyst/apps/gyst/dev:$PATH" "$@"; }` in your shell profile.

mise switches `PATH` when your shell changes directory. A process keeps the `PATH` it started
with, so an agent started in one of these directories keeps the source `gyst` after it leaves,
and one started elsewhere keeps the released one. Check with `command -v gyst`. Each checkout has
its own `.dev/data`, so its sessions are separate from another checkout's.

- **The viewer:** bare `gyst`, a range or `--session` opens the session with the source CLI, then
  starts the Vite dev server ([`apps/web/dev.ts`](apps/web/dev.ts)) in front of the dev daemon and
  prints one link on Vite's port, `  gyst  http://localhost:3000/session/<id>`. Open it; viewer
  edits apply with Fast Refresh. `pnpm dev` does the same for this checkout's own uncommitted
  changes.
- **Everything else** (`gyst session ...`, `gyst skills ...`, `--help`) runs the source CLI
  directly. An agent that resolves `gyst` to the source CLI publishes through it, so you can watch
  its groups arrive in the dev viewer. The links it prints name the dev daemon's own port, which
  serves only a placeholder page in development: open the session with `gyst --session <id>`.
- **Skills:** `gyst skills` links agents to the built skills in `apps/gyst/.crust/root/skills/`,
  which only `pnpm build` creates; the build also regenerates `gyst-cli` from the command
  definitions. Run `pnpm build` once and after each skill or command change, then
  `gyst skills install --scope project` in the repository you test in. `--scope project` keeps the
  dev links out of your global agent directories, and later builds update them in place.
- **Where state lives:** sessions and the daemon use `.dev/data` (`GYST_DATA_DIR`), never your own
  gyst data. `rm -rf .dev` starts over.
- **Ports:** the dev daemon serves on 4978, or the next free port up to 4987 when another gyst
  (your installed one, say) holds it; `GYST_PORT` moves the range. Vite prefers 3000 and takes the
  next free port otherwise; the printed link names the one it got.
- **After changing `apps/gyst` or `packages/core`:** press `r` in the dev server. Vite reruns the
  plugin, which replaces the daemon with one from the current source, opens the session again and
  prints the link. Open tabs reconnect to the new daemon. The CLI needs nothing: each command runs
  the current source, and the daemon a changed CLI talks to is replaced on the next `r`.
- **Stopping:** Ctrl-C stops Vite. The daemon outlives it, as it does in production; the next run
  replaces it.

How the viewer is wired: the dev-only plugin in [`apps/web/dev-viewer.ts`](apps/web/dev-viewer.ts)
runs `node apps/gyst/src/index.ts` (Node runs the TypeScript directly) once with your arguments,
reads the link it prints and proxies the API paths (`/api/operation`, `/api/events`) to the
daemon's port in it, with their `Host` and `Origin` unchanged. The browser talks to Vite on
`localhost`, as it would through an SSH forward on another local port, so the daemon's host and
origin checks run as in production. The source daemon serves the packaged viewer from beside its
entry, so the plugin writes a placeholder pointing here to the git-ignored
`apps/gyst/src/dist/web-ui/`. Run from source, the daemon builds exports from this checkout's
standalone reader in `apps/web/dist-export/`; build it once with `pnpm build` (or
`pnpm --filter @gyst/web build`) before `gyst session export` in development.

This is for trying changes by hand. It does not replace `pnpm test`, which tests the packed npm
install.

A change to the authoring instructions in `apps/gyst/skills/gyst/`, or to what authoring
validation accepts, also needs the guidance cases in
[`docs/guidance-cases/`](docs/guidance-cases/README.md) regenerated and judged by a human.

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
built `dist/`, so the published package does not depend on React or the router. The daemon
serves the installed `dist/web-ui/`.

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
installed package, its one-shot commands, the daemon that serves their links and a private
key-authenticated SSH local forward on 127.0.0.1 from a sandboxed Chromium. Every test daemon
starts its viewer at a free port through `GYST_PORT`, never at 4978, so the tests can run beside
your own gyst. They need git, OpenSSH (`sshd`, `ssh` and `ssh-keygen` on
`PATH`, or `sshd` in `/usr/sbin`) and a Chrome or Chromium: `CHROMIUM_PATH` if set, else the first
of `google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on `PATH`, else
Google Chrome's standard install location. Their scratch directory lives under `$HOME`, since
sshd's `StrictModes` rejects a world-writable `/tmp` ancestor, and is removed after.

These are system prerequisites, not tools mise pins. A browser needs the system's libraries, and
its sandbox needs the system's permission: Ubuntu 23.10 and later allow it only for Chrome at its
installed path. CI uses the Google Chrome, git and OpenSSH preinstalled on GitHub's
`ubuntu-latest` image, so the workflow installs nothing.

To try the viewer over SSH, see the README's [Over SSH](README.md#over-ssh) section: one forward,
`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4978:127.0.0.1:4978 user@remote`, serves every
session. The viewer has no login and assumes a single-user machine; keep it that way when you
change its HTTP surface.

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
