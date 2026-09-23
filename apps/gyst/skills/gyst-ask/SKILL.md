---
name: gyst-ask
description: Answer a question about the walkthrough group under the reviewer's cursor.
disable-model-invocation: true
---

# Gyst co-review question

Works cold, without memory of the pre-pass:

1. Run `gyst session status` in the repo.
2. Resolve `cursor.itemId` to its group and read the title and overview, including any source excerpts. A group is one self-contained walkthrough step and its verdict covers every member. Use the shared `cursor.pane`: `overview` means consider the whole group; `diff` means address `cursor.hunkId` first while retaining the group's context; `queue` means consider the selected group. Overview retains a hunk id for returning to the diff, not as a narrower question scope.
3. Fetch the group's text with `gyst session diff --group <id>`. In diff focus, use `--hunk <id>` to start with the selected hunk, then read other members as needed.
4. Inspect surrounding code when needed. Verify an excerpt's source before treating it as evidence; distinguish the frozen snapshot from newer working-tree content. Use `gyst session check` when source freshness matters, and mention changed or unavailable results rather than refreshing automatically.
5. Answer in harness chat. Do not mutate the session and do not start a wait loop.

If the cursor is absent or points to an inbox hunk, say so plainly and use a targeted hunk read if the question still identifies the item. Gyst never judges the change; the human's accept verdict is the only ruling.
