# TICKET #5 — Meat’s elision rubric

## Scope and provenance

This report is based only on Meat’s Go source and checked-in tests. I shallow-cloned `https://github.com/boldsoftware/meat` to `/tmp/pith-src/meat` and inspected commit [`f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3`](https://github.com/boldsoftware/meat/tree/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3). The clone remained clean after inspection. Meat describes its output as a non-applicable, code-shaped “reading diff”: the model submits source-coordinate edits, while Meat renders from the immutable original rather than letting the model rewrite the diff ([`meat/meat.go:5-18`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat.go#L5-L18), [`meat/editplan.go:1-7`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L1-L7)).

## The rubric in one rule

Preserve the smallest source-shaped skeleton that explains changed behavior and data flow; remove or visibly fold repeated, forced, generated, or prose-heavy mechanics; never synthesize logic; and keep uncertain or semantically distinct code. The rubric explicitly keeps changed arguments, conditions, callees, and return paths, while its final safety rule is “if unsure, KEEP” ([`meat/rubric.go:202-220`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L202-L220)).

## Meat’s mechanical-noise taxonomy

These are rubric categories, not all deterministic classifiers. Only imports, conservative exact moves, edit validity, and Python structural invariants receive substantial compiler-side enforcement; the model judges most other categories under the frozen rubric ([`meat/editplan.go:165-378`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L165-L378)).

| Noise family | Meat’s treatment | Semantic anchor / exception that remains | Primary source |
|---|---|---|---|
| **Batch field/member copies and repeated plumbing** | Keep the operation’s naming anchor, then remove repeated members/calls/setup/cases or fold them to one fixed `...` row. The worked field-copy example retains one source-shaped projection (`resp.SSHKeyID = rd...`) rather than the whole assignment batch. | Keep any member that exposes a distinct transformation, condition, effect, compatibility boundary, or meaningful type conversion. | [`meat/rubric.go:206`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L206), [`meat/rubric.go:267-278`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L267-L278) |
| **Repeated renames and call-site migrations** | Keep one representative old/new exemplar and drop purely mechanical sibling hunks. | Keep additional sites only when they reveal distinct behavior, conditions, transformations, effects, or compatibility boundaries. | [`meat/rubric.go:206`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L206) |
| **Forced signature/API propagation** | Drop a forced zero value added only because a new return slot exists; drop a whole hunk that merely forwards a context already represented elsewhere. | Keep changed return behavior; for context, keep timeout, cancellation, values, or `Done` semantics. | [`meat/rubric.go:212`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L212), [`meat/rubric.go:321-326`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L321-L326), [`meat/rubric.go:355-356`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L355-L356) |
| **Error-message construction** | Preserve the branch and the fact/type of erroring, but locally replace noisy format strings and arguments with `...`. | Keep error identity, wrapping, type, status, warning category/filter, control behavior, and exact public/tested text when those change. | [`meat/rubric.go:210`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L210), [`meat/rubric.go:280-287`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L280-L287), [`meat/rubric.go:262`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L262) |
| **Generated files** | Remove the complete file section and mention regeneration in the summary; clues include `Code generated ... DO NOT EDIT.` and conventional generated paths. | Keep the hand-written source change that drove generation; inspect the tree when generation is uncertain. | [`meat/rubric.go:214`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L214) |
| **Imports and include/use/require scaffolding** | Remove automatically and unconditionally, including aliases, multiline blocks, framing, package swaps, and recognized import rows embedded in source/test-fixture strings. Import-only hunks/files lose their shells too. | Behavioral body remains even when the package substitution is security-relevant; the body must expose that behavior. Package declarations/renames are not themselves imports. | [`meat/rubric.go:216`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L216), [`meat/rubric.go:328-345`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L328-L345), [`meat/imports.go:156-238`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/imports.go#L156-L238) |
| **Pure formatting and already-demonstrated mechanics** | Drop gofmt realignment and mechanical renames already obvious from a retained exemplar. | Any behavior/data-flow change wins over formatting classification. | [`meat/rubric.go:204-212`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L204-L212) |
| **Default diff context, blank lines, and mechanical prose** | Drop routine context rows, nearby blanks, unchanged narration, issue restatements, changelog prose, and line-by-line comments/docstrings. | Keep owning definitions, needed closers, data provenance, necessary control flow, contracts, security/compatibility caveats, non-obvious rationale, and conditions not evident from code. | [`meat/rubric.go:206-208`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L206-L208) |
| **Test construction and repetitive suites** | Fold/remove duplicate setup, teardown, equivalent cases, assertion batches, repeated calls, fixture interiors, exception setup, and repetitive middle parametrization cases. | Keep the scenario owner, distinctive stimulus/configuration, each different outcome dimension, one decisive assertion, required setup, and input/expected pairing. | [`meat/rubric.go:242-252`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L242-L252), [`meat/rubric.go:259-263`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L259-L263) |
| **Bulky multiline calls, literals, tables, strings, signatures, and comprehensions** | Fold repetitive interiors while retaining opener, closer, assignment/call owner, and representative/distinctive rows. | Preserve changed arguments, delimiter/string boundaries, table dimensions, boundary values, and stimulus/expected-output content. | [`meat/rubric.go:256-260`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L256-L260), [`meat/rubric.go:289-319`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L289-L319) |
| **Exact behavioral moves** | Treat removal and addition as one relocation group and give aligned rows identical keep/remove/fold/local-elision treatment; do not make a move read as a one-sided deletion. Detection is conservative: cross-hunk runs need globally unique exact content after uniform indentation normalization and at least 3 substantive rows / 48 non-space bytes. | A move is not automatically noise: preserve both sides when relocation itself matters, or compress both symmetrically. Ambiguous/overlapping candidates are discarded. | [`meat/rubric.go:218`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L218), [`meat/moves.go:11-15`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/moves.go#L11-L15), [`meat/moves.go:58-196`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/moves.go#L58-L196) |

### What is never “mechanical” by default

Meat’s Python rubric names a five-part semantic skeleton: contract/definition, behavior-changing condition, transformation, observable effect, and test specification. It additionally preserves decorators whose arguments define behavior, fixture lifecycle edges, async/task/context-manager boundaries, exception behavior, warning categories, and referenced table/fixture definitions ([`meat/rubric.go:242-263`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L242-L263)). This is the important negative boundary for Pith: pattern membership proposes compression; it must not authorize it.

## How the prompt/rubric is structured and frozen

### Prompt construction

1. **System prompt:** one static `systemPrompt` contains the reviewer role and objective, nine general principles, the immutable-coordinate edit protocol, Python semantic-skeleton/suite rules, and worked examples ([`meat/rubric.go:192-359`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L192-L359)).
2. **Per-request user prompt:** `buildUserPrompt` concatenates named constants for the task intro and automatic imports; conditionally adds detected move coordinates; selects read-only-tree guidance or diff-only guidance; adds protocol guidance; then appends the numbered immutable diff ([`meat/meat.go:238-270`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat.go#L238-L270)).
3. **Tools:** with a repository root, the model gets confined `read_file`/`grep` plus `preview_plan` and `submit`; without a root, it gets only preview/submit. Both edit tools require complete `remove`, `replace`, and `fold` arrays; submit also requires a one-line summary ([`meat/tools.go:40-107`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/tools.go#L40-L107), [`meat/tools.go:210-243`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/tools.go#L210-L243)).
4. **Feedback/refinement:** preview and accepted submit plans receive locally computed retention/move feedback and the projected diff. If a submission has at least 40 raw and 20 visible changed rows and retains at least 80 rows or 45%, Meat allows one automatic refinement turn; the feedback is explicitly advisory ([`meat/tools.go:248-286`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/tools.go#L248-L286), [`meat/meat.go:162-215`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat.go#L162-L215)).

### Freeze and hash

The freeze is broader than the large rubric string. `promptSurface()` renders and NUL-separates the protocol version, system prompt, user-prompt branches (tools/no-tools, moves/no-moves, move overflow), tool names/descriptions/schemas, no-tool-call nudge, and normal/high-pressure/oversize tool feedback. Hashing rendered compositions catches both wording and assembly changes ([`meat/rubric.go:10-13`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L10-L13), [`meat/rubric.go:49-132`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L49-L132)).

`RubricHash()` is the first eight bytes of SHA-256, rendered as 16 lowercase hex characters. At the inspected commit the test pins it to **`441f5e6e28ad3add`**; a semantic edit-protocol change must also bump `source-edit-plan-v10-frozen-prompt-surface` ([`meat/rubric.go:10-13`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L10-L13), [`meat/rubric.go:171-177`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L171-L177), [`meat/meat_test.go:740-766`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat_test.go#L740-L766)). The CLI mixes that rubric hash with model ID and diff text in its cache key, so rubric/compiler changes invalidate results ([`cmd/meat/cache.go:26-42`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/cmd/meat/cache.go#L26-L42)).

Validation-error wording is intentionally outside the hashed surface: it is conflict-specific corrective feedback, while semantic changes are represented by the protocol-version bump. A separate freeze test rejects compiler-arbitration vocabulary from model-visible surfaces and asserts that automatic imports, move symmetry, and no-invention guidance remain present ([`meat/rubric.go:57-61`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L57-L61), [`meat/meat_test.go:640-727`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat_test.go#L640-L727)).

## How Meat validates elisions

### Source-anchored edit compiler

The model can request only three transformations against original 1-based lines: **remove** inclusive ranges; **fold** at least two contiguous same-marker source rows in one hunk into a machine-generated, common-indentation `...`; and **replace** a unique substring on one hunk source line with a visible elision projection. The compiler rejects malformed/overlapping ranges, metadata folds, mixed-polarity folds, remove/fold/replace conflicts, and folds crossing automatically hidden imports into behavior ([`meat/editplan.go:165-260`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L165-L260), [`meat/editplan.go:421-466`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L421-L466)).

A local replacement cannot silently rewrite code: `new` must contain `...` or `…`, every placeholder must stand for at least one omitted character, and all non-placeholder characters must match `old` in order. `old` must occur exactly once after the diff marker; replacements are bounded, valid UTF-8, single-line printable text ([`meat/editplan.go:285-359`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L285-L359), [`meat/editplan.go:558-648`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L558-L648)). Retained source must keep its owning file headers, paired `---/+++`, hunk header, rename/copy metadata pairs, and no-newline marker owner; a complete hunk or file may disappear, but an orphan shell may not remain ([`meat/editplan.go:669-743`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/editplan.go#L669-L743)).

### Moves and compiler-owned imports

Imports are classified from both diff sides and merged as a mandatory removal mask before model edits; import-only hunks/files and their framing are removed, and a no-newline marker cannot outlive its hidden source row ([`meat/imports.go:156-238`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/imports.go#L156-L238)). For every accepted exact move, aligned rows must have identical keep/remove/fold states and fold boundaries; retained aligned lines must also have equivalent local replacements after indentation normalization ([`meat/moves.go:352-438`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/moves.go#L352-L438)).

### Python chunk-local structural validators

For Python, compilation rejects:

- hiding a decorator while its definition remains, hiding a suite owner while its body remains, retaining a decorator without its definition, or retaining a suite owner without an indented semantic body/fold ([`meat/python.go:25-49`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L25-L49), [`meat/python.go:238-272`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L238-L272));
- hidden regions that cross expression/string boundaries, hidden simple assignments still referenced by retained rows, changed delimiter balance, severed backslash continuations, or changed triple-quote parity ([`meat/python.go:63-129`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L63-L129), [`meat/python.go:195-236`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L195-L236), [`meat/python.go:468-565`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L468-L565), [`meat/python.go:643-689`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/python.go#L643-L689)).

Automatic import removal is kept separate from judging the model’s Python plan. Where removing an import would empty a visible owner, Meat emits a fixed compiler-derived `...` body placeholder; while validating a partially retained hunk, it temporarily treats mandatory import rows as represented so the model is not blamed for compiler-owned removals ([`meat/imports.go:8-96`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/imports.go#L8-L96)).

## Oversized-diff chunking

- A single run must fit both raw and line-numbered forms under **400 KiB**. Input may be chunked up to **4 MiB** and **32 chunks**; beyond those limits Meat asks for a narrower range ([`meat/meat.go:47-55`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/meat.go#L47-L55), [`meat/chunk.go:38-50`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L38-L50), [`meat/chunk.go:82-102`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L82-L102)).
- Split priority is **between whole file sections**, then **between hunks in an oversized file**, then **synthesized sub-hunks inside one oversized hunk**. Continued file pieces replicate metadata; sub-hunks get exact recomputed `@@` starts/counts, so every chunk remains an independently valid unified diff ([`meat/chunk.go:1-14`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L1-L14), [`meat/chunk.go:394-529`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L394-L529), [`meat/chunk.go:557-687`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L557-L687)).
- Before cutting, Meat computes whole-diff import hiding, move-precedence hiding, and Python import placeholders. It does not cut no-newline ownership, multiline strings, Python open-bracket/backslash continuations, or a Python decorator/suite owner away from its first emitted semantic body row ([`meat/chunk.go:110-183`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L110-L183), [`meat/chunk.go:564-625`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L564-L625), [`meat/chunk.go:777-805`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L777-L805)).
- Each chunk runs the unchanged rubric with fresh 1-based coordinates. Chunk-local move detection is disabled because fragment occurrence counts can invent a move; whole-diff moves are mapped into a chunk only when both complete sides are contiguous there. Results are concatenated in source order, replicated metadata is deduplicated, summaries are deduplicated/joined, and token counts are summed ([`meat/chunk.go:13-27`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L13-L27), [`meat/chunk.go:903-1000`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L903-L1000), [`meat/chunk.go:1006-1043`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L1006-L1043)).

**Owner atomicity:** the splitter’s atomic unit recursively extends a visible Python decorator/suite owner through its first emitted kept/added body row; removed-side rows, dropped imports, comments, and blanks do not satisfy the owner. This prevents one chunk’s validator from hiding an owner while an unseen body survives in the next chunk ([`meat/chunk.go:587-625`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L587-L625)). It is deliberately limited: cross-chunk Python reference checks remain local, and a move or suite split across chunks cannot be globally enforced beyond that first-body-row protection ([`meat/chunk.go:23-27`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/chunk.go#L23-L27)).

## Candidate pattern taxonomy for Pith’s pre-pass skill

The harness agent should receive **candidate groups, not automatic deletions**. Each group should contain `{pattern_id, exemplar_old_new, occurrence_count, locations, semantic_exceptions}`; exact moves additionally contain paired old/new spans. This preserves Pith’s exemplar-plus-count interaction while leaving the co-review agent responsible for the semantic decision.

Recommended ordered taxonomy:

1. `generated-file` — whole generated sections; point to the hand-written generator/input change ([`meat/rubric.go:214`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L214)).
2. `import-scaffolding` — imports/includes/requires/use declarations, aliases, blocks, and recognized embedded-source imports; deterministic and whole-section-aware ([`meat/rubric.go:216`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L216), [`meat/imports.go:156-238`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/imports.go#L156-L238)).
3. `exact-move` — conservative paired relocation after indentation normalization; never emit only one side ([`meat/moves.go:58-196`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/moves.go#L58-L196), [`meat/moves.go:352-438`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/moves.go#L352-L438)).
4. `batch-field-copy` — repeated assignments/member projections/conversions; retain the operation owner and any distinct transform ([`meat/rubric.go:267-278`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L267-L278)).
5. `repeated-migration` — rename, changed signature, or repeated call-site old/new pairs; exemplar per distinct semantic boundary ([`meat/rubric.go:206`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L206)).
6. `forced-api-plumbing` — added zero-value return slots, context/parameter forwarding, and equivalent propagation; reject the group if timeout/cancellation/value/return behavior differs ([`meat/rubric.go:212`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L212), [`meat/rubric.go:321-326`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L321-L326)).
7. `error-prose` — format/log/error-message arguments local to preserved error control flow; exclude identity, wrapping, type/status/category, and asserted/public text ([`meat/rubric.go:210`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L210), [`meat/rubric.go:262`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L262)).
8. `test-suite-repetition` — repeated setup/teardown, cases, calls, assertions, fixture construction, parametrized middle values; annotate the owner, stimulus, and outcome dimensions that must survive ([`meat/rubric.go:242-263`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L242-L263)).
9. `multiline-bulk` — repetitive interiors of calls, literals/tables, strings, comprehensions, signatures, and decorator arguments; preserve owner/opener/closer and distinctive rows ([`meat/rubric.go:256-260`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L256-L260)).
10. `context-and-prose` — routine git context, blanks, unchanged narrative comments/docstrings, issue/changelog restatements; exclude contracts, security/compatibility caveats, rationale, provenance, and needed control structure ([`meat/rubric.go:206-208`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L206-L208)).
11. `format-only` — gofmt/alignment-only edits and redundant mechanical rename spelling; lowest-priority semantic risk ([`meat/rubric.go:212`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L212)).

For every group, tell the harness agent to retain a second exemplar when it reveals a distinct contract, condition, lifecycle edge, transformation, effect, compatibility/security boundary, stimulus, or outcome. That directly carries Meat’s “one representative unless semantically distinct” rule into Pith without pretending a textual pre-pass can make the reviewer’s decision ([`meat/rubric.go:204-220`](https://github.com/boldsoftware/meat/blob/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3/meat/rubric.go#L204-L220)).

## Review findings and residual risks

- **No blocker — `meat/rubric.go:192-359`, `meat/editplan.go:165-378`:** the source provides a concrete rubric, immutable edit protocol, and machine-side validation suitable for deriving Pith candidate groups.
- **Medium — `meat/chunk.go:23-27`, `meat/chunk.go:1006-1043`:** move symmetry, Python reference validation, and suite atomicity are incomplete when related spans land in different chunks; Pith should preserve whole-change group identity across its own chunk/context boundaries.
- **Medium — `meat/rubric.go:192-359`:** generated-code, forced-plumbing, prose, test-suite, and repetition judgments are model-guided rather than proven classifiers. Pith should label them candidates with exceptions, never silently hide them.
- **Low — `meat/rubric.go:216`, `meat/imports.go:156-238`:** Meat’s unconditional import policy intentionally hides even security-relevant package substitution; Pith’s co-review UI may prefer a visible “import group hidden” indicator because its product goal is live human co-review rather than Meat’s final reading diff.

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings cite commit-pinned primary-source URLs and identify file paths/severity in Review findings and residual risks."
    }
  ],
  "changedFiles": [
    "/tmp/pith-research/r4-meat-rubric.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git clone --depth 1 https://github.com/boldsoftware/meat /tmp/pith-src/meat",
      "result": "passed",
      "summary": "Cloned commit f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3 outside the current repository."
    },
    {
      "command": "cd /tmp/pith-src/meat && go test ./...",
      "result": "passed",
      "summary": "Both meat.dev/cmd/meat and meat.dev/meat test packages passed."
    },
    {
      "command": "git -C /tmp/pith-src/meat status --porcelain=v1",
      "result": "passed",
      "summary": "The inspected clone was clean after research and tests."
    },
    {
      "command": "python3 artifact structure/citation/acceptance JSON checks",
      "result": "passed",
      "summary": "Validated 86 commit-pinned source links, parsed the acceptance report, and confirmed the gist is the final line."
    },
    {
      "command": "git diff --cached --quiet",
      "result": "passed",
      "summary": "Confirmed the current pith repository has no staged files."
    }
  ],
  "validationOutput": [
    "ok meat.dev/cmd/meat",
    "ok meat.dev/meat",
    "Pinned RubricHash at inspected commit: 441f5e6e28ad3add",
    "Research artifact is outside the pith working tree."
  ],
  "residualRisks": [
    "medium: meat/chunk.go:23-27 - cross-chunk move/Python reference/suite guarantees are intentionally incomplete.",
    "medium: meat/rubric.go:192-359 - most semantic-noise categories are agent judgments, so Pith should emit candidates rather than auto-elide.",
    "low: meat/imports.go:156-238 - unconditional import hiding can conceal package-substitution evidence unless Pith surfaces group metadata."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added one external Markdown research artifact; the current pith repository was not modified.",
  "reviewFindings": [
    "no blocker: meat/rubric.go:192-359 and meat/editplan.go:165-378 - rubric and validation flow are concrete and source-attested.",
    "medium: meat/chunk.go:23-27 - related move/Python spans split across chunks lose whole-diff enforcement.",
    "medium: meat/rubric.go:192-359 - non-import/non-move taxonomy entries are model-guided candidates, not deterministic proof.",
    "low: meat/imports.go:156-238 - unconditional import removal may be too opaque for a live co-review UI."
  ],
  "manualNotes": "Primary sources only; inspected shallow clone remained clean."
}
```

One-line gist: Meat keeps behavior and data-flow anchors while source-validating visible compression of imports, generated output, repetition, forced plumbing, error prose, tests, and exact moves; Pith should hand these to its harness as exception-annotated candidate groups, never silent elisions.
