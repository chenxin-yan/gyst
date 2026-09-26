# Semantic code navigation in gyst

Status: research and recommendation, not an implementation decision. Initial language priority: TypeScript/JavaScript. No language-server prototype or performance benchmark was run during this initial research.

Follow-up: the [navigation lab](../../prototype/navigation-lab/README.md) now exercises real native TypeScript 7.0.2 LSP and SCIP against isolated fixtures. Its README records observed revision fidelity, alias/reference differences and small-fixture timings; those experiments do not establish repository-scale performance or a production backend choice.

## Bottom line

**Go to definition and Find references are feasible.** LSP supplies standardized requests for both; semantic indexes offer another route. The hard requirement for gyst is answering against the **correct captured project**, not merely opening a language server against the current checkout.

Recommend a bounded TS/JS experiment with a version-compatible language server and isolated captured project. Validate both features and snapshot fidelity before choosing a production backend. Compare a per-snapshot SCIP index if indexing latency or hosted distribution makes on-demand analysis unattractive. Do not build both production backends now.

Opening the user's editor is a useful low-cost fallback, but does not satisfy navigation _inside gyst_. Text search and agent-authored links are useful too, but are not replacements for arbitrary-symbol semantic navigation.

## What gyst already has

- [CONTEXT.md](../../CONTEXT.md) defines explicitly refreshed frozen snapshots and references to exact captured file/side/range, including unchanged code outside the diff. The [refresh resolution](https://github.com/chenxin-yan/gyst/issues/70#issuecomment-5843528827) retains older context and forbids silently retargeting pinned references.
- [snapshot.ts](../../packages/core/src/snapshot.ts) parses diff hunks; [session.ts](../../packages/core/src/session.ts) does not provide a full historical project filesystem. Hunks alone cannot supply arbitrary imported files, project configuration or dependencies.
- [editor.ts](../../apps/gyst/src/tui/editor.ts) validates and opens a working-tree file using `EDITOR`. This is an existing live-checkout escape hatch, not semantic navigation or historical source browsing.
- The [architecture ADR](../adr/0001-effect-architecture.md) assigns process/filesystem work to daemon services and keeps core transformations pure. A daemon-owned language-server process fits that boundary; the browser need not become an IDE.

These are source-inspection findings, not execution tests.

## Feasible approaches

Relative costs below are engineering judgments, not measured estimates.

| Approach                       | What the user gets                                | Snapshot correctness                                                                       | Main trade-off                                                             |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Open in editor                 | Navigation using their configured editor          | Usually current checkout, not reviewed revision                                            | Lowest gyst integration cost; leaves review UI                             |
| Local LSP on working tree      | Real definitions/references inside gyst           | Only aligned while the relevant project state matches; old-side code needs its own context | Straightforward semantic experiment, but live results must be labeled live |
| LSP on captured project        | Real definitions/references for the selected side | Possible with coherent source/config/dependency context                                    | Project reconstruction, process lifecycle and indexing costs               |
| Snapshot-pinned semantic index | Definitions/references recorded during indexing   | Strong when source and index share exact provenance                                        | Up-front indexing and artifact storage; attractive for hosted reading      |
| Syntax/tag/text search         | Candidate declarations and occurrences            | Can operate on captured bytes                                                              | Not generally same-symbol resolution across imports, aliases and types     |

### 1. Live language servers

[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) defines `textDocument/definition` and `textDocument/references`. Definition may return one or several locations or location links; references takes `includeDeclaration` and returns locations. Servers advertise their capabilities during initialization and may register capabilities dynamically.

A plausible flow is:

```text
click identifier in diff
  -> gyst daemon: selected snapshot, side, file and source position
  -> language server: definition/references request
  -> validate returned locations and their provenance
  -> browser: source preview or references list
```

Only the middle request is standardized. Gyst still needs startup/shutdown, document synchronization, configuration requests, timeouts, cancellation, readiness behavior and stale-response handling. Successful initialization is not a portable guarantee of complete project indexing.

An unchanged current workspace can answer new-side queries, including uncommitted changes that match the captured state. The problem is divergence: an agent can edit an imported helper or configuration while the reviewer still sees the earlier snapshot. Equality of the clicked file alone does not establish equality of the project graph. Labeling a live answer honestly is acceptable; presenting it as a captured answer is not.

**TS version caveat:** the [community TypeScript language server](https://github.com/typescript-language-server/typescript-language-server) wraps the older `tsserver` API. Its current README installs `typescript@6` and explicitly says it is not VS Code's bundled service. Locally, `node_modules/typescript/package.json` reports **7.0.2**, exposes `tsc` rather than a `tsserver` executable, and has native/unstable API exports. The [native TypeScript repository](https://github.com/microsoft/typescript-go) describes the native LSP effort; its [server source](https://github.com/microsoft/typescript-go/blob/main/internal/lsp/server.go) advertises definition and references providers. Documentation in this transition is not uniformly current. This establishes another candidate, **not** verified compatibility or a tested launch recipe for the installed package. Test the actual native release or a deliberately compatible older adapter/compiler pair; do not blindly install the adapter beside any TypeScript version.

### 2. Snapshot-specific language servers

[LSP `didOpen`](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didOpen) makes the client authoritative for that open document's text. It does **not** freeze unopened imports, `tsconfig.json`, package metadata or dependencies. Sending old text for one file to a server reading today's project can mix revisions.

Engineering inference: use a coherent captured project filesystem or a thoroughly verified virtual-filesystem integration. For revision ranges, Git can supply committed source; for uncommitted snapshots, include captured modifications and relevant untracked files. Dependencies and generated output are a separate reproducibility problem. A Git worktree alone does not recreate historical `node_modules` or unsaved editor buffers.

Old and new sides need distinct analysis contexts, but not necessarily two always-running processes. On-demand startup and sequential analysis are possible trade-offs to measure. Full source files are useful inputs to language analysis; this does not pre-decide whether gyst's retained reference storage uses whole files, bounded ranges or another capture unit.

### 3. Precomputed indexes: SCIP

[SCIP](https://scip-code.org/docs.html) records source occurrences, symbol identities, definition roles and symbol relationships. [`scip-typescript`](https://github.com/sourcegraph/scip-typescript) supports TypeScript and JavaScript, documents project/dependency preparation, and offers inferred configuration for JS. It is a concrete alternative to keeping language servers alive while reading.

Gyst could index each captured side once, then query those artifacts. A hosted reader could use the same artifacts without a local checkout or language-server installation. This does not require adopting Sourcegraph's hosted product, but gyst would need an index reader and query implementation; the index format is not a ready-made navigation UI.

Important limits:

- SCIP document text is optional and **not included by default**. Ship or retain source blobs alongside the index.
- References cover indexed projects and recorded relationships, not every downstream consumer of a package.
- Cross-package navigation needs target source/index coverage. An external symbol identifier is not automatically available source code.
- Configuration, dependencies, indexer version and exact source identity must be recorded. TypeScript 7 language compatibility with a chosen indexer must be tested, not inferred from its name.
- The indexer's README documents memory problems and cache trade-offs; startup cost, artifact size and refresh latency need measurements on representative repos.

[LSIF](https://github.com/microsoft/language-server-protocol/blob/main/indexFormat/specification.md) is another precomputed-code-intelligence format. SCIP is the more concrete TS/JS candidate here because an existing indexer is directly available; this is not a claim that LSIF is unusable.

### 4. Browser services, editor reuse and weaker fallbacks

[Monaco's TypeScript worker](https://microsoft.github.io/monaco-editor/typedoc/interfaces/languages_features_typescript_register.TypeScriptWorker.html) exposes definition/reference APIs. Supplying project files, libraries, configuration and revision separation is still the integrator's job. Embedding Monaco alone does not supply project intelligence. A browser-only TS virtual project is possible, but introduces another project-host implementation and requires compatibility testing; it is not the recommended first experiment.

[VS Code's CLI](https://code.visualstudio.com/docs/editor/command-line) supports opening a file at a position. An editor bridge could do more, but do not assume the editor exposes an externally reusable LSP endpoint. Live editor navigation should explicitly say **current checkout**.

[Tree-sitter queries](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/) and [ctags](https://docs.ctags.io/en/stable/output-tags.html) can support syntax/name navigation. They do not generally reproduce a compiler's cross-project symbol resolution. Call text matches **Search occurrences**, not **Find references**, unless semantic identity is actually established.

## Correctness, safety and scope

- **Diff positions:** map clicked positions through old/new hunk counters. Deleted lines have no new-side position. Context lines have a position on both sides.
- **Encoding:** LSP positions are zero-based, with negotiated encoding and UTF-16 as the compatibility default. DOM columns, bytes and Unicode code points are not interchangeable. Test non-BMP characters and CRLF. SCIP documents also carry position encoding. [LSP positions](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#position), [SCIP schema](https://scip-code.org/docs.html).
- **Result provenance:** validate paths/URIs and ranges before opening results. Packages, generated files and declarations may lie outside captured repo source. Explain unavailable targets rather than reading arbitrary current files.
- **Completeness:** finding a definition and enumerating all references are different promises. Missing dependencies, excluded projects and dynamic JS affect answers. LSP does not provide a universal completeness certificate; distinguish errors/unsupported/loading from an empty result, and explain known search scope without claiming undetectable gaps are measured.
- **Trust:** language analysis is not necessarily passive parsing. For example, [rust-analyzer](https://rust-analyzer.github.io/book/configuration.html) documents build-script/procedural-macro execution settings. Treat project plugins and tooling as an execution boundary: no automatic installs or project scripts merely because someone opens a review. Require an explicit trust/setup policy and clean process shutdown.
- **Other languages:** [pylsp](https://github.com/python-lsp/python-lsp-server) depends on Python/import environment; [gopls](https://go.dev/gopls/workspace) uses a selected Go workspace/build scope; Rust needs its project/toolchain context. A shared protocol reduces integration duplication, not language setup or revision-reconstruction work. No broad-language support is promised by this evaluation.

## Recommended next experiment

Test **both definition and references**, TS/JS only, in a small captured project before committing product scope. Use the installed native TypeScript server only after verifying its launch/capability contract; otherwise use an explicitly version-compatible adapter/compiler pair. First prove query wiring, then repeat against isolated old/new project contexts. Do not ship live-checkout results as the permanent answer to frozen review navigation.

Acceptance cases:

1. Changed caller resolves to an unchanged imported helper outside the diff.
2. Old-side code resolves to the old helper; editing the live checkout does not change captured answers.
3. Same-name unrelated symbols, aliases and re-exports are distinguished.
4. TS project references and JS with/without project config have documented coverage.
5. Missing dependencies and declaration-only package targets degrade honestly.
6. Untracked files, deleted lines, CRLF and non-BMP characters map correctly.
7. An answer arriving after refresh cannot become an unqualified answer for the new snapshot.
8. Measure cold start, first definition, reference-query latency, memory and refresh cost; do not invent budgets without target repo sizes.

If isolated LSP performs acceptably, it is a plausible local-first implementation. If capture-time indexing fits the workflow better or hosted navigation becomes a priority, run the same cases through `scip-typescript` and compare source-plus-index artifacts. Select one backend based on evidence.

## Open decisions and verification

This research informs [Code navigation in v1](https://github.com/chenxin-yan/gyst/issues/72) and [Capturing unchanged code for snapshot references](https://github.com/chenxin-yan/gyst/issues/79); it does not resolve either. Remaining product questions include first supported toolchains, whether live navigation is acceptable as an explicitly separate mode, captured project coverage, external package targets and acceptable preparation cost.

Primary specifications, project READMEs and selected implementation source were inspected. Parent review corrected two overstatements in the initial research: uncommitted code is not inherently incompatible with live LSP, and full-file persistence is not already a settled reference-storage requirement. Parent review also identified the native TypeScript version transition. No semantic requests, toolchain compatibility tests, performance measurements or production-code tests were run. All linked upstream default-branch documentation is version-sensitive; implementation must pin and verify the selected releases.
