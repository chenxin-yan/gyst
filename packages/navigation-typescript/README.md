# @gyst/navigation-typescript

The optional TypeScript/JavaScript navigation add-on for [gyst](https://github.com/chenxin-yan/gyst).
It lets the gyst daemon follow definitions and usages in a review's captured snapshot with the
native TypeScript 7.0.2 language server, which this package pins exactly and brings with it.
gyst works without it.

Each release matches one gyst release exactly. Install the one matching your `gyst --version`:

```sh
npm install -g @gyst/navigation-typescript@<gyst version>
```

gyst looks for `gyst-navigation-typescript` on the `PATH` of the `gyst` command that launched the
viewer, so install it with the same npm whose global bin directory is on that `PATH`.

## The executable

gyst runs it with its own Node.js and no shell:

- `gyst-navigation-typescript --version` prints one JSON line with the add-on's name, release,
  protocol and the result of running its own engine's `tsc --version`, for example
  `{"name":"@gyst/navigation-typescript","version":"0.1.2","protocol":1,"engine":{"ok":true,"version":"7.0.2"}}`.
  A missing native engine package (as with `npm install --omit=optional`) is reported as
  `"engine":{"ok":false,"problem":"..."}`.
- `gyst-navigation-typescript lsp --expect <version>` becomes that engine's
  `tsc --lsp --stdio` in the same process, without a `PATH`, so the engine cannot run npm to
  acquire types. It exits with status 1 if `<version>` is not its own release.

The engine is always the one installed with this package, never a reviewed project's TypeScript.

## Developing

In this repository, `packages/navigation-typescript/src/cli.ts` is the executable, run by Node
directly; `pnpm build` stages the published package in `.crust/root` with `crust build`, keeping
the pinned engine a dependency beside the bundle. To make a source `gyst` find it, put a directory
containing a `gyst-navigation-typescript` symlink to `src/cli.ts` on `PATH`.
