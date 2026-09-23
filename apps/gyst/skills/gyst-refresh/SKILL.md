---
name: gyst-refresh
description: Update an existing gyst walkthrough when the user asks to incorporate code edits into the review, regroup the current snapshot, or revise groups after a TUI refresh. Use it to keep grouping and explanations aligned with the reviewed diff while preserving unrelated human progress. A source-change notice alone is not a request to refresh.
---

# Refresh a gyst walkthrough

Read the [gyst authoring skill](../gyst/SKILL.md) for whole-snapshot planning, self-contained explanations, atomic publication and retry rules. Continue the existing session rather than running its session-creation step.

## 1. Select the session and snapshot

Run `gyst session status` in the repository. Record its session id, source, revision, groups and acceptance state; use `--session <id>` on subsequent session commands so a replacement session cannot receive this work. If there is no session, direct the user to `/gyst` and stop. If the requested scope differs from the recorded source, ask before replacing the session.

- For `/gyst-refresh` or a request to incorporate the latest code changes, run `gyst session refresh --session <id>` for a Git session. This replays its recorded scope, not an arbitrary working-tree diff. Fetch remote refs first only when the requested update requires it.
- If the user already refreshed with `r`, or requests regrouping without new code, work with the current snapshot without refreshing again.
- To refresh a stdin session, obtain a replacement patch for the same scope from the user or its original producer and pipe it to `gyst session refresh --session <id> --stdin`. If it is unavailable, ask for it and stop rather than substituting a Git diff.

A source-change notice by itself calls for informing the user, not replacing the snapshot. Confirm a refresh request before proceeding in that case.

## 2. Reconcile the walkthrough

Reread status and `gyst session diff --session <id>`. Compare with the previous groups and inspect affected implementation, callers, tests and source excerpts. Apply the gyst skill's planning and refresh rules: account for every current hunk, keep unrelated accepted groups and their order, and deliberately revise affected explanations and membership. Retained prose is a proposal, not proof that it still describes the code.

Publish only the required group changes with the resulting queue in the same `gyst session apply --session <id>` batch, following the gyst skill's revision and idempotency rules. Split or merge groups when the new review questions warrant it; explain necessary restructuring rather than silently rebuilding the whole walkthrough. Avoid no-op group updates because even an explanation-only update resets acceptance.

## 3. Verify and hand back

Read current status again. Finish when every snapshot hunk belongs to a group and the queue is set, or report the remaining inbox work or blocker explicitly. Summarize the snapshot action, revised groups, preserved progress and groups needing human re-review. The open TUI picks up published changes; no restart is needed.
