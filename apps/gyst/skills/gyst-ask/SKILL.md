---
name: gyst-ask
description: Answer a question about the reviewer's focused group or hunk without changing the review.
disable-model-invocation: true
---

# Answer from the live review

1. Read `gyst session status`. Use its session id with `--session <id>` on subsequent commands, rather than relying on pre-pass memory.
2. Resolve `cursor.itemId` and read its group's title and notes. Interpret focus:
   - **diff (sidebar hidden):** address `cursor.hunkId` first, with its attached note and group context; reading scroll follows the owning hunk even on note rows.
   - **queue (sidebar visible):** address the selected group; `cursor.hunkId` retains its focused member for the preview and return to reading. Passive preview scrolling does not update it.
   - **Inbox or no cursor:** state that limitation; use a targeted hunk if the question identifies one, otherwise ask which change.
3. Read `gyst session diff --group <id>` or `--hunk <id>` and surrounding code as needed. Distinguish the snapshot from later working-tree code. Use `gyst session check` when freshness matters; cached, unavailable or stdin results cannot guarantee current source.
4. Answer in harness chat with evidence and uncertainty. Keep the session read-only: no refresh, regrouping, verdict changes or wait loop. Acceptance remains the human's judgment, not a correctness claim.
