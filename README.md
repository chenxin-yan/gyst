# gyst

Keyboard-centric agent/human co-review TUI.

## Local gate

Use Bun 1.4.2. Crust is unpublished; point `CRUST_CHECKOUT` at a checkout of
`38e7298954c60ec0a45dcfa830b515b2bc32ece0` before setting up gyst:

```sh
export CRUST_CHECKOUT=/path/to/crust
(cd "$CRUST_CHECKOUT" && bun install --frozen-lockfile && bunx turbo run build --filter=@crustjs/core --filter=@crustjs/extensions)

bun run setup:crust
bun install --frozen-lockfile
bun run check
```

`bun run check` enforces the
pure-core import boundary, typechecks and tests all workspaces, then compiles
and runs the actual `dist/gyst` executable. The final smoke runs bare `gyst`,
`gyst --help`, and `gyst session --help`; it fails unless the compiled binary
loads OpenTUI's native library, renders a Solid frame, exits cleanly, and prints
help generated from the crust command tree.
