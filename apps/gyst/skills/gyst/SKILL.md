---
name: gyst
description: Use when the user requests a gyst walkthrough of a diff, range or PR, or when gyst-refresh needs authoring rules. Plan full coverage, then publish self-contained groups for human review.
---

# Compose a walkthrough

A **group** is one review question covering one or more hunks, with a title and Markdown overview. Ungrouped hunks form the **inbox**. Human acceptance means “done reviewing,” not correctness approval. Leave verdicts and cursor state to the human.

## 1. Select the snapshot

Resolve the requested scope; fetch remote refs when needed. Use the `gyst-cli` skill when command syntax is uncertain.

- Working changes, including untracked files: `gyst session create`.
- Git range: `gyst session create -- <revisions> [-- <pathspecs>]`. Git options are rejected; pathspecs are caller-relative.
- Supplied patch: pipe to `gyst session create --stdin`; filenames must be repository-root-relative.

On `session_exists`, read `gyst session status` and reuse a matching snapshot. Ask before closing a session or changing its scope. For a requested snapshot update or regrouping, use `gyst-refresh`.

Record the session id; use `--session <id>` on subsequent commands to avoid targeting a replacement session.

## 2. Plan full coverage

Read status, `gyst session diff`, surrounding code, callers and relevant tests. Narrow reads with `--file`, `--group` or `--hunk` as needed.

Before publishing, assign **every snapshot hunk to exactly one planned group** and choose the complete order. Group by review question, not filename: an entry point, implementation and tests can belong together across files. Independent changes can be one-hunk groups. Include mechanical changes.

Order concepts before consequences, and members along the explanation: entry point → behavior → tests. Keep the plan in agent context; publish only finished groups.

## 3. Author self-contained groups

A reader should understand each group without reconstructing another group or the chat:

- Name the change in the title; explain intent, prior behavior and new behavior in the overview.
- Introduce necessary concepts and connect members in display order.
- When prose is insufficient, include selected unchanged-code excerpts with file locations and the revision or working-tree source actually read. Distinguish snapshot evidence from later code.
- State evidence and uncertainty; distinguish inspected tests from tests run.

Titles are single-line plain text, 1–120 Unicode code points, without terminal controls. Overviews are nonempty Markdown, at most 64 KiB UTF-8. Use only context needed for the review question.

## 4. Publish atomically

Read the current revision. Pipe a batch to `gyst session apply --session <id>`. Publish one complete group or a small consecutive batch; include `queue.set` with **every published group exactly once**, excluding inbox ids. Append planned groups in order.

Example first batch; replace the revision, key and hunk ids:

```json
{
  "revision": 0,
  "idempotencyKey": "fresh-uuid",
  "ops": [
    {
      "type": "group.create",
      "id": "expiry",
      "title": "Reject expired credentials",
      "overview": "Check expiry before loading account data. Read the guard, then its boundary test. Evidence: tests inspected, not run.",
      "memberHunkIds": ["guard-hunk", "test-hunk"]
    },
    { "type": "queue.set", "itemIds": ["expiry"] }
  ]
}
```

- Successful batch: use its returned revision for the next batch.
- `stale_revision`: reread status and reconcile concurrent human work before rebuilding.
- Identical retry: reuse the key, but its receipt is historical; reread status before continuing.
- Changed content or corrected `validation_failed`: use a fresh key.

As soon as groups are published, tell the human they can run `gyst`; leave launching it to them. Continue at complete-group boundaries. Finish when status has `ready: true` (empty inbox and set queue); otherwise report remaining work. Accepted groups with inbox hunks do not mean review completion.

## Source changes

`gyst session check` reports freshness of the recorded scope without replacing the snapshot. Results are cached; `unavailable` and `stdin` do not establish freshness. A changed result is a notice, not authorization to refresh. Use `gyst-refresh` when the user requests an update.
