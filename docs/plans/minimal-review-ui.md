# Sidebar-first review with inline notes

Design choices confirmed by the owner; implementation, verification and independent review are authorized. This document specifies the target behavior, not a claim about the currently shipped UI. Commit, push, merge and publication require separate authorization.

## Confirmed decisions

- Remove the overview pane and replace overviews in authoring, status, persistence and receipts. Do not retain a hidden overview field.
- Show the item sidebar on the left and the selected item's diff on the right.
- Treat zoom and hidden sidebar as the same state: Enter hides the sidebar, Esc restores it, and s toggles it.
- Show agent notes only with the sidebar hidden, as inline strips immediately above their anchored hunks. Notes scroll with the code; they are not a separate pane or popup.
- Anchor notes to hunks initially, not individual lines or ranges. Each note is one or two very concise sentences.
- Preserve ordered groups, progressive atomic publication, group-only human verdicts, a nonverdictable inbox, frozen snapshots and explicit refresh.

## Layout and interaction

Browse:

```text
 Items                 | auth.ts
                       |
 > Reject expired keys | - loadAccount(token)
   Guard retries       | + checkExpiry(token)
   Update callers      | + loadAccount(token)
```

Read, with the sidebar hidden:

```text
 auth.ts

 | Agent
 | Check expiry before loading the account so an expired
 | credential cannot trigger a database read.

 - loadAccount(token)
 + checkExpiry(token)
 + loadAccount(token)
```

The file/hunk header comes first, then its optional note, then its diff. A subdued vertical rule and an explicit Agent label distinguish prose from code without relying on color. Notes have no diff signs or line numbers. Text wraps without truncation. In split mode the note spans the member's full width above both sides.

The sidebar is compact rather than half the screen; start around 28 columns and clamp to available width. Keep the diff visible in browse mode on narrow terminals; use unified diff when the actual diff width requires it. Resizing must not silently change the interaction state or reveal notes.

| Key   | Sidebar visible                                  | Sidebar hidden                                   |
| ----- | ------------------------------------------------ | ------------------------------------------------ |
| Enter | Hide sidebar and read selected item              | No-op                                            |
| Esc   | No-op                                            | Show sidebar and return to item selection        |
| s     | Hide sidebar                                     | Show sidebar                                     |
| j / k | Select previous/next item                        | Scroll diff                                      |
| [ / ] | No-op                                            | Jump to previous/next member hunk                |
| p / n | Navigate to previous/next item without a verdict | Same, staying in reading mode                    |
| a / u | Existing done/advance and undo behavior          | Same, staying in reading mode                    |
| o     | No-op                                            | Open the coherently focused member in the editor |

Keep half-page/page scrolling while reading, diff layout controls, help, explicit refresh, source notices, quit and editor gating. Esc dismisses help before affecting the sidebar. Remove overview Tab/Shift-Tab switching and the separate z expansion control; do not keep aliases or a second expansion state.

Selecting another item updates the diff preview immediately. An item without notes still shows its diff normally. Inbox hunks remain browsable/readable but carry no agent notes until published in a group.

### Focus and position

- Toggling the sidebar must retain the selected item and member hunk; it must not re-enter at the first hunk every time.
- Use the existing shared queue/diff pane state for browse/read, removing overview. Do not introduce another synchronized zoom flag.
- The current queue cursor forbids a hunk id. Revise that invariant so an active item's focused member survives browse/read transitions. Item changes select the destination's first member; view changes retain the current member. Empty sessions have no member focus.
- Only reading scroll drives guarded cursor.follow observations. Passive browse previews must not produce focus writes.
- A note belongs to its hunk's render block: scrolling to the note focuses that hunk, and hunk navigation reveals the header and note together. Notes are not cursor targets.
- Retain the existing session/revision/sequence guards, no-write handling of stale observations, failed-observation latch, explicit-navigation priority and editor synchronization checks.
- Sidebar toggles change code width and note visibility together. Preserve the same hunk and a stable relative position across reflow. An untouched round trip restores its saved offset. Exact source-line restoration across split/unified reflow is not promised by the current member-level anchor.
- New navigation, refresh or session replacement cancels stale restoration. Unchanged polls do not reset scroll. Updating notes must not allow the editor to open a member different from the displayed one.

## Note authoring and data

Implementation defaults proposed for the first version:

- Each group has a notes array; an empty array is valid. At most one note per member hunk, with no separate note id or note CRUD command.
- A note has hunkId and text. Its anchor must refer to a member of its own group; duplicate anchors are rejected. Display order follows member order, not note array order.
- Text is nonempty, single-paragraph plain text. Start with a 400-Unicode-code-point ceiling, reject terminal controls, and wrap at rendering time. The one-to-two-sentence rule is authoring guidance, not a sentence-counting parser. No Markdown blocks, source excerpts, diagrams or Mermaid in notes.
- Explain intent, a non-obvious consequence, a relevant caveat or how members connect. Do not paraphrase the changed lines or manufacture notes for obvious mechanical changes.
- Use stable symbols/paths rather than line numbers in prose. Claims about verification must distinguish execution from inspection.
- Keep short titles and full snapshot-wide coverage planning. Publish complete groups with their notes atomically, while later groups are still being prepared. Do not move the walkthrough back into chat or require a note on every hunk.

Proposed group.create operation (within the existing revision/idempotency-key batch and with queue.set):

