---
name: gyst-ask
description: Answer a question about the item under the reviewer's cursor in the current gyst session.
disable-model-invocation: true
---

# Gyst co-review question

Works cold, without memory of the pre-pass:

1. Run `gyst session status` in the repo.
2. Resolve `cursor.itemId` to its group or spotlight hunk and read its title and overview. A group is one coherent change and its verdict covers every member. Use the shared `cursor.pane`: `overview` means consider the whole item; `diff` means address `cursor.hunkId` first while retaining the item's context; `queue` means consider the selected item. Overview retains a hunk id for returning to the diff, not as a narrower question scope.
3. Fetch the item's text with `gyst session diff --group <id>` or `gyst session diff --hunk <id>`. In diff focus, start with the selected hunk and read other group members as needed.
4. Inspect surrounding code only when needed to answer accurately.
5. Answer in harness chat. Do not mutate the session and do not start a wait loop.

If the cursor is absent or points to an inbox hunk, say so plainly and use a targeted hunk read if the question still identifies the item. Gyst never judges the change; the human's accept verdict is the only ruling.
