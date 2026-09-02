---
name: gyst
description: Pre-pass and co-review a diff with the gyst TUI; fold mechanical groups, annotate spotlight hunks, and answer questions about the reviewer's current item.
---

# Gyst co-review

Use gyst to prepare one diff for human review, then answer questions about the item under the reviewer's cursor. Gyst does not judge the change: your folds and tldrs are proposals, and the human's accept verdict authorizes them.

## Vocabulary

Use these terms exactly:

- **session**: one live review of one diff, owned by the daemon; at most one per repo.
- **snapshot**: the frozen files and hunks in the session.
- **inbox**: ungrouped hunks with no tldr; these still need your pre-pass.
- **group**: hunks sharing one mechanical pattern, represented by an exemplar and occurrence count.
- **spotlight**: an ungrouped hunk with a tldr, left for the human to read in full.
- **tldr**: your one-line annotation on a group or spotlight hunk.
- **verdict**: the human's accept ruling. Never write or infer it yourself.
- **refresh**: re-derive the snapshot while retaining review work on unchanged hunks.

## Pre-pass

### 1. Establish the session

Work out the diff source from the request and repository state. Do not match user phrases against a fixed table. Fetch a PR or remote ref yourself when needed; gyst does no network access.

- Uncommitted changes: run `gyst session create`. This defaults to `git diff HEAD` plus untracked files as all-added hunks.
- Replayable git range: run `gyst session create -- <git diff args>`.
- A unified diff you already obtained: pipe it to `gyst session create --stdin`.

If create returns `session_exists`, read `gyst session status` before doing anything else. Refresh only when the existing session's recorded source describes the requested scope: git-backed sessions use `gyst session refresh`; stdin-backed sessions accept a replacement patch through `gyst session refresh --stdin`. If the requested scope differs, stop and ask the user whether to keep the existing session or explicitly close it and start the new scope. Never close or recreate a session automatically — verdicts are human labor.

### 2. Explore only to improve triage

Read `gyst session status`, then read snapshot text with `gyst session diff`. For a large snapshot, use `--file`; use `--hunk` and `--group` for targeted reads.

Explore surrounding code before classifying when it will produce a more accurate group or tldr. Use subagents when the harness supports them, but only for that understanding. Do not ask them to judge, mutate the session, or produce a separate review artifact.

### 3. Triage the inbox once

Classify every inbox hunk. Fold a hunk only when the shared mechanics are clear. Preserve the smallest source-shaped exemplar that explains changed behavior and data flow. Never invent or summarize away source. If unsure, leave the hunk in spotlight with a tldr.

These ten families are candidates, not permission to fold:

1. **Batch field/member copies and repeated plumbing** — group repeated assignments and keep one exemplar. Exception: spotlight destinations with conversions, defaults, validation, changed data flow, or observable effects.
2. **Repeated renames and call-site migrations** — group equivalent old/new substitutions and keep one representative pair. Exception: spotlight any call site that also adapts arguments, types, control flow, or meaning.
3. **Forced signature/API propagation** — group mechanical zero-value returns, parameter threading, or context plumbing forced by one signature change. Exception: spotlight sites that choose a value, alter error handling, or introduce behavior.
4. **Error-message construction** — group repeated formatting prose while preserving the error identity and decisive control flow in the exemplar. Exception: spotlight exact text used as an API, assertion, localization key, protocol value, or user-visible behavior under review.
5. **Generated files** — group generated outputs and keep the hand-written generator or driver in view. Exception: spotlight generated output that is edited directly, is the source of truth, carries security/compatibility significance, or was explicitly requested for review.
6. **Import/include scaffolding** — group unconditional compiler-removed import churn. Exception: spotlight side-effect imports, conditional loading, re-exports, namespace resolution, or dependency-boundary changes.
7. **Pure formatting and already-demonstrated mechanics** — group repeated whitespace or syntax-normalization churn after one exemplar. Exception: spotlight whitespace-sensitive content, templates, generated syntax, formatter configuration, or any token change that can alter behavior.
8. **Test-suite repetition** — group repeated setup/assertion mechanics while keeping the scenario owner and one decisive assertion. Exception: spotlight distinct specifications, boundary cases, failure modes, fixtures with semantic data, and assertions that establish different contracts.
9. **Bulky literal/table/signature interiors** — group repetitive interiors while preserving the owner and boundaries in an exemplar. Exception: spotlight values that encode behavior, ordering, migrations, wire formats, permissions, security policy, or compatibility.
10. **Exact behavioral moves** — group both sides of a relocation only when the moved behavior is exact. Exception: any edit beyond relocation, ambiguous source/destination mapping, changed scope, or changed execution order stays in spotlight.

Never treat contracts or definitions, behavior-changing conditions, transformations, observable effects, or test specifications as mechanical. Every family has exceptions. Pattern membership proposes a group; only the human's verdict accepts it.

### 4. Apply one complete batch

Build one `gyst session apply` JSON envelope from the current `revision` and a fresh idempotency key. Use these exact field names (choose a unique `id` for each group):

```json
{
  "revision": 0,
  "idempotencyKey": "a-fresh-uuid",
  "ops": [
    {
      "type": "group.create",
      "id": "group-id",
      "tldr": "Repeated mechanical change",
      "memberHunkIds": ["hunk-1", "hunk-2"],
      "exemplarHunkId": "hunk-1"
    },
    {
      "type": "hunk.annotate",
      "hunkId": "hunk-3",
      "tldr": "Behavior that needs human review"
    },
    {
      "type": "queue.set",
      "itemIds": ["group-id", "hunk-3"]
    }
  ]
}
```

Submit all triage in that single batch:

- one `group.create` for each mechanical pattern, with a concise `tldr`, all `memberHunkIds`, and a representative `exemplarHunkId`;
- one `hunk.annotate` for every hunk left in spotlight — a `tldr` is mandatory for every spotlight `hunkId`;
- one `queue.set` whose `itemIds` contain every group id and spotlight hunk id exactly once, in your judged review order (use diff order when no better order exists).

Do not submit partial batches. Do not write verdicts, cursor, or expand state. If apply returns `validation_failed`, fix the reported operations and retry the complete batch with a **new** idempotency key. If it returns `stale_revision`, read status and the affected hunks again before rebuilding the batch.

The pre-pass is ready only when the returned status says the inbox is empty and the queue is set.

### 5. Hand off

Do not launch the TUI. Reply briefly:

> N hunks → K groups, M in spotlight — run `gyst` here

Do not add a separate "start with" recommendation; the queue already records that judgment.

## Refresh during co-review

After any refresh, triage the **inbox only**. Existing groups and verdicts are human work: leave them untouched unless the user explicitly asks to regroup. If regrouping is requested, remember that changing a group's membership resets that group's accept verdict.

## `/gyst-ask <question>`

This route must work cold, without memory of the pre-pass:

1. Run `gyst session status` in the repo.
2. Resolve `cursor.itemId` to its group or spotlight hunk and note whether it is expanded.
3. Fetch only that text with `gyst session diff --group <id>` or `gyst session diff --hunk <id>`.
4. Inspect surrounding code only when needed to answer accurately.
5. Answer in harness chat. Do not mutate the session and do not start a wait loop.

If the cursor is absent or points to an inbox hunk, say so plainly and use a targeted hunk read if the question still identifies the item.
