---
name: gyst
description: Use when the user requests a gyst walkthrough of a diff, range or PR, or when gyst-refresh needs authoring rules. Plan full coverage, then publish self-contained groups for human review.
---

# Compose a walkthrough

A **walkthrough** is an overall overview and an ordered list of **groups**. A group is one review question covering one or more hunks, with a short title, an overview, an order for its files and optional notes. Ungrouped hunks stay readable under their files. Leave Viewed progress to the human; it means read, not approved.

## 1. Select the snapshot

Resolve the requested scope; fetch remote refs when needed. Use the `gyst-cli` skill when command syntax is uncertain.

- Working changes, including untracked files: `gyst session open`.
- Git range: `gyst session open <range>`, such as `main...feature` or `main..feature`; the range is recorded as written and covers the whole repository.
- GitHub PR: `gyst session open --pr <number>`, or `--pr <PR URL>` such as `https://github.com/owner/name/pull/123`, from a clone of that repository; a number is in the repository `gh` resolves for the checkout; it captures the PR's own merge-base-to-head range.
- A saved session the user names: `gyst session open --session <id>`.

Opening returns the saved session for this repository and scope unchanged when one exists (`created: false`); it never refreshes the snapshot or rewrites groups. Ask before changing scope. For a requested snapshot update or regrouping, use `gyst-refresh`.

Record `session.id` from the reply; every later session command requires `--session <id>`.

A PR session's status `pullRequest` gives its whole native stack: ordered layers with titles, descriptions, bases and states, the selected PR, and verification (`stack.verifiedAt`, or `unavailable` when the latest discovery failed). Prepare and respond only in the selected PR's session. Other layers' titles and descriptions are context, not proof of behavior: before relying on a claim about another layer, open its session (`gyst session open --pr <its PR URL>`) and inspect its code. `gyst session check --session <id> --stack` rechecks stack metadata only.

## 2. Plan full coverage

Read status, `gyst session diff --session <id>`, surrounding code, callers and relevant tests. Narrow reads with `--file`, `--group` or `--hunk` as needed. `gyst session files` and `gyst session code`, with `--session <id> --snapshot <snapshotId>` from status or diff, read the snapshot's captured files, unchanged ones included, rather than the live checkout, which may have changed since.

Before publishing, assign **every snapshot hunk to exactly one planned group** and choose the complete order. Group by review question, not filename: an entry point, implementation and tests can belong together across files. Independent changes can be one-hunk groups. Include mechanical changes. Files Git attributes mark generated or vendored (`generated` in status `files`, `generatedFiles` in diff) start folded for the human; group them like any other change.

Order concepts before consequences, and members along the explanation: entry point → behavior → tests. Keep the plan in agent context; publish only finished groups.

## 3. Author self-contained guidance

A reader should understand each group without reconstructing another group or the chat. Write for a reviewer who knows the language but not the subsystem.

**Walkthrough overview**: the purpose of the whole change and the mental model that connects its groups. **Group overview**: what this group contributes and how to read it. The two complement each other; do not repeat one in the other.

**Title**: name the change in a few words (`Reject expired credentials`), not a sentence explaining it. Titles are single-line plain text, 1–120 Unicode code points, without terminal controls.

**Notes**: explain a logical step, a non-obvious consequence, a caveat or a connection; let obvious mechanical changes speak for themselves. A note has a stable `id` and anchors to one contiguous line range on one side (`old` or `new`) of one file, as numbered in the snapshot's captured content. The range must cover a changed line of its own group and no changed line of another group or of an ungrouped hunk; it may span unchanged lines and several of its group's hunks. Notes display in code order beside the code, so do not restate it.

Overviews and notes are ordinary Markdown: inline code, emphasis, lists, compact tables, fenced code and Mermaid diagrams. No raw HTML, images or terminal controls. Concise overviews and one- or two-sentence notes are defaults, not caps. Use stable symbols and paths. Distinguish tests run from tests inspected and snapshot evidence from later working-tree code. Keep the walkthrough in the session, not in chat.

