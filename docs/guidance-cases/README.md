# Guidance cases

Four fixed Git repositories for checking that the authoring instructions `@gyst/cli` ships produce
useful standalone guidance. Each case is generated once by an agent in a fresh session that has
only the installed package's skills, checked by gyst's own preparation status and then judged by
a human. This is the guidance-quality gate of the
[web review spec](../plans/web-review-ui.md#phase-4--production-reading-ui-and-workflows), not a
benchmark: there is no harness, model matrix, score or prose snapshot.

Only a human gives the verdict. An agent may generate a case, run the structural check and fill
in the record's inputs, but never the verdict.

## The cases

Each `.bundle` file is a complete repository with fixed author, committer and dates, so a clone
always has the commits listed here. Each is a small TypeScript project whose tests run with
`npm test` on Node 24, without installing anything.

| Case                 | What it checks                                                     | Scope               | Hunks |
| -------------------- | ------------------------------------------------------------------ | ------------------- | ----- |
| `behavior-edge-case` | An observable behavior change and its edge cases                   | `main...feature`    | 9     |
| `invariant-refactor` | An internal refactor that must preserve invariants                 | `main...feature`    | 4     |
| `caller-and-helper`  | Changed callers that are correct only because of unchanged helpers | `main...feature`    | 7     |
| `stack-layer`        | One selected layer of a three-layer stack, in its stack context    | `layer-1...layer-2` | 4     |

- **`behavior-edge-case`:** `fetchJson` used to retry every failure. It now fails at once on
  4xx other than 408 and 429, waits as long as a `Retry-After` header asks, and gives up rather
  than wait longer than `maxDelayMs`. The edge cases are a `Retry-After` date already in the past,
  an unreadable value and a wait above the cap. Commits: `main` `8375991bbdb936544ef57d7ecc6a3de8b4280ef7`,
  `feature` `eee7cb5df50a952ac2ce23283eca3f847877565c`.
- **`invariant-refactor`:** `LruCache` drops its separate recency array and keeps recency in its
  `Map`'s insertion order. Its public behavior is meant to be unchanged: `get` and `set` count as
  a use, `has` and `peek` do not, replacing a key never evicts, and an eviction is reported after
  the entry leaves and before the new one arrives. The unchanged `memoize` relies on these rules.
  Commits: `main` `0f1f45e03bb391055779e377449fd1a3ee8f7f42`, `feature`
  `3b8049333b26a922e446833aabcafa3b4b8964f4`.
- **`caller-and-helper`:** sign-up and login now pass `normalizeEmail(email)` to
  `AccountStore.findByKey`. Whether that is right depends on two files the change does not touch:
  `src/email.ts` (what normalizing does, including Gmail dots and `+tags`) and
  `src/accounts/store.ts` (`save` keys by the normalized address; `findByKey` does not normalize).
  Commits: `main` `97dd67699556e149190fb38119ad71f7e273a2c5`, `feature`
  `e1f93c1c97071088c82440d8f4dc12534d3455c2`.
- **`stack-layer`:** invoice totals move from dollar floats to integer cents, the middle layer of
  a local stack. It uses the money helpers from the layer below (unchanged code inside its
  snapshot), and the layer above builds a CSV export on its result. Commits: `main`
  `c8dad9d0f77c06c51a538125cbeadc019af27f4a`, `layer-1` `1bbfbcd993c92cbdae710aa17ad8e5ad353380f1`,
  `layer-2` `89290501ce1c6ca8607af054b9e81df57e00869d`, `layer-3`
  `61b5e75d5e5be56e79a10c5ce41b6083199cda5a`.

`stack-layer` stands in for a GitHub PR stack: a real one needs network access, `gh` and a hosted
repository, so the case is not self-contained. The selected layer is a recorded range instead,
and each layer's commit message stands in for its PR description. The range captures the selected
layer's own commit message with its snapshot, and the viewer shows it in the Commits entry where a
PR session shows its description. The other layers' messages are outside the range, so the agent
is given the stack context below in its request, in place of the stack metadata a PR session's
status would carry. Every claim in it can be checked against the clone's branches.

> This range is the middle layer of a local three-layer stack, oldest first. Each layer is one
> commit on the branch below it, and its commit message is its description:
>
> 1. `layer-1` (`main...layer-1`): Add integer-cent money helpers.
> 2. `layer-2` (`layer-1...layer-2`): Compute invoice totals in integer cents. This is the selected layer.
> 3. `layer-3` (`layer-2...layer-3`): Export invoices as CSV.
>
> Prepare only the selected layer. The titles are claims, not proof: read the other layers with
> Git when a claim about them matters.

## Generating a case

Generate from a packed and globally installed `@gyst/cli`, never from a checkout's source CLI or a
skill copied anywhere else.

1. Pack the revision under test and install it outside the checkout:

   ```sh
   pnpm install --frozen-lockfile
   NODE_ENV=production pnpm --dir apps/gyst build
   pnpm --dir apps/gyst pack --pack-destination /tmp/gyst-cases/pack
   npm install --global --prefix /tmp/gyst-cases/prefix /tmp/gyst-cases/pack/gyst-cli-*.tgz
   export PATH=/tmp/gyst-cases/prefix/bin:$PATH   # check with: command -v gyst
   ```

2. Clone the case. The refspec makes every branch a local branch, so the scope resolves as
   written:

   ```sh
   git clone -c 'remote.origin.fetch=+refs/heads/*:refs/heads/*' \
     docs/guidance-cases/<case>.bundle /tmp/gyst-cases/<case>
   ```

3. Link the package's skills into the clone with `gyst skills install --scope project --all`, run
   there. The links point into the installed package, so the agent reads exactly what it ships.
   They are untracked files, which a range scope does not capture.
4. Start a new agent session in the clone, with no earlier conversation, no other gyst skill
   (check the harness's global skill directories) and no private authoring instructions. Give it a
   private `GYST_DATA_DIR`, and a `GYST_PORT` if another gyst may hold the default port. Ask it,
   through the harness's way of invoking the `gyst` skill, to prepare a gyst walkthrough of the
   case's scope in this repository. For `stack-layer`, add the stack context above verbatim.
5. Let it run to the end without help. If it asks something, record the question and your answer:
   the guidance has to stand without them, so a case that needed one is judged with that in mind.
6. Record the result as described below, before reading the walkthrough in the viewer
   (`gyst --session <id>`).

Do not edit the output. A retry is a new attempt with its own record, not a replacement.

## The structural check

Use gyst's own validation; there is no second validator. Every `gyst session apply` batch is
already validated as a whole by the same code the viewer depends on: walkthrough and group
overviews, unique hunk membership and order, note anchors inside their own group's hunks,
supported Markdown and Mermaid, and references to exact captured content. A rejected batch is
part of the attempt, not a failed case, if the agent corrected it.

The case passes the check when, after the agent stops,
`gyst session status --session <id>` reports `preparation.state` as `complete`:
`groupedHunks` equals `totalHunks`, `overviewMissing` is `false`, and `groupsMissingOverview`,
`groupsOutdated` and `notesOutdated` are empty. A case that is not `complete` fails without a
human reading.

## The human rubric

The reader knows TypeScript but not this code. They read the walkthrough in the viewer beside
the code, with nothing else: not the agent's chat or this README. Judge each dimension that
applies:

- **Correctness and evidence:** every claim is true of the snapshot; references point at the
  code that supports them; sketches, inspected tests and executed checks are told apart.
- **Mental-model clarity:** the overview gives the model that makes the diff obvious: before and
  after for a behavior change, the preserved invariant for a refactor.
- **Meaningful-step coverage:** notes cover the logical steps and the non-obvious consequences,
  not every line; nothing important is left unexplained.
- **Useful examples and references:** a before/after or usage example where behavior changes;
  links to unchanged supporting code where the change depends on it.
- **Standalone readability:** it makes sense without the session's chat, private tools or
  knowledge of this case.
- **Economy:** concise overviews and short notes; no repetition between overviews; no restated
  code.

Every case must be usable without substantive rewriting. Cosmetic nits do not block. A factual
error, a misleading claim or missing context that the reader needs fails the case. One weak case
is not averaged away by three good ones, and the gate stays open while any case fails.

## Recording results

Copy [`results/TEMPLATE.md`](results/TEMPLATE.md) to `results/<date>-<case>-<attempt>.md`, and
save the final status beside it:

```sh
gyst session status --session <id> > docs/guidance-cases/results/<date>-<case>-<attempt>.status.json
```

The status holds the whole walkthrough: overview, groups, members and notes, exactly as
published. The record names the instruction revision, the case inputs, the model and harness,
the outputs and the human verdict with concrete reasons.

Keep every record. A failed attempt stays when the case is regenerated, and an accepted output
stays when a later change regenerates it. Do not pick the best of several attempts: the first
attempt after a change is the one judged.

## When to run it again

Regenerate after a change to what the generating agent reads or what validation accepts:
`apps/gyst/skills/gyst/` (the workflow, `references/authoring.md` and `references/examples.md`),
the generated `gyst-cli` reference for the session commands, or the authoring validation in
`packages/core`. The previous verdict no longer covers the new instructions.

- A broad rule, one that shapes all guidance, affects all four cases. That includes the
  workflow's planning and publishing steps and the authoring reference's sections on purpose and
  reader, the pieces, notes and their ranges, evidence, Markdown and standalone guidance, and
  the opening of "Mental model first".
- A rule specific to one kind of change, such as one bullet under "Mental model first", affects
  its cases: behavior changes and edge cases (`behavior-edge-case`, `stack-layer`), refactors
  (`invariant-refactor`), references (`caller-and-helper`, `stack-layer`) and stack context
  (`stack-layer`).
- When unsure, rerun all four.

Changing a case's repository changes its commits; rerun that case and list the new commits here.
