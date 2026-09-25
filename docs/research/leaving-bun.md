# #66 — Leaving Bun: runtime, toolchain, distribution

## Summary

- **Recommend Node + Vite+, initially npm distribution**, removing the retiring TUI rather than porting it. Runtime migration is smaller than distribution migration (recommendation).
- Crust supports Node and Deno, but **its Node builder and all command snapshots still use Bun**; changing `crust.runtime` does not eliminate Bun ([builder](https://github.com/chenxin-yan/crust/blob/9e55c9a416e3725e34b9ebb5271179316359edaf/packages/crust/src/utils/build-helpers.ts#L591-L705)).
- Vite+ supports experimental SEA through **`vp pack`**, not `vp build`; requires Node ≥25.7 ([rc.0 documentation](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/pack.md)).
- Deno now covers all six targets; current Node SEA documentation explicitly excludes macOS x64. Do not promise six-target SEA parity ([Deno](https://docs.deno.com/runtime/reference/cli/compile/#supported-targets), [Node](https://nodejs.org/api/single-executable-applications.html#platform-support)).

## Findings

### Bun inventory and replacements

Read-only scan covered tracked and unignored `apps/` and `packages/`, excluding dependencies/generated artifacts. Rechecked prior research against Vite+ 1.0.0-rc.0, current Node 26.10/24.21 documentation and Deno 2.9.7. Citation abbreviations: **A**=`apps/gyst`, **C**=`packages/core`; paths below are relative to `/home/cyan/dev/github.com/chenxin-yan/pith`. Effort is **inferred**: S=mechanical hours; M=1–3 days including regressions; L=several days/platform work. Rows enumerate every API and affected source/test file; repeated calls within files are grouped.

| Bun dependency | Locations (file:line) | Node replacement; effort |
|---|---|---|
| `spawn`, `Subprocess` | A/src/tui/editor.ts:57,91; A/src/tui/editor.test.ts:167 (spy); A/tests/e2e/{cli.test.ts:23,session.test.ts:48,378,1024,skill.test.ts:18}; A/tests/pty/{editor.ts:112,editor-fixture.ts:32,34} | `node:child_process.spawn`, `ChildProcess`; replace `.exited` with error/close handling and Web-stream consumers with Node streams; M. |
| `spawnSync` | A/src/daemon/git.test.ts:14; A/tests/e2e/{session.test.ts:20,84,357,skill.test.ts:48}; A/tests/pty/editor-fixture.ts:56 | `spawnSync`; check `.error`, `.status`, `.signal`, not Bun `.exitCode`; S. |
| `sleep` | A/src/tui/{app.test.tsx:142,app.races.test.tsx:403,editor.test.ts:71}; A/tests/e2e/session.test.ts:126; A/tests/pty/{editor.ts:146,editor-fixture.ts:10} | `node:timers/promises.setTimeout`; S. |
| `write`, `file().exists()`, `$` | A/src/tui/{app.test.tsx:190,editor.test.ts:52,206}; A/tests/e2e/session.test.ts:238,828,829 (`file`), :27 (`$`) | `fs/promises.writeFile`, `access` with intentional missing-file handling, `mkdir({recursive:true})`; rewrite embedded fixture scripts too; S. |
| `hash` | C/src/hash.ts:1 | `crypto.createHash`; **not byte-compatible**; M (see below). |
| `CryptoHasher("sha256")` | A/src/daemon/store.ts:14 | `createHash("sha256").update(...).digest("hex")`; preserve exact framing; S. |
| `semver.order` | A/src/daemon/{protocol.ts:9,client.ts:132,server.ts:164} | npm `semver.valid/compare`; preserve rejection and prerelease behavior; S. |
| `which` | A/src/tui/editor.ts:28; A/tests/pty/editor.ts:281,283 | npm `which`; preserve relative-editor/cwd and Windows PATHEXT semantics; S/M. |
| `Terminal` | A/tests/pty/editor.ts:105 | No equivalent built-in PTY allocator; `node-pty` native dependency if retained, otherwise retire TUI-only suite; L. |
| `main` | A/src/daemon/client.ts:54 | npm: `process.execPath` + absolute CLI entry; SEA: `sea.isSea()` and executable alone; M. |
| `connect`, `listen` | A/tests/e2e/session.test.ts:302; :831,875,912,945,981 | `net.connect({path})`, `net.createServer().listen(path)`; adapt callbacks/cleanup; M. |
| `import.meta.dir` | A/tests/e2e/{cli.test.ts:24,session.test.ts:87,1025,skill.test.ts:13}; A/tests/pty/editor.ts:87,118,119 | `import.meta.dirname`; S. |

Replacement owners: [child_process](https://nodejs.org/api/child_process.html), [timers](https://nodejs.org/api/timers.html#timerspromisessettimeoutdelay-value-options), [fs](https://nodejs.org/api/fs.html#promises-api), [crypto](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options), [semver](https://github.com/npm/node-semver#comparison), [which](https://github.com/npm/node-which), [node-pty](https://github.com/microsoft/node-pty), [SEA](https://nodejs.org/api/single-executable-applications.html#seaissea), [net](https://nodejs.org/api/net.html#ipc-support), [ESM](https://nodejs.org/api/esm.html#importmetadirname).

**Indirect platform coupling:** `BunServices` occurs in A/src/cli/commands/{daemon,session}.ts:3, A/src/tui/render.tsx:3, A/src/daemon/{git,server,sessions,store}.test.ts:2 and A/tests/e2e/session.test.ts:6. Replace with matching-version `@effect/platform-node`/`NodeServices` (S/M). `BunSocket`/`BunSocketServer` occur in A/src/daemon/{client,server}.ts:1 and server.test.ts:2; their installed implementations already re-export Node implementations (A/node_modules/@effect/platform-bun/src/BunSocket.ts:20; BunSocketServer.ts:8). [Node services source](https://github.com/Effect-TS/effect-smol/blob/main/packages/platform-node/src/NodeServices.ts).

**Unix sockets are not Windows parity:** the daemon's hard-link/inode ownership protocol explicitly assumes Unix (A/src/daemon/server.ts:74–123). Node uses Windows named pipes instead ([IPC docs](https://nodejs.org/api/net.html#ipc-support)). Recommendation: implement the planned loopback HTTP ownership/authentication lifecycle once, rather than porting obsolete socket ownership; retain token, Host/Origin validation and startup-race tests.

**Hash compatibility matters:** Bun uses [64-bit Wyhash](https://bun.sh/docs/runtime/hashing), feeding persisted hunk IDs/content hashes and idempotency receipts (C/src/snapshot.ts:64–68; C/src/apply.ts:83–87). SHA-256 changes identity/replay behavior. Choose exact compatibility or an explicit saved-session migration/version boundary; never silently substitute.

**All 19 `bun:test` imports**, each at line 1:

- C/src/{apply,human-action,refresh,semantic,snapshot,wire}.test.ts.
- A/src/cli/app.test.ts; A/src/cli/extensions/json-errors.test.ts.
- A/src/daemon/{git,server,sessions,store}.test.ts.
- A/src/tui/{parsers,editor}.test.ts; {app,app.races}.test.tsx.
- A/tests/e2e/{cli,session,skill}.test.ts.

Use `vite-plus/test`; `spyOn` becomes `vi.spyOn`, not a named import. Import replacement is S; process isolation, timeouts, mocks and built/source-mode e2e migration are M ([Vitest integration](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/test.md)). TUI preload/plugin dependencies remain blockers until removed (A/bunfig.toml:1–4; A/package.json:28–30; A/src/cli/app.ts:5). Run subprocess tests against built JavaScript; do not carry over `bun src/index.tsx` or `bun build --compile` invocations.

### Crust and a genuinely Bun-free build

Installed **0.4.1** schema confirms `bun|deno|node`, rejects Node targets, and rejects Deno Bun plugins (A/node_modules/@crustjs/crust/schema/package.json:17–37). Local source inspected at `9e55c9a`:

- Node: remove `targets`; stages `.crust/root/bin/gyst.js`, ESM with Node shebang. Deno: six canonical target triples, `deno compile -A`; platform packages plus Node npm launcher ([build dispatch](https://github.com/chenxin-yan/crust/blob/9e55c9a416e3725e34b9ebb5271179316359edaf/packages/crust/src/commands/build.ts#L408-L440), [compiler](https://github.com/chenxin-yan/crust/blob/9e55c9a416e3725e34b9ebb5271179316359edaf/packages/crust/src/utils/build-helpers.ts#L550-L677)). `-A` means no sandbox advantage here.
- `crust.include` copies assets beside executables, **not into them**; `crust publish` publishes staged packages through npm ([staging](https://github.com/chenxin-yan/crust/blob/9e55c9a416e3725e34b9ebb5271179316359edaf/packages/crust/src/utils/distribute.ts#L714-L752), [publishing](https://github.com/chenxin-yan/crust/blob/9e55c9a416e3725e34b9ebb5271179316359edaf/packages/crust/src/commands/publish.ts#L306-L329)).

Therefore full Vite+ needs Node-compatible Crust snapshot/build hooks or replacement staging around `vp pack`; preserve generated/authored skills (A/src/cli/extensions/co-review-skill.ts:3–8). Also migrate package-manager pin/lock, Bun types, CI and release scripts (package.json:19–35; tsconfig.json:16; scripts/publish.ts:5–15; .github/workflows/release.yml:70–99). `vp install` honors the existing Bun pin until changed ([selection](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/install.md)).

### Distribution comparison

| | npm-only Node | Node SEA | Deno compile |
|---|---|---|---|
| Six OS/CPU combinations | All six have Node distributions | Linux/Windows x64+arm64; macOS arm64; **macOS x64 unsupported per docs** | All six; Windows arm64 ≥2.9.3 |
| Size | JS+assets; Node installed separately | Node executable+bundle+assets | denort+module graph+assets |
| Startup | No extraction required for plain JS | Code cache/snapshot optional; disable both for cross-target builds | Embedded VFS; self-extraction adds first-run cost |
| Native dependencies | Target-specific addon packages | Extract `.node` assets before `dlopen` | Node-API needs local modules/FFI permissions; validate target binaries |
| Static web assets | Ship `dist/` alongside CLI | `assets`/`sea.getAsset`; current VFS also available | `--include-as-is dist` for prebuilt frontend bundles |

Sources: [Node release matrix](https://nodejs.org/dist/index.json), [current SEA](https://nodejs.org/api/single-executable-applications.html), [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/), [Deno compatibility](https://docs.deno.com/runtime/fundamentals/node/#use-packages-with-native-addons). Deno 2.9.7's compressed **runtime-only** ZIPs are 27.4–32.8 MiB, not final application sizes ([release API](https://api.github.com/repos/denoland/deno/releases/tags/v2.9.7)). Node 26.10's uncompressed Windows base executables are approximately [99.9 MiB x64](https://nodejs.org/dist/v26.10.0/win-x64/node.exe) and [86.8 MiB arm64](https://nodejs.org/dist/v26.10.0/win-arm64/node.exe) (HTTP Content-Length). These are scale examples, **not a compressed/uncompressed apples-to-apples comparison**. No gyst size/startup benchmark exists here; no speed ranking is justified.

Current Node 26 supports `--build-sea` (introduced 25.5), ESM and assets; [Node 24 docs](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html) still describe blob injection. [tsdown executable packaging](https://tsdown.dev/options/exe) is experimental, single-entry, and needs macOS signing after cross-building. Deno's Node compatibility does not establish gyst compatibility; Vite+'s documented test runtime remains Node. For the web daemon, [Deno.serve](https://docs.deno.com/runtime/fundamentals/http_server/) supplies Request/Response HTTP directly; Node supplies `node:http` ([Deno's Node example](https://docs.deno.com/runtime/fundamentals/node/)). Either can serve static Vite output; explicitly bind loopback and enforce identical token/Host/Origin rules (recommendation).

### Turbo → Vite Task parity

Current pipeline: `turbo.json:4–19`; core has no build script (C/package.json:8–12).

| Existing | Vite+ equivalent / caveat |
|---|---|
| `build` → `^build`; `.crust/**` | `{task:"build",from:"dependencies"}`; explicit `output:[".crust/**"]` or new dist paths |
| `test` → `^build` | Same dependency edge; command `vp test` |
| `topo` → `^topo`; types → `topo` | No commandless tasks: drop unnecessary transit nodes for today's two-package graph; preserve cross-package invalidation with explicit inputs |
| root `//#lint`, `//#format` | Root tasks: `vp lint`, `vp fmt --check`; keep `tsc --noEmit` until type-check coverage matches |

[Run/config](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/config/run.md) supports dependency edges, outputs and pre/post hooks; task/script names cannot overlap. [Caching](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/cache.md) defaults differ: configured tasks cached, scripts uncached; environment filtered. Explicitly audit test env, restored outputs and changed-core invalidation. Use `vp build` for web, `vp pack` for CLI; migrate root [lint](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/lint.md)/[fmt](https://github.com/voidzero-dev/vite-plus/blob/v1.0.0-rc.0/docs/guide/fmt.md) settings. Remote caching is unnecessary for this pipeline.

## Recommendation and human decisions

Choose Node/npm first; retire TUI/PTY, port shared APIs/tests, then replace build/release orchestration. **Inference:** several focused days after TUI retirement, plus packaging/platform validation; not a runner-only rename. Deno buys simpler six-target binaries but adds a second runtime beside Vite+'s Node and compatibility testing.

Decide: must first release be standalone on all six targets? Must saved sessions survive hash migration? Can Crust retain build-time Bun temporarily, or must its builder change immediately? Benchmark final cold CLI/daemon startup and package size only after those decisions. No repositories or issues changed; no migration/build smoke tests run.
