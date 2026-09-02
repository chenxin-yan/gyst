# gyst

Keyboard-centric agent/human co-review TUI.

## Local gate

Crust is unpublished. Its workspace must be installed and built at
`/home/cyan/dev/github.com/chenxin-yan/crust` before setting up gyst:

```sh
cd /home/cyan/dev/github.com/chenxin-yan/crust
bun install
bunx turbo run build --filter=@crustjs/core

cd /home/cyan/dev/github.com/chenxin-yan/gyst
bun run setup:crust
bun install
bun run check
```

Set `CRUST_CHECKOUT` when crust lives elsewhere. `bun run check` enforces the
pure-core import boundary, typechecks and tests all workspaces, then compiles
and runs the actual `dist/gyst` executable. The final smoke runs bare `gyst`,
`gyst --help`, and `gyst session --help`; it fails unless the compiled binary
loads OpenTUI's native library, renders a Solid frame, exits cleanly, and prints
help generated from the crust command tree.
