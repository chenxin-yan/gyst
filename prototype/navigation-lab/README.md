# Navigation lab — throwaway

**Question:** can gyst offer useful TypeScript/JavaScript definitions and references without mixing the frozen review with a newer working tree?

This is a real-engine experiment, not production gyst or a mocked UI. It compares:

1. Native TypeScript LSP on a live scratch project.
2. The same native LSP on separately captured old/new projects.
3. Real `scip-typescript` indexes produced for each captured side, decoded and queried locally.

## Run

From the repository root (Bun, Node and this repo's installed native TypeScript required):

```sh
npm --prefix prototype/navigation-lab ci --ignore-scripts --no-audit --no-fund && bun prototype/navigation-lab/server.ts
```

Open **http://127.0.0.1:4317**. Set `PORT` to change the port. Stop with Ctrl-C.

For an explicitly requested Cloudflare quick tunnel, run `cloudflared tunnel --url http://127.0.0.1:4317 --http-host-header 127.0.0.1:4317`, then start the lab with `PUBLIC_ORIGIN` set to the exact HTTPS URL it prints. The origin allowlist remains enforced. The public URL has no authentication: anyone with it can view and change the shared scratch experiment. Stop the tunnel to remove public access.

The indexer dependency and lockfile are isolated here. This does not change the root package manifest or lockfile. No user repository is analyzed or edited. Only built-in fixture source is written to `gyst-navigation-PROTOTYPE-*` temporary directories, removed on normal shutdown. Crashes/forced kills may leave those scratch directories. Runtime edits are disposable; nothing is persisted across launches.

## Try it

Use the five guided buttons, left to right:

1. **Compare definitions.** The reviewed new side returns `amount * 0.8` in all three columns. Click each returned location to inspect its actual source.
2. **Agent changes the helper.** Live now returns `amount * 0.5` at a different line; captured LSP and SCIP still return `amount * 0.8`.
3. **Find direct-call references.** Live sees `new-consumer.ts`; the frozen engines do not. Counts are not normalized between engines.
4. **Inspect the old side.** Captured engines return `amount * 0.9`, while live still describes today's scratch project.
5. **Refresh the snapshot.** New becomes the current live project and old becomes the previous new snapshot. All three agree again on new-side code.

Then explore:

- Click any identifier-shaped token in any captured file. These are actual semantic requests; keywords/comment tokens can legitimately return nothing.
- Compare **Find references** for `applyDiscount` in `checkout.ts` with `discount` in `preview.js` or its declaration in `money.ts`.
- Toggle **Include declarations** and rerun references.
- Open `unrelated.ts`: a same-spelled `discount` is a different symbol.
- Use **Edit the live scratch workspace yourself** to change an existing fixture file. Saving restarts only the live server. If the clicked file no longer matches its live copy, live navigation refuses to guess its position.
- Inspect measured startup, query and indexing durations and saved-index byte sizes.

The source browser intentionally shows captured whole files rather than implementing a production diff renderer. Selecting an old/new side is explicit. Results open a separate inspector labeled with their provenance; a live result is never silently turned into a captured reference.

## Initial observations

Verified locally with **native TypeScript 7.0.2**, **scip-typescript 0.4.0 / TypeScript 5.9.3**, Node **v26.10.0**, Bun **1.4.2**:

- The installed native compiler accepts `--lsp --stdio`, advertises UTF-16, definition and references support, and answers real requests. No older community LSP adapter was needed.
- All engines resolve the fixture's imported/re-exported alias to the right definition, and separate old/new projects preserve different helper bodies after live edits.
- Native references from the renamed alias return only two `checkout.ts` usages. References from the direct call/declaration span more files. SCIP's exact-symbol view returns seven initial occurrences, including import/re-export positions. This is an observed scope difference, **not a claim that one engine is universally more complete**. No local workaround changes the engine results.
- A direct-call query initially returns four native reference locations and seven SCIP occurrences with declarations excluded. Adding a live caller changes native live results to five, while frozen native remains four and frozen SCIP remains seven.
- In one small-fixture run, indexing each side took roughly 0.5 seconds and produced about 4–5 KB; warm queries were below a few milliseconds. These are illustrative observations, **not comparative benchmarks or repository-scale performance promises**. Native and indexer compiler versions differ, servers are initialized at different times, queries run sequentially, and no memory profiling was done.

## Runnable check

```sh
bun prototype/navigation-lab/check.ts
```

Runs the actual engines and asserts definitions, direct references, alias definition resolution, JS imports, same-name isolation, UTF-16 after an astral character, CRLF, declaration inclusion, old/new preservation, live-only new usages, safe refusal of changed-file positions, explicit refresh and index querying with all LSP servers stopped. Also prints timings and observed counts. The first exploratory assertion incorrectly assumed alias references matched original-symbol references; real results exposed that assumption. The check now tests direct-call coverage separately and reports alias results without rewriting them.

Verification also passed: focused TypeScript typechecking, oxlint, oxfmt, and `git diff --check`. A local Playwright/Chromium run exercised all five guided steps, result previews, a manual scratch edit, CRLF token navigation and mobile layout without page errors; HTTP checks verified cross-origin rejection, the file allowlist and stale-snapshot rejection. This was automated browser verification, not human acceptance or a large-repository benchmark.

## Deliberate limits

- Tiny controlled TS/JS fixture only; no arbitrary-repo loading, project references, package dependencies or generated code. Those are the next experiment, not capabilities demonstrated here.
- All fixture source files are opened to the LSP. Startup measures initialize + notifications, not a portable whole-project-readiness signal. Editing restarts live LSP instead of testing incremental synchronization.
- SCIP uses its pinned package's internal protobuf decoder. The reader scans occurrences by exact symbol identity, handles local-symbol file scope and basic definition roles, but does not expand inheritance/implementation relationships or load external indexes. It is a prototype reader, not full SCIP semantics.
- One user / one shared experiment per server. Operations are serialized; controls intentionally pause while an experiment runs. No full history, result cache or production navigation UI.
- Older captures beyond the displayed pair are discarded on refresh. Production gyst's retained conversations/references require a separate retention policy.
- Fixed compiler configuration, localhost binding, same-origin checks and an existing-file allowlist prevent this browser from becoming an arbitrary filesystem or project-execution API. Keep it local by default; an explicitly enabled tunnel shares only this disposable experiment, not a private review.

## Implementation evidence

- Actual `initialize`, `textDocument/definition` and `textDocument/references` requests against the installed 7.0.2 executable.
- [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/): framing, lifecycle, document synchronization and UTF-16 positions.
- Installed `@sourcegraph/scip-typescript@0.4.0` CLI `index --help`, `dist/src/scip.js`, `FileIndexer.js`: index invocation, protobuf decoder, symbol roles and source positions.
- [Research evaluation](../../docs/research/code-navigation.md).

No product decision is settled by this prototype. Keep it out of production; capture a throwaway branch after human testing if it proves useful.
