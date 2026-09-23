---
name: gyst
description: Compose a self-contained walkthrough and publish complete groups top to bottom for human co-review.
disable-model-invocation: true
---

# Gyst co-review

Compose a walkthrough of one scoped diff. Each **group** is one review step containing one or more hunks, a plain-text **title**, and a Markdown **overview** with the context needed to understand it. Every changed hunk belongs to exactly one group when preparation is complete. The **inbox** contains hunks not yet published in a group. The human alone supplies **verdicts**: accept means done reviewing every member, not a claim that the code is correct.

## 1. Establish the session

Resolve the requested scope from the repository. Fetch remote refs yourself when needed; gyst does not fetch them.

- Uncommitted changes: `gyst session create` includes the Git diff and untracked files.
- Replayable range: `gyst session create -- <revisions> [-- <pathspecs>]`. Git options are rejected; pathspecs resolve from your current directory.
- An obtained unified diff: pipe it to `gyst session create --stdin`. Filenames in the patch must be repository-root-relative.

On `session_exists`, read `gyst session status`. Refresh only if the recorded source matches the requested scope: `gyst session refresh` for Git, or a replacement patch through `gyst session refresh --stdin`. For a different scope, ask the user whether to keep or explicitly close the session. Never discard human work automatically.

## 2. Plan the entire walkthrough

Read status and `gyst session diff`, then the surrounding implementation, callers and relevant tests. For large snapshots, read by `--file`; use `--hunk` or `--group` for targeted reads. Distinguish the frozen snapshot from unchanged context and any newer working-tree content.

Before publishing, map every snapshot hunk to exactly one planned group and choose the complete top-to-bottom order. Keep this plan in your working context; gyst stores published groups, not an unfinished outline. A plan is complete when its members cover the whole snapshot without overlap and you can explain each group's review question, necessary context and position in the story.

Group code that is best understood together: an entry point, implementation and decisive tests can form one step across files. An independent one-hunk change is also a group. Split independent review questions; a shared file, directory or vague topic alone does not make a coherent group. Keep related changed code together rather than making a group's explanation depend on code hidden in another step.

Order groups by comprehension: establish the needed concepts before their consequences. Within each group, order members along the explanation, such as entry point → behavior → tests. Account for supporting and mechanical changes too; every hunk remains visible and reviewable.

## 3. Author and publish complete groups

Write each overview so the human can understand the group without reconstructing another step or the harness conversation:

- Explain why this change exists, the relevant prior behavior, and what changes now.
- Introduce necessary domain concepts and connect the members in their display order.
- Include small, relevant unchanged-code excerpts when prose is insufficient. Cite file locations and the revision or working-tree source you actually read; clearly distinguish those excerpts from the snapshot hunks being reviewed. Explain any source drift rather than presenting newer code as snapshot evidence.
- State supported evidence and remaining uncertainty. Name tests that matter and distinguish inspected tests from tests actually run.

Use only the context needed for this review question, not whole-file dumps or a fixed section template. The title names the change rather than a filename. Titles are single-line plain text (1–120 Unicode code points, no terminal controls); overviews are nonempty Markdown (at most 64 KiB UTF-8). Ordinary code fences, compact tables and source references are supported; Mermaid fences remain source text. Never substitute an assurance of correctness for the human's judgment.

Before publishing a group, check that its title, explanation, context and ordered hunks tell the same complete story. Read the current revision, then pipe an envelope to `gyst session apply`:

```json
{
  "revision": 0,
  "idempotencyKey": "a-fresh-uuid",
  "ops": [
    {
      "type": "group.create",
      "id": "reject-expired-credentials",
      "title": "Reject expired credentials",
      "overview": "## Behavior\nPreviously the entry point loaded account data before checking expiry. It now rejects expired credentials first. Read the entry point, expiry check and tests in that order.\n\nThe tests exercise expiry and the still-valid path. Evidence: source inspection; tests not run.",
      "memberHunkIds": ["entry-hunk", "implementation-hunk", "test-hunk"]
    },
    {
      "type": "queue.set",
      "itemIds": ["reject-expired-credentials"]
    }
  ]
}
```

Publish one complete group or a small consecutive batch from the plan. Include `queue.set` **in the same transaction**, containing every currently published group id exactly once, excluding inbox ids. Preserve published order and append the next planned groups. One-hunk groups use the same operation; hunks carry no separate explanation or verdict.

Use the returned revision for the next batch. On `stale_revision`, reread status and reassess concurrent human work before rebuilding; never blindly retry obsolete operations or overwrite verdicts. An identical retry with the same idempotency key returns its historical receipt, not current status; reread before continuing. Use a new key for changed content. On `validation_failed`, correct the batch and use a new key. Never stream incomplete Markdown into published groups or write verdict/cursor state.

## 4. Hand off while preparing

As soon as groups are published, tell the human they can run `gyst` in this repository; do not launch it. Continue down the planned walkthrough at complete-group boundaries. Report published group and remaining inbox counts briefly. Empty inbox plus a set queue means preparation is ready; all published groups accepted while inbox remains is **not review complete**.

## Source awareness and explicit refresh

Use `gyst session check` to compare the recorded Git scope with its captured patch without mutating the session. The response names the session and review revision, `checkedAt`, and `state`: `unchanged`, `changed`, `unavailable` (with a reason), or `stdin`. Results can be cached for five seconds. Unavailable and stdin are not evidence of freshness; unrelated working-tree changes outside the recorded scope need not change it. Status and historical apply receipts remain review-state records, not live source checks.

When the source changed, tell the human the snapshot is still fixed. Do not refresh merely because a check noticed changes. Refresh only on an explicit request; the TUI's `r` key does this for Git sessions. Stdin requires a replacement patch through `gyst session refresh --stdin`.

After an explicit refresh, account for new inbox hunks before publishing further groups. Preserve the order and unrelated accepted groups the human has already seen. Removed or changed members invalidate a surviving group's verdict; its title and overview remain a proposal needing re-review. Reassess source excerpts and explanation against the new snapshot, and revise affected groups deliberately with `group.update` (optional title, overview, memberHunkIds) or `group.dissolve`, setting the resulting queue atomically. If new evidence requires restructuring the published walkthrough, explain why rather than silently reshuffling the human's progress.
