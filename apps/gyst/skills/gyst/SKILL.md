---
name: gyst
description: Prepare coherent review items and publish them progressively for human co-review.
disable-model-invocation: true
---

# Gyst co-review

Prepare one scoped diff for human judgment. A review item is a **group** of hunks contributing to one coherent change, or a **spotlight** (one prepared, ungrouped hunk). Every member is shown; accepting a group covers all its members. The **inbox** holds unprepared hunks. A **title** names an item; its Markdown **overview** explains intent, context and behavior. The human alone supplies **verdicts**: accept means done reviewing, not a claim that the code is correct.

## 1. Establish the session

Resolve the requested scope from the repository. Fetch remote refs yourself when needed; gyst does not fetch them.

- Uncommitted changes: `gyst session create` includes the Git diff and untracked files.
- Replayable range: `gyst session create -- <revisions> [-- <pathspecs>]`. Git options are rejected; pathspecs resolve from your current directory.
- An obtained unified diff: pipe it to `gyst session create --stdin`.

On `session_exists`, read `gyst session status`. Refresh only if the recorded source matches the requested scope: `gyst session refresh` for Git, or a replacement patch through `gyst session refresh --stdin`. For a different scope, ask the user whether to keep or explicitly close the session. Never discard human work automatically.

On an incompatible saved session or daemon reply, stop. Finish/close sessions with the old executable, ensure its daemon exits, then upgrade and refresh installed skills. Legacy files are not migrated; manual archiving requires the owner's decision.

## 2. Understand the whole scoped change

Read status and `gyst session diff`, then surrounding code before publishing anything. For large snapshots, read by `--file`; use `--hunk` or `--group` for targeted reads. Distinguish the frozen snapshot from unchanged context and any newer working-tree content.

Group by the review question or behavior: an API change, implementation and decisive tests can belong together despite different mechanics. A common file, directory or vague topic is insufficient. Split changes needing independent explanations or judgments; prefer a spotlight for an independent hunk. Order members along the explanation, for example entry point → behavior → tests. Never claim unshown members are interchangeable.

## 3. Publish complete items progressively

Each item needs a plain-text, single-line **title** (1–120 Unicode code points, no terminal controls) and a nonempty Markdown **overview** (at most 64 KiB UTF-8). Explain intent, before/after behavior, relationships between members, necessary surrounding context and relevant evidence or uncertainty. Use only warranted sections. Concrete code/data-flow sketches, compact tables and source references are often clearer than long prose. Mermaid fences are ordinary source text, not rendered diagrams. Never invent test results or substitute a correctness verdict for the human's review.

Read the current revision, then pipe an envelope to `gyst session apply`:

```json
{
  "revision": 0,
  "idempotencyKey": "a-fresh-uuid",
  "ops": [
    {
      "type": "group.create",
      "id": "api-and-tests",
      "title": "Reject expired credentials",
      "overview": "## Behavior\nThe entry point rejects expired credentials before loading account data. The tests exercise expiry and the still-valid path.\n\nEvidence: source inspection; tests not run.",
      "memberHunkIds": ["entry-hunk", "implementation-hunk", "test-hunk"]
    },
    {
      "type": "queue.set",
      "itemIds": ["api-and-tests"]
    }
  ]
}
```

Publish one complete item or a small coherent batch at a time. Include `queue.set` **in the same transaction**, containing every currently published group/spotlight id exactly once, excluding inbox ids. Preserve published order and append new items. Grouped hunks need no separate metadata. For a spotlight use `{"type":"hunk.annotate","hunkId":"id","title":"Short title","overview":"Complete explanation"}` with both fields together.

Use the returned revision for the next batch. On `stale_revision`, reread status and reassess concurrent human work before rebuilding; never blindly retry obsolete operations or overwrite verdicts. An identical retry with the same idempotency key returns its historical receipt, not current status; reread before continuing. Use a new key for changed content. On `validation_failed`, correct the batch and use a new key. Never stream incomplete Markdown into published items or write verdict/cursor state.

## 4. Hand off while preparing

As soon as items are published, tell the human they can run `gyst` in this repository; do not launch it. Continue preparing remaining inbox hunks at item boundaries. Report published item and remaining inbox counts briefly. Empty inbox plus a set queue means preparation is ready; all published items accepted while inbox remains is **not review complete**.

## Refresh during co-review

Triage new inbox hunks without automatically reordering or regrouping published work. Any removed/changed group member invalidates the surviving group's verdict; its title and overview remain a proposal needing re-review. Surface affected context and revise it explicitly when appropriate. Membership or metadata changes invalidate verdicts; use existing `group.update` (optional title, overview, memberHunkIds) or `group.dissolve` only for deliberate revisions, with the resulting queue set atomically. Preserve unrelated accepted items.
