---
name: gyst
description: Use when the user requests a gyst walkthrough of a diff, range or PR, or when gyst-refresh needs authoring rules. Plan full coverage, then publish self-contained groups for human review.
---

# Compose a walkthrough

A **group** is one review question covering one or more hunks, with a short title and optional member-hunk notes. Ungrouped hunks form the **inbox**. Human acceptance means “done reviewing,” not correctness approval. Leave verdicts and cursor state to the human.

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

A reader should understand each group without reconstructing another group or the chat.

**Title**: name the change in a few words (`Reject expired credentials`), not a sentence explaining it. The 120-code-point limit is a bound, not a target.

**Notes**: attach one or two concise sentences to a member hunk when intent, a non-obvious consequence, a caveat or a connection needs explanation. Notes appear above their hunks only while the sidebar is hidden. Let obvious mechanical changes speak for themselves; an empty notes array is valid.

Each note is `{ "hunkId": "member-id", "text": "Brief explanation." }`. Use at most one per member, anchored within its own group. Display order follows member order. Text is nonempty, single-paragraph plain text, at most 400 Unicode code points, without terminal controls. Use stable symbols and paths rather than line numbers. Keep Markdown blocks, source excerpts and diagrams out of notes; the diff supplies the code. Distinguish tests run from tests inspected and snapshot evidence from later working-tree code. Keep the walkthrough in groups, not in chat.

Titles are single-line plain text, 1–120 Unicode code points, without terminal controls.

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
      "notes": [
        {
          "hunkId": "guard-hunk",
          "text": "Check expiry before loading the account so an expired credential cannot trigger a database read."
        },
        {
          "hunkId": "test-hunk",
          "text": "The boundary case treats a credential expiring at request time as expired. Test inspected, not run."
        }
      ],
      "memberHunkIds": ["guard-hunk", "test-hunk"]
    },
    { "type": "queue.set", "itemIds": ["expiry"] }
  ]
}
```

Creation requires `notes`, including `[]` when no explanation is needed. An update may omit notes to retain them, replace the complete array, or clear it with `[]`. Validate retained anchors against any new membership; replace notes when an anchor would become invalid. Every group update resets that group's verdict and needs a complete `queue.set` in the batch.

- Successful batch: use its returned revision for the next batch.
- `stale_revision`: reread status and reconcile concurrent human work before rebuilding.
- Identical retry: reuse the key, but its receipt is historical; reread status before continuing.
- Changed content or corrected `validation_failed`: use a fresh key.

As soon as groups are published, tell the human they can run `gyst`; leave launching it to them. Continue at complete-group boundaries. Finish when status has `ready: true` (empty inbox and set queue); otherwise report remaining work. Accepted groups with inbox hunks do not mean review completion.

## Source changes

`gyst session check` reports freshness of the recorded scope without replacing the snapshot. Results are cached; `unavailable` and `stdin` do not establish freshness. A changed result is a notice, not authorization to refresh. Use `gyst-refresh` when the user requests an update.
