---
name: gyst-ask
description: Answer a question about a group or hunk in the review without changing the review.
disable-model-invocation: true
---

# Answer from the live review

1. Take the session id from the conversation, or from `gyst session list` for this repository and the scope under discussion; ask if several match. Read `gyst session status --session <id>` and pass `--session <id>` to every subsequent command, rather than relying on pre-pass memory.
2. Identify the group or hunk the question targets and read its title and notes; ask which change if the question does not identify one.
3. Read `gyst session diff --session <id>` with `--group <id>` or `--hunk <id>`, and surrounding code, as needed. `gyst session code --session <id> --snapshot <snapshotId> --file <path> --side old|new` reads snapshot code as captured; the live checkout is later working-tree code. Distinguish the snapshot from later working-tree code. Use `gyst session check` when freshness matters; cached or unavailable results cannot guarantee current source.
4. Answer in harness chat with evidence and uncertainty. Keep the session read-only: no refresh, regrouping or wait loop.
