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
`@gyst/cli` with its Node launcher `bin/gyst.js`,
and each `<os>-<arch>/` directory holds the platform package with the compiled
`bin/gyst-bun-<os>-<arch>` binary. `manifest.json` indexes them.

## License

[MIT](LICENSE)
