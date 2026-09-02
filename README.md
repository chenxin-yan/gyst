# gyst

Keyboard-centric agent/human co-review TUI.

## Local gate

Crust is unpublished. Point `CRUST_CHECKOUT` at its local checkout before
setting up gyst:

```sh
export CRUST_CHECKOUT=/path/to/crust
(cd "$CRUST_CHECKOUT" && bun install && bunx turbo run build --filter=@crustjs/core)

bun run setup:crust
bun install
bun run check
```

`bun run check` enforces the
pure-core import boundary, typechecks and tests all workspaces, then compiles
and runs the actual `dist/gyst` executable. The final smoke runs bare `gyst`,
`gyst --help`, and `gyst session --help`; it fails unless the compiled binary
loads OpenTUI's native library, renders a Solid frame, exits cleanly, and prints
help generated from the crust command tree.