**References**: point at exact captured code with a `gyst:<side>/<path>#L<start>-L<end>` link, such as `[the retry loop](gyst:new/src/retry.ts#L40-L52)`; write `%20` or wrap the target in `<…>` for spaces. The file may be an unchanged supporting one, but it must be in the snapshot: a file created after capture is rejected. Each changed text's references are checked and pinned to the batch's snapshot, and a later refresh never moves them: it marks the text Outdated when the referenced lines changed. Other links must be absolute `http(s)` URLs; relative, fragment, `mailto:` and other schemes are rejected, and so are Mermaid `%%{…}%%` directives, `---` frontmatter, `@{…}` shape data, `$$…$$` math, sequence `properties`/`details`/`links`/`link` statements and styling statements (`style`, `classDef`, `linkStyle`, `cssClass`, C4 `Update…Style`, sequence `rect`/`box`): the viewer owns diagram colours.

## 4. Publish atomically

Read the current revision. Pipe a batch to `gyst session apply --session <id>`. Publish one complete group or a small consecutive batch. Append planned groups in order.

Example first batch; replace the revision, snapshot id, key, hunk ids and ranges:

```json
{
  "revision": 0,
  "snapshotId": "snapshot-id-from-status",
  "idempotencyKey": "fresh-uuid",
  "ops": [
    {
      "type": "walkthrough.update",
      "overview": "Expired credentials could still load an account. This change rejects them at the boundary and pins the edge case with a test."
    },
    {
      "type": "group.create",
      "id": "expiry",
      "title": "Reject expired credentials",
      "overview": "The guard runs before the account lookup, so an expired credential never reaches the database.",
      "memberHunkIds": ["guard-hunk", "test-hunk"]
    },
    {
      "type": "note.create",
      "id": "expiry-boundary",
      "group": "expiry",
      "anchor": { "path": "src/auth.test.ts", "side": "new", "startLine": 40, "endLine": 46 },
      "markdown": "A credential expiring exactly at request time counts as expired. Test inspected, not run."
    }
  ]
}
```

`snapshotId` and `revision` come from status; a batch for an older snapshot or revision is stale. Ops:

- `walkthrough.update`: `overview` (`null` removes it) and/or `groupOrder` (every group id once).
- `group.create`: `id`, `title`, `overview`, `memberHunkIds`, optional `files` (defaults to the members' files in snapshot order). Groups append in order.
- `group.update`: `id` with any of `title`, `overview` (`null` removes it), `memberHunkIds`, `files`. `group.dissolve`: `id`; its hunks become ungrouped and its notes go.
- `note.create`: `id`, `group`, `anchor`, `markdown`. `note.update`: `id` with `anchor` (re-anchors, keeping its id) and/or `markdown`. `note.remove`: `id`.
- `walkthrough.revalidate`, `group.revalidate` (`id`) and `note.revalidate` (`id`): keep an Outdated text's wording after checking it against this batch's snapshot. Its references are pinned again to that snapshot and must be captured text there; a note must already be anchored to that snapshot, so re-anchor it in the same batch first if needed. Revalidation changes no Viewed.

The batch is validated as a whole: a hunk belongs to at most one group, `files` lists exactly the members' files, and every note still fits its group after membership changes. Edit guidance in place by id rather than recreating it. Adding, editing or removing a note, and editing or removing an overview, unviews the affected hunks; reordering does not, so avoid no-op rewrites.

- Successful batch: use its returned revision for the next batch.
- `stale_revision`: reread status and reconcile concurrent human work before rebuilding.
- Identical retry: reuse the key, but its receipt is historical; reread status before continuing.
- Changed content or corrected `validation_failed`: use a fresh key.

As soon as groups are published, tell the human they can run `gyst`; leave launching it to them. Continue at complete-group boundaries. Finish when status reports `preparation.state` as `complete`: a walkthrough overview, every group's overview and every current hunk in a group. Otherwise report remaining work.

## Source changes

`gyst session check` reports freshness of the recorded scope without replacing the snapshot. Results are cached; `unavailable` does not establish freshness. A changed result is a notice, not authorization to refresh. Use `gyst-refresh` when the user requests an update.
