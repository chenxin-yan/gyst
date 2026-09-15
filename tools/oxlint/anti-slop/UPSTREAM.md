# Upstream provenance

Vendored from the owner's copy in [chenxin-yan/crust](https://github.com/chenxin-yan/crust)
(`tools/oxlint/anti-slop/` at `58f4c378`), which itself vendors
<https://github.com/dmmulroy/anti-slop> (`src/` → this directory). The upstream project is
designed to be vendored and forked; this copy is owned here and diverges deliberately.

|                  | Revision                                   |
| ---------------- | ------------------------------------------ |
| Base             | crust `58f4c378` (upstream base `6d53855`) |
| Reviewed through | upstream `c44ef22` (2026-09-10, v0.1.2+)   |

Upstream `HEAD` was `c44ef22` when this copy was made, so nothing newer exists to port.

## Adopted rules

All thirteen rules registered in `index.ts`: `no-array-filter-map`, `no-chained-type-assertions`,
`no-known-value-widening`, `no-module-mocking`, `no-object-parameters`,
`no-reduce-accumulator-copy`, `no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`,
`no-unknown-type-aliases`, `no-unsafe-dictionary-type`, `no-widen-then-assert`,
`require-safety-comment-for-type-assertion`.

## Local deviations (keep on future updates)

Inherited from crust:

- `no-module-mocking`: also detects Bun `mock.module` (`bun:test`) and Jest `setMock`;
  resolves namespace imports.
- `no-unknown-parameters`: local `allowInBoundaryFunctions` option.
- `shared/array-method`: `isKnownArrayExpression` also accepts unshadowed `Object.entries/keys/values`
  and `Array.from` results and `x as T[]` assertions; `isGlobalOwner` lives here instead of inside
  `no-reduce-accumulator-copy`.
- `no-widen-then-assert`: `Record`/`Readonly`/`PropertyKey` are only treated as built-ins when the
  file does not declare or import its own module-level binding; non-generic aliases are followed
  (reuses `createTypeEnvironment`).
- Helpers split into `shared/{parameters,scope,type-aliases}.ts`; upstream names them
  `shared/function-parameters.ts` and `shared/type-alias-resolution.ts`.
- Upstream's `x as unknown as T` double-casts are rewritten so the plugin passes its own rules.
- Tests run under Node's test runner (`bun test` cannot host Oxlint `RuleTester`).

Gyst-specific:

- Formatted with this repo's `oxfmt` (two spaces), so diffs against crust show whitespace churn.

## Intentionally not vendored

- Upstream's 2026-08-31 semantic fixes to the ten original rules (`63d6966`..`298c993`). Measured
  on gyst 2026-09-15 at stack tip `258cbf2`: `oxlint --format=json` over the whole repo with the
  vendored rules, then again with upstream `c44ef22` `src/` rules registered under the same
  thirteen names. No diagnostic delta on gyst code (0 → 0). Upstream cannot run this config as-is
  (`no-unknown-parameters` has no `allowInBoundaryFunctions`); with that option held out on both
  sides the only change is upstream exempting a type-predicate subject the option already covers.
  A three-way merge into customized files is not worth zero enforcement change.
- `require-readable-spacing` (+ vendored eslint-stylistic): formatting is `oxfmt`'s job.
- `no-shape-in-symbol-names`, `no-conditional-empty-object-spread`: `...(cond ? { k } : {})` is
  the accepted idiom here.
- `no-reflect-apply` / `no-reflect-get`: covered by `eslint/no-restricted-properties`.
- `effect/*`: gyst imports `effect` only for `Schema`. Run once against the stack, the only rule
  that fired was `prefer-effect-match`, four times, all on two- or three-way literal ternaries
  (a Solid TUI colour lookup and a decoder pick). Pulling `Match` into those files is heavier than
  the ternary, and the other four rules target Effect services and tagged errors gyst does not
  have.

## Updating

```bash
git clone https://github.com/dmmulroy/anti-slop .agent-sources/anti-slop   # git-ignored
git -C .agent-sources/anti-slop diff c44ef22..HEAD -- src/
```

Also diff against crust's `tools/oxlint/anti-slop/` for owner-side changes. Port reviewed changes
by hand; do not overwrite this directory. Bump the table above and extend the lists.