```json
{
  "type": "group.create",
  "id": "expiry",
  "title": "Reject expired keys",
  "memberHunkIds": ["guard-hunk", "test-hunk"],
  "notes": [
    {
      "hunkId": "guard-hunk",
      "text": "Check expiry before loading the account so an expired credential cannot trigger a database read."
    },
    {
      "hunkId": "test-hunk",
      "text": "The boundary case treats a credential expiring at the request time as expired."
    }
  ]
}
```

Group creation requires notes, allowing []. For group.update, omitting notes retains them; supplying notes replaces the complete array, and [] clears it. Validate anchors against the resulting membership: an explicit membership update must also replace notes if it would leave invalid anchors. Reject the whole batch instead of silently retargeting a note.

Any group.update still clears that group's accepted state and requires a complete queue.set. Notes are explanatory metadata, never separately verdictable. Unrelated groups and verdicts remain untouched.

## Refresh, retries and compatibility

- Preserve notes when every member of the group survives the existing confident hunk matching, including line-number-only movement.
- Conservative default: if a refresh invalidates any member of a group, clear that group's notes and verdict together. A surviving note may discuss a vanished sibling, so retaining its anchor alone does not establish that its explanation is still valid. Keep unaffected groups intact; the refresh skill reauthors affected groups.
- Never fuzzy-match note text or line coordinates onto changed code. Ambiguous duplicate hunks follow the existing conservative identity rules.
- Preserve exact historical apply receipts, including old note text, anchors and cursor state after edits or refresh. Adapt the existing text-interning approach for notes rather than repeatedly copying all prose into every receipt; remove overview-specific storage and decoding.
- Remove overview from the cursor/wire unions and reject obsolete authoring fields. No migration, compatibility shim or persisted format-version marker.
- Existing overview-based saved sessions will fail strict decoding and require recreation. Leave their files byte-identical; do not delete, migrate or reserve their identities. The owner accepted recreation when choosing complete replacement.
- Testing requires the new CLI/TUI and daemon together. Do not silently adapt to a running old daemon; live-daemon compatibility detection remains separate work.

## Implementation sequence

1. **Visual and interaction check.** Use representative short/long hunks and a multi-file group to verify browse/read layouts, inline strips, narrow wrapping and sidebar transitions before replacing production behavior. Do not add a prototype framework or dependency.
2. **Core contract.** Update metadata, session/status/receipt schemas, apply validation, refresh, draft/cursor reconciliation and human actions. Cover valid notes, invalid anchors, atomic failure, exact replay and preservation of unrelated human work through existing core tests.
3. **Daemon and control plane.** Carry notes through the existing apply/status/diff flows and persistence. Update strict-decoding, CLI/socket and concurrency tests. Keep current mutation serialization and failed-persistence guarantees.
4. **TUI replacement.** Keep the item list beside the diff in browse mode; insert optional note strips inside existing member blocks in reading mode. Remove the overview renderer, Markdown restoration, dual-pane focus and separate expansion state. Reuse and simplify diff anchoring without dropping the recent race fixes.
5. **Authoring and release surface.** Rewrite gyst examples/rules for notes; update gyst-refresh and gyst-ask, README, help, changeset and generated-command/packaging expectations. Preserve skill invocation policies and name-only cross-skill references.
6. **Verification.** Run focused red/green regressions, full lint/format/typechecks/tests, Linux editor PTY checks, host build, six-target builds and package parity. Report cross-builds separately from actual platform execution; do not claim human acceptance from headless tests.

Primary implementation paths: packages/core/src/{metadata,session,apply,draft,refresh,human-action,status}.ts; apps/gyst/src/tui/app.tsx; daemon/CLI seams and their existing tests; apps/gyst/skills/; README and release notes. The current MemberDiff already gives each hunk its own box/header/diff, so hunk-level strips do not require an OpenTUI patch. Installed OpenTUI 0.5.12 exposes no arbitrary note-insertion hook inside the diff, which is why line-level notes are excluded from this scope.

## Acceptance checks

- Startup shows sidebar plus selected diff, never an overview. Enter/Esc/s obey the two-state table, including no-op keys and help dismissal.
- Notes are completely absent from browse layout and appear at the correct hunk in reading mode; wide split and narrow unified layouts remain readable, unclipped and reachable.
- Toggle from the middle of the second hunk, then return: the same hunk remains focused; an untouched round trip restores the reading offset. Explicit jumps beat pending restoration.
- Scrolling over note rows selects their owning hunk without jumping, retry loops or note-specific cursor state. Ask/editor focus remains coherent during polling, note edits, refresh and remote navigation.
- Empty notes, progressive publication, inbox, empty sessions, long sidebar lists, done/advance/undo and completion retain their intended behavior.
- Invalid notes reject atomically; note edits reset only the affected verdict; refresh preserves unaffected notes and clears affected groups' notes without guessing.
- Receipt replay remains exact across notes edits and daemon restart. Obsolete saved files remain untouched and undecodable rather than being silently converted.
- Skills publish schema-valid complete groups, explain the short-note policy and package identically to source.

## Not included

Line/range anchoring, right-margin cards, popup overlays, note threads/replies, per-note verdicts, note-specific navigation, hidden overviews, note Markdown/diagram rendering, automatic refresh, session migration or unrelated compatibility/dependency fixes.
