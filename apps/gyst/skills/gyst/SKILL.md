---
name: gyst
description: Use when the user requests a gyst walkthrough of a diff, range or PR, or when gyst-refresh needs authoring rules. Plan full coverage, then publish self-contained groups for human review.
---

# Compose a walkthrough

A **group** is one review question covering one or more hunks, with a short title and optional member-hunk notes. Ungrouped hunks stay readable under their files. Leave Viewed progress to the human; it means read, not approved.

## 1. Select the snapshot

Resolve the requested scope; fetch remote refs when needed. Use the `gyst-cli` skill when command syntax is uncertain.

- Working changes, including untracked files: `gyst session open`.
- Git range: `gyst session open <range>`, such as `main...feature` or `main..feature`; the range is recorded as written and covers the whole repository.
- A saved session the user names: `gyst session open --session <id>`.

Opening returns the saved session for this repository and scope unchanged when one exists (`created: false`); it never refreshes the snapshot or rewrites groups. Ask before changing scope. For a requested snapshot update or regrouping, use `gyst-refresh`.

Record `session.id` from the reply; every later session command requires `--session <id>`.

## 2. Plan full coverage

Read status, `gyst session diff --session <id>`, surrounding code, callers and relevant tests. Narrow reads with `--file`, `--group` or `--hunk` as needed. `gyst session files` and `gyst session code`, with `--session <id> --snapshot <snapshotId>` from status or diff, read the snapshot's captured files, unchanged ones included, rather than the live checkout, which may have changed since.

Before publishing, assign **every snapshot hunk to exactly one planned group** and choose the complete order. Group by review question, not filename: an entry point, implementation and tests can belong together across files. Independent changes can be one-hunk groups. Include mechanical changes.

Order concepts before consequences, and members along the explanation: entry point → behavior → tests. Keep the plan in agent context; publish only finished groups.

## 3. Author self-contained groups

A reader should understand each group without reconstructing another group or the chat.

**Title**: name the change in a few words (`Reject expired credentials`), not a sentence explaining it. The 120-code-point limit is a bound, not a target.

**Notes**: attach one or two concise sentences to a member hunk when intent, a non-obvious consequence, a caveat or a connection needs explanation. Notes appear above their hunks only while the sidebar is hidden. Let obvious mechanical changes speak for themselves; an empty notes array is valid.

Each note is `{ "hunkId": "member-id", "text": "Brief explanation." }`. Use at most one per member, anchored within its own group. Display order follows member order. Text is nonempty, single-paragraph plain text, at most 400 Unicode code points, without terminal controls. Use stable symbols and paths rather than line numbers. Keep Markdown blocks, source excerpts and diagrams out of notes; the diff supplies the code. Distinguish tests run from tests inspected and snapshot evidence from later working-tree code. Keep the walkthrough in groups, not in chat.

Titles are single-line plain text, 1–120 Unicode code points, without terminal controls.

## 4. Publish atomically

Read the current revision. Pipe a batch to `gyst session apply --session <id>`. Publish one complete group or a small consecutive batch. Append planned groups in order.

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
    }
  ]
}
```

Creation requires `notes`, including `[]` when no explanation is needed. An update may omit notes to retain them, replace the complete array, or clear it with `[]`. Validate retained anchors against any new membership; replace notes when an anchor would become invalid.

- Successful batch: use its returned revision for the next batch.
- `stale_revision`: reread status and reconcile concurrent human work before rebuilding.
- Identical retry: reuse the key, but its receipt is historical; reread status before continuing.
- Changed content or corrected `validation_failed`: use a fresh key.

As soon as groups are published, tell the human they can run `gyst`; leave launching it to them. Continue at complete-group boundaries. Finish when every current hunk belongs to a group; otherwise report remaining work.

## Source changes

`gyst session check` reports freshness of the recorded scope without replacing the snapshot. Results are cached; `unavailable` does not establish freshness. A changed result is a notice, not authorization to refresh. Use `gyst-refresh` when the user requests an update.
