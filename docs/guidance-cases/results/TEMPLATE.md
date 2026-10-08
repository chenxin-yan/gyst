# `<case>`, attempt `<n>`, `<date>`

## Inputs

- **Instruction revision:** gyst commit `<sha>` the package was packed from; last commit to
  `apps/gyst/skills/gyst/`: `<sha>`; `@gyst/cli` `<version>`, tarball sha256 `<sha256>`.
- **Case:** `<case>.bundle`, scope `<scope>`, commits `<branch> <sha>`, ...
- **Request given to the agent:** the exact text, including the stack context for `stack-layer`.
- **Model and harness:** `<harness> <version>`, `<model>`, settings that differ from defaults.
- **Fresh session:** how other skills, earlier conversations and private instructions were kept
  out.
- **Previous attempts:** links to earlier records for this case, or none.

## Outputs

- **Session:** `<session id>`, snapshot `<snapshot id>`.
- **Final status:** [`<date>-<case>-<n>.status.json`](<date>-<case>-<n>.status.json).
- **Rejected batches:** each `validation_failed` or `stale_revision` the agent hit, and what it
  changed.
- **Questions:** anything the agent asked and the answer it got, or none.

## Structural check

`preparation` from the final status: `state`, `groupedHunks` of `totalHunks`, and any missing
overviews or Outdated guidance.

## Human verdict

Filled in by the human evaluator only.

- **Evaluator and date:**
- **Correctness and evidence:**
- **Mental-model clarity:**
- **Meaningful-step coverage:**
- **Useful examples and references:**
- **Standalone readability:**
- **Economy:**
- **Verdict:** accepted / failed, with the concrete reasons.
