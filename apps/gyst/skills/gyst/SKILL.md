---
name: gyst
description: Use when the user asks for a gyst walkthrough of uncommitted changes, a Git range or a GitHub PR, or asks to revisit, refresh or regroup an existing gyst session. Opens the session headlessly, plans full coverage, publishes complete groups progressively and sends the human the session's link.
---

# Prepare a walkthrough

Gyst helps a human build the mental model they need to judge a change. You prepare a **walkthrough** in a gyst session: an overall overview and an ordered list of **groups**, each one review question with a title, an overview, its hunks and notes on the logical steps. The human reads it in the browser and marks hunks Viewed, which means read, not approved. You never mark Viewed, resolve threads or judge the change for them.

Before writing any guidance, read [the authoring reference](references/authoring.md); [the examples](references/examples.md) show complete batches. Use the `gyst-cli` skill for exact command syntax, the `apply` envelope and its ops, JSON output and error codes.

## 1. Open the session

Open headlessly; this never starts a browser:

- Uncommitted changes, including untracked files: `gyst session open`.
- A Git range, recorded as written over the whole repository: `gyst session open main...feature` (or `main..feature`).
- A GitHub PR, from a clone of its repository: `gyst session open --pr <number>` or `--pr <PR URL>`. It captures the PR's own merge-base-to-head range without touching the checkout.
- A saved session the human names: `gyst session open --session <id>`.

Keep `session.id`, `session.snapshotId` and `link` from the reply exactly as returned. Every later command names `--session <id>`; never select a session by the current directory or by guessing from `gyst session list`.

`created: false` means the saved session for that scope came back as it was. Reopening never refreshes the snapshot, rewrites guidance or deletes anything; continue from its status (section 6) instead of starting over. Ask before changing the scope the user asked for.

## 2. Understand the whole change

Read `gyst session status --session <id>` and `gyst session diff --session <id>` (narrow with `--file`, `--group` or `--hunk`). Read surrounding code, callers and the relevant tests from the snapshot with `gyst session files` and `gyst session code`, passing `--snapshot <snapshotId>`. The snapshot is what the human reviews; the live checkout may have changed since.

A PR session's status has `pullRequest`: the selected PR with its title and description, and its native stack in order with each layer's title, description, base, head and state. `stack.verifiedAt` says when GitHub last confirmed it; `unavailable` says the latest discovery failed, so membership is unknown, not absent. `sessions` lists only the layers already opened. Use the whole stack as context, but prepare only the selected PR's session. Titles and descriptions are claims, not proof: code from lower layers is inside this snapshot as unchanged source, so read it there. To check another layer's own change, read its commits in Git, or open its session only if you must, knowing that leaves a plain saved session for that layer. Never prepare, reply or refresh in another layer's session. `gyst session check --session <id> --stack` rechecks stack metadata only.

## 3. Plan coverage and order

Before publishing anything, assign **every hunk of the snapshot to exactly one planned group** and fix the order. Group by review question, not by file: an entry point, its implementation and its tests can belong together; an independent change can be a one-hunk group; mechanical changes belong somewhere too. Files Git attributes mark generated or vendored (`generated` in status `files`, `generatedFiles` in diff) start folded for the human; group them like any other change. Order concepts before consequences, and members along the explanation, such as entry point, behavior, then tests. Keep the plan in your own context; publish only finished groups.

## 4. Write the guidance

Follow [the authoring reference](references/authoring.md): mental model first, complementary overviews, notes on logical steps with valid ranges, examples for behavior and invariants, exact captured references, safe Markdown and Mermaid, and honest evidence that tells sketches, inspected tests and executed checks apart. Guidance must stand alone without this chat.

## 5. Publish progressively

Pipe one JSON batch at a time to `gyst session apply --session <id>`. Its `snapshotId` and `revision` come from status, then from each successful reply. The first batch carries the walkthrough overview and the first complete groups; each later batch appends the next complete group or a few consecutive ones, with all their notes. A batch is validated as a whole and applied all or nothing, so the human never sees a half-written group.

- Success: the reply is the new status; use its `revision` for the next batch.
- Lost reply (timeout, killed process, no JSON): resend the identical batch with the same `idempotencyKey`. It returns the recorded result and applies nothing twice. That result is history: reread status before building the next batch.
- `validation_failed`: fix what `detail` names and send the corrected batch under a new key.
- `stale_revision`: someone else changed the session, usually the human. Reread status, reconcile and send the rebuilt batch under a new key.

**Once the first groups are published, send the human the `link` from `gyst session open`** in one short message, saying the walkthrough is still being published and they can start reading. Do not ask them to run `gyst` or start a viewer; the daemon already serves the link. The viewer shows later batches as they land without moving the reader.

Continue at complete-group boundaries until status reports `preparation.state` as `complete`: a walkthrough overview, every group overview, every current hunk in exactly one group and no Outdated guidance.

## 6. Revisit, refresh or regroup

The same workflow continues an existing session; there is no separate refresh workflow.

- **Revisit** (`created: false`, or the user names a session): read status. `preparation` lists what is missing: ungrouped hunks (`groupedHunks` against `totalHunks`), missing overviews, and Outdated guidance (`overviewOutdated`, `groupsOutdated`, `notesOutdated`). Complete or repair that work; leave finished groups alone.
- **Refresh** only when the human asks for the session to include newer code: `gyst session refresh --session <id> --snapshot <snapshotId> --request-id <new id>`, with the snapshot id you read. Choose the request id before running it and reuse it only to retry a lost reply. `replaced: false` means the capture was identical and nothing changed; `stale_revision` means it was refreshed already, so reread status rather than refreshing again. Fetch remote refs first when the scope names them. Then repair as the reference's "After a refresh" section says.
- **Regroup** without refreshing when the human asks to split, merge or reorder groups: `group.update`, `group.dissolve`, `group.create` and `walkthrough.update` with `groupOrder`, on the current snapshot.
- `gyst session check --session <id>` says whether the recorded scope has changed since capture. It is a notice, not authorization to refresh; `unavailable` proves nothing either way.

## 7. Report and stop

Tell the human what you published, what is still missing and why, and anything you could not verify. Leave reading, Viewed and resolving threads to them. Human comments are answered by the `gyst-respond` workflow when the human invokes it.
