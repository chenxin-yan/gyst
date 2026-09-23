---
name: gyst-refresh
description: Use when the user asks to incorporate code edits into an existing gyst review, regroup its snapshot, or revise groups after pressing r. Align the walkthrough with the reviewed diff while preserving unrelated human progress.
---

# Update a walkthrough

Load the `gyst` skill's planning, authoring and publication rules as reference; continue the existing session rather than starting its workflow.

## 1. Choose the snapshot

Read `gyst session status`; record the source, revision, groups and acceptance. Pin subsequent commands with `--session <id>`. If no session exists, direct the user to `gyst` and stop. Ask before changing scope.

| User request                                                              | Action                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| “Include my latest edits” or `/gyst-refresh`                              | For Git, run `gyst session refresh --session <id>`; replay the recorded scope, fetching refs first if needed.              |
| “I pressed r; update the groups” or “Split this group without refreshing” | Use the current snapshot.                                                                                                  |
| Refresh a stdin snapshot                                                  | Obtain a same-scope replacement patch; pipe to `gyst session refresh --session <id> --stdin`. Ask and stop if unavailable. |

A source-change notice alone calls for informing the user and asking whether to refresh.

## 2. Reconcile and publish

Reread status and `gyst session diff --session <id>`. Reassess affected code and tests. Refresh preserves notes and acceptance only when every member survives confident matching. Losing any member clears the surviving group's notes and verdict; reauthor that group's context rather than reattaching old notes by proximity. Plan coverage for every current hunk while preserving unrelated accepted groups and their order.

Revise affected groups with `group.update` (optional title, notes, memberHunkIds), or dissolve/create groups to split or merge them. Omitting notes retains them; supplying notes replaces the complete array, and `[]` clears it. Replace notes when new membership would invalidate an anchor. Follow `gyst`'s atomic queue and retry rules. Explain restructuring; avoid no-op updates because even a note-only update resets acceptance.

## 3. Hand back

Verify current status is ready, or report the remaining inbox work or blocker. Summarize what refreshed, which groups changed, preserved progress and what needs re-review. The open TUI updates without restarting.
