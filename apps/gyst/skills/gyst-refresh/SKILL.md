---
name: gyst-refresh
description: Use when the user asks to incorporate code edits into an existing gyst review, regroup its snapshot, or revise groups after pressing r. Align the walkthrough with the reviewed diff while preserving unrelated human progress.
---

# Update a walkthrough

Load the `gyst` skill's planning, authoring and publication rules as reference; continue the existing session rather than starting its workflow.

## 1. Choose the snapshot

Take the session id from the conversation, or from `gyst session list` for this repository and the scope under discussion; ask if several match. Read `gyst session status --session <id>`; record the scope, revision, groups and Viewed hunks. Pass `--session <id>` to every subsequent command. If no session exists, direct the user to `gyst` and stop. Ask before changing scope.

| User request                                                              | Action                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Include my latest edits” or `/gyst-refresh`                              | Run `gyst session refresh --session <id> --snapshot <snapshotId> --request-id <fresh-uuid>`; it recaptures the recorded scope. Fetch refs first if needed. |
| “I pressed r; update the groups” or “Split this group without refreshing” | Use the current snapshot.                                                                                                                                  |

A source-change notice alone calls for informing the user and asking whether to refresh. `--snapshot` is the snapshot id from the status you read. If the reply is lost, retry with the same request id; it returns the recorded result. `stale_revision` means the snapshot was already replaced: reread status instead of refreshing again. `replaced: false` means the capture was identical and nothing changed.

## 2. Reconcile and publish

Reread status and `gyst session diff --session <id>`. Reassess affected code and tests. Refresh keeps a hunk's id, group and Viewed only when its body matches exactly; new hunks are ungrouped. Groups keep their order, and a group that lost every hunk stays in place, empty, until you repair or dissolve it. Notes move with their code when it only shifted. Guidance whose code or referenced lines changed is kept and marked `outdated` (`code` or `references`); `preparation` lists it, and the walkthrough is not complete until each is repaired. A note whose range no longer exists keeps its old anchor and captured code. Plan coverage for every current hunk while preserving unrelated groups and their order.

For each Outdated text, check it against the current snapshot, including the code its references point at: rewrite it with `note.update`, `group.update` or `walkthrough.update`, or keep its wording with `note.revalidate`, `group.revalidate` or `walkthrough.revalidate`. Re-anchor a note to a current range with `note.update` and `anchor`, keeping its id, before revalidating it. Do not revalidate what you have not checked, or what references code the snapshot lacks.

Revise affected groups with `group.update` (optional title, overview, memberHunkIds, files) and their notes with `note.create`, `note.update` and `note.remove` by id, or dissolve/create groups to split or merge them. Follow `gyst`'s atomic publication and retry rules. Explain restructuring; avoid no-op updates.

## 3. Hand back

Verify every current hunk belongs to a group, or report the remaining ungrouped hunks or blocker. Summarize what refreshed, which groups changed, preserved progress and what needs re-review. The open viewer updates without restarting.
