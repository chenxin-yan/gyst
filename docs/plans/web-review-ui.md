# Interactive web review

## Status and authority

Implementation handoff from [Wayfinder map: gyst interactive web review](https://github.com/chenxin-yan/gyst/issues/60), synthesized by [Write the web review spec](https://github.com/chenxin-yan/gyst/issues/78). This replaces `docs/plans/minimal-review-ui.md`, not supplements it. It describes the accepted target, **not implemented or verified production behavior**. This planning task does not authorize implementation, commits, publication or deployment.

Gyst helps a human build the mental model needed to judge agent-generated changes. It is a useful plain diff viewer before an agent contributes anything, then a self-contained, progressively published walkthrough. It does not judge the code or run the agent. Keep the interface focused and minimal.

[CONTEXT.md](../../CONTEXT.md) owns terminology. [Effect as the application runtime](../adr/0001-effect-architecture.md) records the retained runtime architecture and its revised assumptions. The decision register below links the detailed rationale and evidence; this document integrates the resulting implementation contract. Later explicit resolutions override earlier research recommendations and prototype checkpoints.

### Supersessions that must not survive implementation

- Web replaces the TUI entirely, including terminal/editor integration. No compatibility aliases or migration layer; gyst is unreleased and old sessions may be discarded.
- Per-hunk Viewed replaces group acceptance/verdicts; remove queue/inbox, group Done and acceptance history. Ungrouped hunks appear under files.
- Required walkthrough/group overviews and rich range-anchored notes replace the plain-text, 400-code-point, one-note-per-hunk contract.
- Code threads and note replies only. Overviews are **not** conversation targets, superseding that part of the earlier thread decision.
- React + standalone TanStack Router replaces TanStack Start. No SSR/hydration layer.
- Frozen TS/JS LSP navigation is included as an optional add-on; the original recommendation to defer it is superseded. Capture excludes installed dependencies, narrowing the earlier dependency-navigation promise.
- No preset per-file, per-snapshot or total-storage quotas. The earlier 10 MiB / 250 MiB / 5 GiB defaults are superseded. Optional user quotas and explicit physical resource failures remain.
- Native GitHub stack discovery replaces the research proposal for harness-supplied layers. No stack-specific dependency tracking or automatic topology-based guidance invalidation.
- `/gyst-respond` replaces `/gyst-ask`; remove `/gyst-refresh`. Human-triggered pickup replaces wait/auto-wake proposals. Do not build a persistent handoff panel.

## 1. End-to-end experience

1. `gyst` selects uncommitted changes; `gyst main...feature` selects the recorded Git range; `gyst <PR URL>` resolves a GitHub PR. The foreground launcher serves the local web app and opens the browser, or prints a private bootstrap URL when a local browser is unavailable. `gyst --session <id>` resumes a saved session.
2. Create or reuse the session for that repository/scope. Reuse never implicitly refreshes, overwrites guidance or deletes another session. Initial capture completes safely before publishing its snapshot; show capture progress. A new session opens as a plain diff viewer.
3. `/gyst` uses headless session opening, inspects the whole scoped change and relevant context, plans full coverage/order, then publishes complete groups progressively. The human can read immediately. Live publication preserves reading position and drafts.
4. The human reads the walkthrough, files or folders, expands context, follows captured links, optionally uses semantic navigation, marks hunks Viewed and comments on code or replies to notes. Navigation never changes Viewed.
5. The human invokes `/gyst-respond` in the existing harness for the exact session. A copyable instruction names that skill and session, never a token. There is no agent launch, polling wait, automatic wake or persistent handoff UI. The workflow retrieves one bounded-at-invocation pending set, responds and stops; later messages wait for another invocation.
6. Questions alone authorize explanations, not fixes. Explicitly requested fixes authorize refresh and guidance repair once the fix is represented by the recorded scope. A local edit is not automatically part of a committed range/remote PR: do not retarget, commit, push or restack to make it fit.
7. Explicit refresh atomically replaces the snapshot and reconciles progress/guidance/conversations. The human re-reads changed guidance and resolves threads independently of Viewed. All-viewed and unresolved-thread counts are distinct; no extra review-complete state or automatic session deletion.
8. A ready walkthrough can be exported as a standalone read-only HTML file after disclosure approval. Closing the browser/launcher leaves the saved session intact.

## 2. Session, scope and source acquisition

### Identity and selection

- Session identity is stable, independent of cwd, current browser focus, moving refs and snapshot identity. After open, harness reads/writes always name an exact session ID.
- Non-PR identity: repository plus recorded scope, either uncommitted changes or the recorded Git range. Equal resolved endpoints do not merge differently recorded scopes. Ref movement does not create a new session.
- PR identity: repository plus PR, independent of head SHA or stack position. Do not merge a PR session with an ordinary range session whose current diff happens to match.
- Different scopes coexist. Opening one switches the displayed session, retaining others, their positions and drafts. Saved sessions persist until explicit deletion; no archive state, automatic expiry or `close` alias.
- Capture the whole scope. Remove stdin patches and Git pathspec capture. Read filters may select a captured file/group/hunk but do not change scope identity or capture coverage.
- Source acquisition owns trusted local checkout selection, Git resolution and PR discovery. Structured review operations use session/snapshot identities, not arbitrary CLI argument arrays or browser-supplied paths.

### Snapshot inputs

- Resolve revision endpoints once per capture, preserving Git range semantics; a three-dot range uses its resolved merge base. A PR uses its actual merge-base-to-head diff, not the preceding stack layer's newest head.
- Uncommitted capture compares HEAD (empty baseline for an unborn repository) with working-tree contents, including non-ignored untracked text files. It is not an index-only review.
- Capture full project text files on both sides, including unchanged source, configuration, lockfiles and workspace package source. Tracked text is eligible regardless of extension or ignore rules.
- Exclude `node_modules`, binary contents, submodule contents, symlink-target traversal and untracked ignored files. No opt-in dependency capture. Never traverse outside the project through links/paths. Ignored generated source is not automatically included.
- Review text hunks; do not introduce binary, mode-only or rename-metadata review as an implicit extension of this plan. Report unsupported content explicitly rather than implying it was reviewed. Preserve available text changes and the existing text-hunk validation intent.
- Derive reviewed changes from the same captured bytes used for full-file reading and analysis. Detect concurrent working-tree changes and refuse publication with retry guidance. This is best-effort detection, not a filesystem-wide atomicity guarantee.
- Capture itself does not install dependencies, execute project scripts or fetch missing supporting source. PR acquisition may fetch required Git objects without switching the checkout. Keep that separate from demand-loading a missing reference or analysis dependency, which is forbidden.
- Persist captured bytes independently of the checkout/Git object database. Ordinary review reads must still work after that source changes, disappears or becomes inaccessible. Source check/refresh may then report unavailable.

### Availability, storage and retention

Retain `GYST_DATA_DIR`, otherwise `$XDG_DATA_HOME/gyst`, otherwise `~/.local/share/gyst`, on the daemon host. Reuse SessionStore and private atomic mutable-session persistence (directory 0700; session files 0600), not browser storage or a database. Keep immutable full-file content in a daemon-owned content-addressed store, deduplicated across sides, snapshots and sessions. Snapshot manifests identify paths, sides, content identities and availability reasons; keep captured content private as well.

No preset quotas or review-size cutoff. Optional user-configured quotas follow these rules:

- Capture required reviewed text files completely or fail; never publish a truncated review.
- Capture other eligible project files in stable path order within a configured budget; record each omission explicitly. Excluded, absent, quota-limited or otherwise uncaptured targets are unavailable, never substituted with live content.
- Reclaim disposable materializations/unreferenced staging before refusing for lack of space. Never automatically evict sessions or retained context. Resource/write failures are actionable and leave authoritative saved state intact.
- Make blobs durable before publishing review state that references them. Garbage collection must respect staged publication, active reads, other sessions and durable references. Failed capture must not strand unbounded staging data.

Keep current snapshot inputs. From older snapshots retain the full files and identifying context needed by retained guidance, references, all conversations (including resolved ones) and live drafts; reclaim unneeded old content. There is no general snapshot-history browser. Draft context must be pinned before refresh can reclaim it; a browser disconnect cannot silently release it. Explicit session deletion releases content only when no other session/reference still needs it.

Source checks and no-op detection compare supporting inputs as well as changed hunks. A changed helper with an identical diff patch is not an unchanged snapshot. A source check is informational and never replaces a snapshot or changes progress.

## 3. Guidance and the review model

### Explanation contract

Agent-prepared walkthroughs have an overall overview and an overview for every group, including a single-group walkthrough. Overall purpose and group contribution are complementary, not repeated summaries. Plain diff sessions need neither. Groups and their files follow agent-defined order; notes follow code order. Every changed hunk belongs to exactly one group when preparation is complete; partial progressive preparation is valid and visible as incomplete coverage.

Notes explain logical steps and necessary context, not mechanically every hunk/line. A note has a stable identity and anchors to one contiguous old- or new-side file range intersecting its group's changed hunks. It may span unchanged lines and multiple same-group hunks, but not another group's changed hunks. Supporting unchanged code elsewhere is linked, not independently annotated. Keep code visible alongside notes; highlight a note's labelled range.

A Reference is a code link in guidance to an exact captured snapshot/file/side/range, including unchanged supporting files. Validate the target against captured content; never accept a live-only target as captured. Existing retained unavailable references preserve identity and show the reason. Reference targets have no independent review state. Do not silently rebind older references on refresh. A relative display link such as `gyst:new/path#L40-L52` is resolved and pinned to its authoring snapshot, not interpreted against whichever snapshot is current later.

### Content and rendering

One safe rich-content contract serves guidance, human messages and agent replies:

- Ordinary Markdown: inline code, emphasis, lists, compact tables, fenced examples, Mermaid, captured-code links and safe ordinary external links.
- No raw HTML, embedded images or author styling/diagram configuration. Use `react-markdown` + `remark-gfm` with raw HTML disabled, not `rehype-raw`.
- Lazy-load official Mermaid, strict security mode; strip author frontmatter/directives, validate before rendering and show source plus an error on failure. App-owned Catppuccin palette/theme; rerender on flavour changes. Do not make Mermaid links a route around link restrictions.
- Syntax-highlight code with Shiki; reuse a supported diff-library highlighter only if its installed public interface provides one. Do not assume a private helper exists.
- External links require deliberate activation and safe schemes; no executable URLs or automatic network retrieval from content. Treat source/prose as untrusted data in live and exported views. Bundle display assets rather than requiring remote images/fonts/CDNs.

Author for a reviewer who knows the language but may not know the subsystem: short orientation, then precise links for depth. Start with the mental model, follow concrete flow, give a before/after or usage example for observable behavior changes, and explain preserved invariants for refactors. Distinguish illustrative sketches from captured code and verified results; tests inspected are not tests run. Choose the smallest useful representation; diagrams must clarify. Concise overviews and one- or two-sentence notes are defaults, not hard prose caps. Guidance stands alone without the originating chat/private skills.

### Viewed and invalidation

Viewed belongs to each current hunk and is shared across every view. A file header has a binary checkbox: checked iff all hunks of that file **in the current view** are Viewed. Checking marks that set, folds the file and advances to the next unviewed file; unchecking clears only that set. The snapshot-wide file view covers all changed hunks in the file. A walkthrough-row checkmark is derived from its hunks, not a group obligation. Empty retained Outdated groups are not complete by vacuous truth.

| Event                                                                      | Effect on Viewed                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Add, edit or remove a note                                                 | Unview its anchored hunks, globally                                     |
| Re-anchor a note                                                           | Unview affected old/new anchored hunks                                  |
| Edit/remove group overview                                                 | Unview that group's hunks                                               |
| Edit/remove walkthrough overview                                           | Unview the walkthrough                                                  |
| Changed referenced context during refresh                                  | Unview the referencing note's anchored hunks, not the reference targets |
| Reordering alone; replies; Pending transitions; resolve/reopen; navigation | None                                                                    |
| Explicit revalidation without content edits                                | None; never restores progress                                           |

Overviews have no independent reading state. Merely marking an overview Outdated during refresh does not unview untouched hunks. The human can mark current code Viewed while guidance remains Outdated; Viewed means read, not approved.

## 4. Conversations and drafts

- A human Comment starts a flat Thread on one contiguous range, one side of one captured file. Any captured code is eligible, including unchanged context, reference targets and expanded files. Multiple code threads may share a range; Comment starts another, Reply continues one.
- A human Reply to a Note creates its sole thread if absent. Subsequent messages are replies. Overviews, groups, files in general and references-as-links are not additional conversation targets. The agent responds in existing threads; it does not initiate human conversations.
- Each human message is Pending until actually retrieved by the agent. The author can edit/delete only while Pending. Read freezes immediately, not when answered; corrections become new replies. Posted agent replies are immutable. Deletion does not cascade; an empty thread disappears without deleting its note.
- Show Pending only while unread, no Read badge. Read is not answered, resolved or Viewed. Only the human resolves/reopens. A resolved thread leaves the diff but stays in Comments. Explicitly reopen before a new human reply.
- Resolved threads are excluded from pending pickup; reopening exposes still-unread messages. A late agent answer is retained in the same resolved thread without reopening it.
- Replies are free-form: no required verdict wording or structured Fixed/Deferred field. If the next reader would ask the same question, improve reusable guidance and reply briefly; otherwise reply only. Guidance remains the record, threads the conversation.
- Each human note reply retains the wording it refers to, not just the thread's first version. A clickable per-reply Outdated marker reveals that wording when it differs from the current note or the note was removed. No full history panel/version-number UI. Pending and Outdated can coexist.
- Retain the code/wording the human began composing against across rewrites, pending-message edits, refresh and disconnection; never silently rebind. Sending retains that context. The agent receives the same historical context.
- Removing a note leaves its unresolved conversation at its retained code location, with the removal explicit and historical wording under Outdated. Removing its group preserves the conversation in Comments. A new note at the same location does not inherit the old identity/thread.

Only one source-local conversation is expanded at a time. Opening another closes the first; compose only for a new comment or explicit Reply. Comments is a compact list/modal, not a persistent pane. Resolved threads are available there for reopening. Drafts survive dismissal, switching sessions and disconnection. During disconnection retain drafts but do not queue new edits for silent later submission; after resync, flag changed/disappeared targets. Retrying an already-submitted request under its original identity is different from an offline edit queue.

## 5. Refresh reconciliation

Refresh is explicit and atomic. Failed refresh leaves the previous snapshot and review state intact; a no-op preserves progress. Retain reader position where its target survives. Publication must not expose half-old/half-new state.

| State                             | Preservation rule                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hunk identity, Viewed, membership | Exact unambiguous same-file hunk-body match; header/line shifts alone are harmless. No similarity, rename or cross-file matching. Changed body/context, split/merge or ambiguous duplicate correspondence does not inherit progress/membership.    |
| New/unmatched hunks               | Unviewed and ungrouped under files; the agent places them.                                                                                                                                                                                         |
| Group/order                       | Preserve surviving membership and group/file order. Keep empty formerly populated groups in place as Outdated until repaired/removed.                                                                                                              |
| Note                              | Outdated if any anchored hunk or referenced range changes. Pure coordinate shifts do not invalidate. Do not infer unlinked semantic dependencies; the agent verifies those.                                                                        |
| Overview                          | Changed group/review contents or its own changed reference context makes it Outdated at the corresponding level; no automatic reset of untouched hunks.                                                                                            |
| Unmappable note anchor            | Keep note in former group with Outdated and disclosure of old captured code; never paint old code as a current change. Keep its unresolved conversation accessible.                                                                                |
| Reference                         | Remains pinned to its original snapshot/file/side/range; identify historical context explicitly.                                                                                                                                                   |
| Code thread                       | Map independently at range granularity: every targeted line must map unchanged and unambiguously in the same file/side, even if the containing hunk changed. Otherwise keep in Comments with old code, without guessing or requiring reattachment. |
| Conversation state                | Preserve IDs, messages, Pending/read, open/resolved and each reply's wording. Refresh never resolves/reopens a thread.                                                                                                                             |
| Draft                             | Preserve original code/wording and pins; if unmappable, eventual send retains old context.                                                                                                                                                         |

The agent can explicitly revalidate unchanged wording after checking current supporting context, or re-anchor the same note to a valid current range while preserving identity/thread. Unavailable context is not verified. Revalidation targets the snapshot actually checked; a newer snapshot intervening must cause conflict. Direct guidance edits still apply normal Viewed invalidation. Outdated guidance (needs code revalidation) and Outdated reply (references different wording) are separate facts using the same visible word, not declarations that a question is invalid.

## 6. Layout, keyboard and navigation

### Visual baseline

Preserve the accepted prototype's Catppuccin with lavender as sole accent, Inter + JetBrains Mono, inset main reading panel, compact inset-bar file headers, and sidebar with walkthrough above the snapshot-wide file tree. Selecting a file outside a group or a folder opens all changes under that path. No inbox, persistent snapshot badge, dedicated Guide me mode or separate comments pane.

The header shows the exact scope and compact PR-layer switcher when applicable. Gyst's wordmark uses the code face; a borderless GitHub link may show the release-baked/daily-cached star count, not a startup network request. Display snapshot/side at the code location where it matters rather than restoring the removed permanent badge.

A file's hunks read as one continuous diff over captured full contents. Touching hunks have no artificial gap. Each hidden range displays its line count and expands independently. A hidden range with other groups' hunks says “N lines, with changes from another group”; expansion shows those as real changes, never fake unchanged lines. Notes collapse to a bare chevron chip, without an “Agent note” heading or Ask button.

Layouts: split, stacked and auto; auto uses the existing roughly 120-column split threshold based on available diff width. Notes and inline navigation span the appropriate reading width, including both columns for peek. Keep narrow layouts usable.

### Input contract

Two modes, selectable in the status line/command menu:

- **Vim:** visible side-specific accent bar/tint cursor walking code, file headers, hidden ranges, notes and threads. Follow with scrolloff and retargetable scrolling; manual scrolling pulls the cursor back onscreen.
- **Mouse:** no cursor highlight; line-hover + and dragging select code/ranges. Movement keys scroll rather than expose a second focus model.

Disable review shortcuts while typing. Provide discoverable controls, visible keyboard focus, labelled actions and non-color-only status indications. Preserve logical cursor, selection and position across responsive reflow, folds, live updates and virtualization.

| Keys                                               | Action                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `j` / `k`, `Ctrl-d` / `Ctrl-u`, `gg` / `G`         | Move in Vim / scroll in Mouse                                                                                     |
| `h` / `l`                                          | Old/new side in split view                                                                                        |
| `V` / `v`                                          | Select lines; `c` comments on selected range                                                                      |
| `c`                                                | Comment on code line/range only                                                                                   |
| `r`                                                | Reply to note/thread at cursor                                                                                    |
| `x`                                                | Resolve/reopen open thread, human only                                                                            |
| `n` / `p`                                          | Next/previous note or open thread                                                                                 |
| `]c` / `[c`, `]n` / `[n`, `]t` / `[t`, `]f` / `[f` | Next/previous change, note, open thread, file                                                                     |
| `J` / `K`                                          | Next/previous group                                                                                               |
| `Enter` / `zo`                                     | Open one level: hidden range, note, replies/thread; Enter on file header toggles file                             |
| `Esc` / `zc`                                       | Close one level; Esc cancels active draft/selection first, without discarding saved draft; Esc never folds a file |
| `za`, `zR` / `zM`                                  | Toggle at cursor; unfold/fold every file                                                                          |
| `i`                                                | Show/hide all notes                                                                                               |
| `m`                                                | Toggle Viewed for current file section; checking folds/advances                                                   |
| `C`                                                | All comments                                                                                                      |
| `gd` / `gr`                                        | Definition / symbol usages on current line                                                                        |
| Backspace (`⌫`)                                    | Back from captured-code navigation                                                                                |
| `1` / `2` / `0`                                    | Split / stacked / auto layout                                                                                     |
| `R`, `⌘K`, `?`                                     | Explicit refresh, command menu, help                                                                              |
| Composer `Enter` / `Shift+Enter`                   | Send / newline                                                                                                    |

Context-specific interaction wins over global keys: in the navigation selector `j`/`k` changes live preview, Enter chooses/expands and Esc dismisses; text entry uses composer semantics. Mouse actions expose the same review operations. No key silently applies a mutation to a hidden underlying diff while an expanded captured file has focus.

### Captured links and semantic results

An authored link or selected semantic result opens an inline peek at its origin, **not a modal**. It spans both split columns: preview left, vertical symbol/location selector right, stacked at narrow widths. Keep compact Expand beside Close. No file-wide navigation controls, “Choose another symbol” action or special “Comment on highlighted range” button.

Right-click targets the exact symbol; `gd`/`gr` operate from the current line, offering valid identifiers including declaration parameters. `j`/`k` updates preview; Enter expands a single location or opens location selection for multiple results. Escape and repeat the query to choose another symbol. Preserve engine symbol-under-cursor semantics: an imported alias can have fewer usages than the original symbol; do not add custom alias expansion or claim an exhaustive call graph.

Expand opens captured full-file context in the main panel, highlighted with snapshot/side identity. Ordinary movement, code/range comments, replies, nested `gd`/`gr`, Mouse gutter actions and nested Back work there. Back restores origin focus/position, loading evicted content if needed. Navigation never marks/unmarks Viewed. Older retained context is clearly older, not a current change.

**Production rendering constraint:** the accepted full-width prototype uses an approved prototype-only layout bridge around a side-specific diff annotation interface. Do not copy that workaround. Verify a supported upstream full-width rendering path at the implementation's pinned version; if unavailable, report the blocker and obtain a decision rather than add an unauthorized patch or silently weaken the accepted interaction.

## 7. Native PR stacks

V1 supports GitHub-native linear stacks only. Require authenticated `gh` on the gyst host and a matching local checkout for PR opening; no new login system or automatic repository provisioning. Missing tools/access/objects produce actionable errors. Local/range review needs no GitHub access.

Opening a PR attempts native discovery. Distinguish absent stack membership from unavailable discovery; standalone review can continue if the PR range resolves. No branch-name/base-chain inference or alternate harness-defined stack format. Metadata has verification/freshness context; failure must not look like confirmed removal.

The compact, keyboard-accessible ordered switcher shows titles, position, PR open/merged/closed state and existing Viewed/unresolved counts for opened sessions. Unopened is explicit, not zero/complete. Selecting an unopened layer captures its then-current PR range as a plain diff session; selecting an existing one resumes it without refresh. Retain each session's position/drafts.

An explicit stack recheck updates metadata only. Removed layers remain reachable as saved sessions. Restacks/topology changes do not delete sessions, coordinate refresh or automatically invalidate guidance. Refresh affects only the selected session; layers may be captured at different times.

The agent gets whole-stack ordered identities, titles/descriptions, relationships and verification context, but prepares/responds only in the selected PR session. Inspect other layers when needed to verify claims; titles are not proof of behavior. References target the selected session's captured source, including inherited unchanged code. Ordinary links may lead to another PR/session; cross-session code-range links are not required. No stack-wide inbox/completion/dashboard, cumulative diff, local stack layers, branching graph, restack/push/merge or checkout switching.

## 8. Operations, transport and persistence safety

### Module ownership

```text
browser ── HTTP reads/commands + SSE invalidations ── foreground gyst
                                                        │
harness ── gyst session … ── daemon client ── Unix socket ┤
                                                        ▼
                              authoritative daemon / Sessions
                               ├─ pure core review operations
                               ├─ source acquisition (Git / gh)
                               ├─ SessionStore + captured content
                               └─ on-demand frozen-project analysis
```

Retain Effect services/layers and crust command handling, porting the platform adapters to Node. Do not move persisted review state into the bridge or duplicate use cases across transports. The frontend never reads live Git/filesystem data directly. Source acquisition, immutable captured inputs, mutable review state and disposable analysis have different lifetimes; keep those seams explicit without speculative storage/hosting frameworks.

CLI parsing ends at the CLI entry point. Replace today's `{command, cwd, args, stdin}` forwarding with validated structured operation payloads beneath it. A browser may not submit arbitrary CLI arguments, paths, Git options or executables. Caller authority comes from the entry point/authenticated context, never a user-supplied role field. Agent batches cannot impersonate humans, mark Viewed or resolve/reopen threads.

### Target schema responsibilities

These are requirements for revising the shared core schemas, not a claim that these fields/types already exist. Keep one authoritative schema/validation source for CLI, daemon, browser and tests; generated reference docs derive from it/command definitions.

| Record            | Required responsibility                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session           | Stable ID and scope/source identity; current snapshot pointer; review-state revision; walkthrough/group/file order; per-hunk Viewed; guidance/conversations; durable operation receipts |
| Snapshot/manifest | Immutable ID, recorded/resolved Git provenance, old/new full-file content identities/availability and derived text hunks; independent of review revisions                               |
| Group/guidance    | Stable group/note identities; overall/group Markdown overviews; explicit file order and membership; range-anchored notes, pinned references and Outdated/revalidation context           |
| Code target       | Snapshot, path, side and contiguous line range validated against captured content; mapping to current code does not destroy original context                                            |
| Thread/message    | Stable IDs, code or note target, flat ordered messages/author, per-human-message Pending/read, immutable agent replies, human resolution and per-reply wording                          |
| Draft context pin | Retained code/explanation identity protecting composition from refresh/cleanup; independent of mounted rows or cache eviction                                                           |
| Stack metadata    | Native membership/order/PR status, whole-stack descriptions and verification state; separate from session/snapshot endpoints                                                            |
| Receipt           | Caller-stable request identity, payload identity and exact durable response consistent with committed effects, including pickup/deletion                                                |

Status reports session/snapshot/revision, scope, structure/order, preparation coverage, Outdated guidance, conversation counts and known stack metadata. It must not expose Pending human message bodies or mark them read. Preparation completeness is not human completion. Large content reads must support bounded progressive loading rather than require a whole-session body on each invalidation; transport pagination/chunk representation is an implementation detail, not a new scope limit.

### Operation families and authority

| Family                           | Contract                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open/list/status/diff/code/check | Create-or-reuse selection; exact-ID reads afterward; captured filtered content; source checks never mutate review progress                                                   |
| Agent apply                      | One JSON batch: overall/group overviews/order/membership/file order; note create/edit/remove/re-anchor; checked-snapshot revalidation; immutable replies to existing threads |
| Human actions                    | Viewed, comment/reply, pending edit/delete, resolve/reopen; validate actor, target and revision; no browser-selected authority                                               |
| Thread pickup/history            | Pending pickup or selected/open-thread recovery, freezing only unread bodies actually returned; include history and original code/wording                                    |
| Refresh/delete                   | Explicit exact-session operations, atomic capture reconciliation or destructive saved-session removal, retry-safe even after lost acknowledgement                            |
| Subscribe                        | Committed-state invalidations with session/snapshot/state version and connection generation; no event-history replay                                                         |
| Navigation                       | Snapshot/side/target-identified queries, preparation/results/availability; never live fallback                                                                               |
| Export                           | Freeze ready state, preview disclosure, bind human approval to that state, generate read-only artifact                                                                       |

Validate the whole resulting batch and persist all-or-nothing. A complete group with notes/order can publish atomically; a reply and guidance improvement can publish together. Preserve stable identities rather than recreate guidance to edit it. Reject obsolete authoring fields, not silently translate them.

### Revision, retry and durability

- Preserve revision conflict checks and durable idempotency receipts; extend to durable human mutations, thread pickup, refresh and deletion. Snapshot-dependent work also names the checked snapshot.
- A caller supplies a stable request ID **before submission**. Same ID + same payload returns the exact recorded result; reused ID + changed payload fails. Check receipts before rejecting solely because current state has advanced. Historical replay output is not current status; reread before a new edit.
- Persist effects and receipt consistently, before changing authoritative memory/notifying clients. Failed persistence leaves prior state intact. Deletion retries still need a durable result after the session file is gone; do not mistake absence for an unrecorded new operation.
- Lost acknowledgements retry the original request, never a freshly identified duplicate. Genuine stale edits require reread/reconciliation and a fresh ID for changed intent. No automatic overwrite/revalidation of unseen snapshots.
- Pending pickup is a mutation: atomically choose the bounded-at-invocation set, freeze exactly the messages returned and save the exact bundle/receipt. Concurrent pending edits/deletes serialize against it. Status counts/omitted messages do not freeze anything. No fetch-then-ack race.
- Recovery can read already-read open conversations and retained history. Retrieving any unread bodies through that route freezes them under the same rules. Read does not invent an answered/completed state. If work from a retrieved bundle is unfinished, the workflow reports those threads.

### Subscriptions and reconnect

Production currently polls; implement native daemon subscriptions forwarded as SSE. They are invalidations after commit, not an append-only event log. Initial subscribe + authoritative read must close the missed-update race. Reconnect, daemon restart, overflow or stream failure triggers latest-state resynchronization. Coalescing is allowed; silent staleness is not.

Responses/notifications identify session, snapshot where relevant, state version and connection/daemon generation. Old responses cannot overwrite a newer selection, snapshot or generation. Foreground recovery resubscribes rather than recreating state. Closing one foreground server stops its HTTP/SSE lifetime only, not saved sessions or independent CLI clients. Keep the daemon's existing inode-aware hard-link ownership/reclaim guarantees when porting sockets; the packaging fixture's simpler ownership is not a substitute.

## 9. Optional TS/JS navigation

- Official optional package `@gyst/navigation-typescript`, executable `gyst-navigation-typescript`; these are planned release artifacts, not claims of current availability. Core and add-on publish in lockstep with exact matching release versions. Pin the tested native TypeScript engine (prototype candidate 7.0.2), not the project's compiler or an arbitrary configured server.
- Install on the daemon host: `npm install -g @gyst/navigation-typescript@<running-gyst-version>`, substituting the actual release in UI instructions. No in-app downloader, dependency installation, project scripts or arbitrary server configuration.
- Discover executable using the launching CLI's PATH and pass its validated location/version to the daemon; resident-daemon PATH may be stale. Spawn with explicit arguments, not a shell string. Browser requests cannot nominate executables.
- Missing add-on offers the exact command, Check again and Continue without navigation. Check again sees installation into the launch PATH's existing global bin directory without restarting. A changed Node/npm prefix/PATH needs a launcher restart. Mismatch gets an exact-version update instruction, distinct from project-input problems.
- Start only on semantic demand, not diff opening. Daemon owns preparation over isolated old/new captured project inputs for the **current snapshot**. No live-workspace mode. Retained historical code is readable but has no promised semantic environment.
- Project-only inputs exclude `node_modules`; missing dependencies/generated source produce potentially incomplete results with named gaps, or Unavailable with a reason. Zero incomplete results do not mean no usages. Results outside captured content cannot read arbitrary host files. No arbitrary TS/JS/framework virtual-file compatibility promise.
- Diff/guidance/authored links remain usable during Preparing or failure. Label query symbol/snapshot/side. Delayed results retain their original identity and cannot become results for a refreshed snapshot.
- Starting lifecycle policy: at most two engines across the daemon, stop after 60 seconds idle (not during an active query). Queue preparation without blocking review operations; cancel obsolete snapshot work/discard stale results. Delete session/stop daemon tears down its analysis; closing a launcher leaves unneeded analysis to expire. Reconstructible materializations may be reclaimed without deleting durable captured content. These limits are tunable policy, not measured latency/memory guarantees.

## 10. CLI and portable skills

Target command surface (not current commands):

```text
gyst [<Git range> | <PR URL>]
gyst --session <id>
gyst skills

gyst session open [<scope>]
gyst session list
gyst session status --session <id>
gyst session diff --session <id> [read filter]
gyst session code --session <id> [captured target]
gyst session threads --session <id> --pending|--open [--request-id <id>]
gyst session apply --session <id>        # validated JSON envelope on stdin
gyst session check --session <id> [--stack]
gyst session refresh --session <id>
gyst session delete --session <id>
gyst session export --session <id>      # disclosure preview and human approval
```

The export spelling above integrates the later export decision into the minimal command family; exact target/filter/approval flag spelling is implementation-owned. It must not create a silent approval bypass. Every durable mutation exposes caller-stable request identity (including pickup; do not mint a new one on manual retry) and applicable revision/snapshot preconditions. Generate precise schemas/help/examples together during implementation, not separately maintained protocol documentation.

`session open` returns JSON with stable session/snapshot identity and launch/inspection information, without starting a foreground server/browser. Session commands use machine-readable JSON successes and structured stderr errors; export's explicit human disclosure flow must remain usable by a human without confusing the harness JSON interface. Keep daemon lifecycle automatic/internal. No public daemon-management or hosted connection/auth flags.

Ship two workflows plus generated `gyst-cli` reference:

- `/gyst`: prepare/revisit selected scope, understand the whole change, publish complete groups progressively; reopening alone does not refresh/rewrite.
- `/gyst-respond`: one retry-safe pending bundle, existing-thread responses and requested fixes; repair reusable guidance where needed, report unfinished work and stop.
- Both reach one authoritative bundled authoring reference and examples on demand. No per-harness copies or dependency on private skills. `gyst skills` installs the package's own artifacts.

Remove old workflow registrations/files/examples and tests for `/gyst-ask` and `/gyst-refresh`, create-only `session create`, `close`, stdin/pathspec ingestion, queue/verdict operations and TUI-specific controls. Retain useful structural, packaging, failure and concurrency tests rather than blindly deleting legacy coverage.

## 11. Standalone walkthrough export

Both web and CLI create one self-contained HTML file for **one whole prepared session**, including uncommitted scopes or one PR-stack layer. Distribution is manual. It is not an importable session, live share or new agent-assisted review.

Readiness: complete unique hunk grouping, required overall/group overviews and no Outdated guidance. No override for partial/outdated content; no mechanical note-per-hunk requirement. An unavailable reference is disclosed explicitly but alone is not a new readiness gate. Never fetch live/external content, refresh or revalidate as a side effect of export.

Include ordered guidance/diff, complete captured old/new changed files and exact captured files targeted by guidance references, including supporting unchanged files; not the rest of the project. Preserve pinned identity/ranges, including older references. Stamp recorded scope, resolved Git identities (including three-dot merge base), snapshot identity and export time. For uncommitted/unborn input distinguish captured contents from HEAD/empty baseline; do not call the commit SHA their exact content identity.

Before generating the shared file, show included paths/sides/content identities, unavailable targets/reasons and a warning that **full files and guidance may disclose secrets/confidential content**. Require explicit human approval on both surfaces. Freeze snapshot + guidance consistently; preview, approval and generated bytes must refer to the same state. Concurrent edits/refresh cannot ride on an earlier approval. No automatic secret scanning, redaction editor, selected-group export or auto-publishing promise.

Exclude threads/messages, drafts, Viewed, credentials, local absolute checkout paths and private operational/session metadata from embedded **data**, not just visible controls. Only the enumerated provenance is public metadata.

Offline artifact retains group/file navigation, folds/layouts, full-file expansion, authored-reference peek/expand/nested Back and applicable read-only keyboard controls. No semantic engine, review-writing controls, agent/daemon connection or import. Bundle scripts, styles, fonts, highlighting and diagrams so `file://` works with networking disabled. No automatic requests, including localhost, CDN, telemetry or remote media; safe external links leave only on deliberate activation. Reuse safe rendering; embedding untrusted data must not create executable author content. Resource/write failure must not report partial output as success or harm saved state.

## 12. Runtime, access and responsiveness

### Runtime and packaging

Node 24 LTS `>=24.11.0 <25` is the initial development/production runtime. Global `npm install -g @gyst/cli`, shipping Node-compatible JS, built SPA and skill assets; no supported npx/project-local launch or standalone executable. Target Linux glibc and macOS, x64/arm64. No native Windows/Alpine-musl, Bun or Deno support promise.

Vite+ owns lint, format, Vitest (`vp test`) and build/task orchestration; replace turbo and `bun:test`. Retain compatible crust core/extensions/skills/Effect adapter, replace its Bun-dependent builder/publisher rather than monkey-patching it. Remove Bun runtime/tooling/CI/release requirements and TUI dependencies. Port sockets/spawn, platform layers, semver/hash and entry-path seams. Hash changes need not preserve old session identities. Verify selected dependency versions/public APIs when implementing; fixture versions are evidence, not a command to blindly upgrade every dependency.

Client-render React with standalone TanStack Router, assets located relative to the installed package. The package spike proved public crust skill rendering into included `.crust/root/skills`, not use of internal builder defines. Preserve a supported packaging path; no workspace-only file dependencies. New release artifacts must be checked outside the source checkout with Bun absent.

### Local and SSH security

Bind loopback only. Use a per-launch bootstrap token exchanged for a scoped cookie, remove it from the address bar, never log it or copy it into harness instructions, and send `Referrer-Policy: no-referrer`. Printing the private launch URL for the operator is the intentional bootstrap, not permission for request/access logs to capture the token. Protect reads, mutations and SSE, not just initial HTML. Enforce strict Host/Origin checks and safe captured-path resolution. Do not trust forwarded-host headers. Scope authentication to the launcher; cookie names alone are not a port-isolation guarantee. Verify bootstrap lifecycle and cross-launch isolation as security gates.

Remote development uses SSH forwarding only:

```text
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:LOCAL:127.0.0.1:REMOTE user@remote
```

Open the printed URL using LOCAL. Validate Origin against the request Host, not blindly against the listening port; unequal local/remote ports must work. No LAN/reverse-proxy/Tailscale Serve mode. The prototype's public tunnel is not a production access policy.

A future hosted deployment uses server-managed workspaces and the same review operations/UI. Do not build it now: remote CLI authentication, provisioning, credentials and tenant/process isolation remain future work, not configuration of local tokens. No initial local-workspace upload parity promise.

### Progressive loading and measured performance

No arbitrary file/hunk-count cutoff and no promise of instant work on unlimited resources. Bound browser rendering and reconstructible caches; prioritize visible, then nearby content with bounded prefetch; window/virtualize where needed. Eviction never deletes review data. Keep drafts, logical cursor/ranges, folds and navigation/scroll history separate from mounted rows and cached bytes.

After safe snapshot publication, first readable content must not wait for all files/groups to load/render. Loaded-content navigation never waits for a network round trip, including over SSH. Uncached navigation gives immediate stable loading feedback; failed loads allow retry while retaining the previous location. Back restores logical location, fetching evicted bytes as needed. Obsolete requests/live updates cannot steal focus, replace the current selection or discard drafts.

Measure production capture/first-usable content; warm/cold hunk/file/group navigation, preview selection and expansion/Back; input/scroll stalls and update latency; browser/server memory and transferred bytes over repeated traversal. Distinguish cold capture, saved-snapshot open, cold semantic preparation and warm navigation. Record workload, hardware/browser, cache state and network profile.

Use ordinary/large real reviews plus many-file, huge-file and dense-note/thread stress cases; starting points are 1,000 and 10,000 changed files and a 100,000-line file, **not supported-size ceilings**. Test local and documented SSH-like latency/bandwidth, progressive publication and nested navigation. Measure large exports separately (size, generation/open time, navigation and memory).

Numeric release gates require these production measurements and human acceptance **during implementation**. This is a deliberately specified acceptance step, not missing planning or a claim that fixture timings prove performance. Optimize poor results instead of reducing supported review size.

## 13. Migration phases and acceptance gates

Phases are dependency-ordered increments, not separate competing models. Within a phase reuse existing tests at the shared operation seam; remove assertions for intentionally removed behavior. Each phase must leave an explicit verified state and report blockers. Do not mark fixture feasibility or a cross-build as actual platform execution/human acceptance.

### Phase 1 — Node foundation and packaged web shell

**Change:** port retained runtime/platform/daemon/CLI infrastructure and tooling to Node/Vite+; replace the root TUI entry with the foreground SPA bridge; remove TUI/OpenTUI/Solid/editor dependencies and tests. Preserve inode-aware daemon ownership and error/cancellation behavior. Build/package skills and SPA via supported Bun-free interfaces. Introduce structured daemon requests beneath CLI parsing and HTTP/SSE without duplicating review logic.

**Gates:** Bun absent from build/runtime PATH; minimum and current Node 24 patch; globally install packed artifact outside checkout; help, parser errors, installed skills, root/deep routes/static assets and unknown-route handling; no uncaught browser errors. Exercise daemon start/reuse/stale-socket relaunch, persistence/restart and independent launcher lifetime. Preserve single-instance race checks. Authenticate HTTP/SSE; hostile Host/Origin/path/executable attempts fail; actual unequal-port SSH forwarding works. Test subscribe/read race, overflow, reconnect/restart, stale generations and coalesced updates.

### Phase 2 — Captured-source and session foundation

**Change:** whole-scope create-or-reuse, exact-ID operations, session list/delete; immutable manifests/content-addressed full files and source checks; multiple sessions; structured scopes/PR acquisition. Keep source work and staged capture separate from serialized publication. Make durable request receipts available to subsequent features, including replay after deletion.

**Gates:** same-scope reopen after moving refs keeps the snapshot; distinct ranges/PR sessions do not collide; headless open does not launch UI; saved sessions survive restart. Verify merge-base/uncommitted/untracked/unborn/absent-side inputs, line endings and unchanged helpers. Derive diffs from captured bytes, refuse detected concurrent edits, preserve state on failed write/capture. Read after checkout removal; no `node_modules`, ignored-untracked, binary/submodule or external-symlink leakage. Optional quota required-file failures/supporting gaps, actual disk failure, dedup across sessions, staging/GC races, active-reader/draft/reference pins and deletion isolation. Supporting-file changes must defeat no-op detection. Capturing large scopes must not require unbounded working-memory buffering.

### Phase 3 — Guidance, Viewed, conversations and reconciliation

**Change:** replace legacy schemas/reducers/status/apply/receipts with the target records; rich guidance and captured references; per-hunk Viewed; threads/Pending/history/drafts; one-bundle pickup; human/agent authority; refresh/revalidation. Remove legacy queue/inbox/acceptance and plain-note semantics, not adapt them behind aliases.

**Gates:** complete/unique coverage versus progressive preparation; note ranges spanning own hunks only, valid ordering and references; atomic invalid-batch rejection; precise Viewed invalidation/shared file checkboxes. Pending edit/delete racing read; status never freezes; pickup exact replay and later-arrival isolation; crash-after-pickup recovery; immutable agent messages; human-only resolve/reopen; late answers stay resolved. Distinct retained wording across rewrites and drafts, removed notes/groups preserve threads. Refresh line shifts, changed context, duplicates, split/merge, changed reference/unchanged anchor, empty retained group, range surviving a changed hunk, disappeared target, identity-preserving re-anchor, no-op/failure and stale revalidation. Lost acknowledgements do not duplicate comments/replies or effects; changed request payload fails; failed persistence leaves old state.

### Phase 4 — Production reading UI and workflows

**Change:** accepted layout, safe Markdown/Mermaid renderer, full-file diff expansion, keymap/Mouse mode, Viewed, inline conversation/Comments and nested captured-link navigation; bounded content loading. Implement `/gyst` and `/gyst-respond` with a shared bundled authoring reference and generated CLI reference. Wire native stack navigation/metadata and independent saved-session positions/drafts. Resolve the supported full-width rendering gate before adopting a diff implementation.

**Gates:** real browser tests for both layouts/modes, narrow width, keyboard/input isolation, range/side correctness, local discussion only, Pending/Outdated/reopen and reference peek/Back. Hidden other-group hunks are real changes; navigation never changes Viewed; no hidden-diff mutations from expanded views. Disconnect/conflict/stale-target feedback retains drafts; live preparation doesn't jump the reader. Hostile Markdown/URL/Mermaid content remains inert; malformed diagrams have useful fallback. PR B in A → B → C receives whole-stack context but only B preparation; C opens plain, B resumes unchanged; non-restacked PR uses actual merge base; recheck removal/unavailable metadata never deletes work. Missing `gh`/auth/objects remain distinct. Requested local fix outside PR scope does not trigger retarget/commit/push/refresh. Packaged workflows/examples install without private skills or checkout dependencies.

**Guidance-quality gate:** build four small self-contained Git fixtures: observable behavior + edge case, invariant-preserving refactor, changed caller/unchanged supporting reference, selected PR layer in verified stack context. Reuse authoring structural validation for overview presence, complete unique coverage, order/anchors/content/references. Generate each once in a fresh session with bundled instructions and evaluate unedited output. Record instruction revision, inputs, model/harness, outputs and human verdict; retain failures and prior accepted outputs. All four must be usable without substantive rewriting for correctness, mental-model clarity, logical-step coverage, useful examples/references, standalone readability and economy. Cosmetic nits are non-blocking; do not average away a weak case or cherry-pick retries. Rerun affected cases after instruction changes (all four for broad rules); no automated prose scoring/model matrix/benchmark harness.

### Phase 5 — Optional frozen navigation

**Change:** exact-release optional add-on/discovery, on-demand isolated project analysis, readiness/incomplete/unavailable states and real symbol/location picker integrated with the accepted peek/expand controls.

**Gates:** core review with no add-on; missing/mismatched/compatible installs; install then Check again with resident daemon; launch PATH versus changed prefix; actionable version instruction. Real old/new queries on representative TS/JS projects, not just the fixture; missing dependencies/config/generated inputs visibly incomplete/unavailable, alias semantics honest, UTF-16/CRLF positions and declaration parameters correct, historical queries unavailable, out-of-capture targets cannot read host files. Two-engine/idle lifecycle, long active query protection, queued preparation, refresh/delete/shutdown cancellation and stale-result fencing; ordinary diff never launches analysis. Measure capture/materialization and real-project usefulness/cost; report actual supported project limits rather than imply arbitrary compatibility.

### Phase 6 — HTML export and release acceptance

**Change:** consistent frozen-state export preview/approval on web and CLI, privacy-whitelisted payload, bundled offline reader using the same reading/rendering contract; no live review controls. Final documentation/help/release metadata and removal of obsolete examples/dependencies.

**Gates:** actual generated `file://` artifact with networking disabled, gyst stopped and checkout unavailable; diagrams/fonts/navigation/layouts/full files/nested Back work, zero automatic requests including localhost. Inspect embedded data for private state/tokens/paths/unrelated files, not merely hidden UI. Readiness failures, disclosed unavailable references, revision/uncommitted/unborn provenance, concurrent preview/edit/refresh binding, hostile embedding/URL/diagram content and explicit write failure without successful partial output. Complete production performance measurements from section 12, including repeated traversal and large exports; establish numeric gates with the human.

Run relevant type/lint/format/tests through the migrated Vite+ commands, packaged integration/browser suites and real global installs across Linux glibc/macOS x64/arm64, on minimum/current supported Node. Record OS/libc/browser versions and tested artifacts. Verify core without navigation and add-on installation/update/discovery on that matrix, plus upgrade/uninstall with a resident daemon. Unavailable runners/access are release blockers to report, not evidence of support. Cosmetic prototype acceptance does not waive production behavior, security, performance or platform gates.

### Existing implementation touchpoints

| Area                 | Current paths / replacement work                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure model           | `packages/core/src/{metadata,session,status,apply,draft,refresh,human-action,snapshot,wire,hash}.ts` and tests: retain pure validation/reconciliation and failure tests, replace obsolete concepts                   |
| Daemon               | `apps/gyst/src/daemon/{sessions,git,store,paths,server,client,protocol,wire}.ts`: structured operations, captured inputs, receipts, subscriptions, Node adapters; preserve ownership/persist-before-memory semantics |
| CLI                  | `apps/gyst/src/cli/app.ts`, `commands/{session,daemon}.ts`, `extensions/{co-review-skill,json-errors}.ts`, `src/index.tsx`: new root entry and target commands, retain supported crust/errors                        |
| TUI                  | Delete `apps/gyst/src/tui/` and terminal/editor-only coverage/dependencies; do not port it                                                                                                                           |
| Skills               | `apps/gyst/skills/`, generated reference/registration and `apps/gyst/tests/e2e/{cli,session,skill}.test.ts`: replace old workflows/contracts; retain packaging and real-process checks                               |
| Toolchain/release    | Root/workspace manifests, lockfile, tsconfigs, `mise.toml`, `turbo.json`, `scripts/publish.ts`, `.github/workflows/{check,release}.yml`: Bun/turbo/compiled-target removal, Vite+/npm path                           |
| Public documentation | `README.md`, `CONTRIBUTING.md`, CLI help, package description/release notes: web, Node, SSH, source coverage, skills and supported install/platforms; glossary remains terminology only                              |

## 14. Evidence, remaining verification and exclusions

### Evidence is bounded

- Design baseline: local `prototype/web-review-ui` at `c044677`; review-loop iteration on `prototype/web-review-loop` (map points to `df8244d`). Visual/interaction evidence only.
- Context preservation: local `prototype/comment-context` at `1b02920`; fixture Pending/Outdated/draft behaviors, not production persistence.
- Real engine lab: [`prototype/code-navigation` at `7431fb5`](https://github.com/chenxin-yan/gyst/tree/7431fb5c3cf73f52e35860da1c7fafec9d994703/prototype/navigation-lab), README/research/runnable checks. Small TS/JS old/new LSP fixture, not arbitrary-project support or production resource budgets.
- Packaged SPA spike: local unpushed `spike/node-spa-package` at `d8acedc939dd4064256b02c46e62b94c5fc668a7`, `prototype/node-spa-package/`. Bun-free global install/HTTP/SSE/browser checks on Linux x64 at Node 24.11.0 and 24.21.0, but with a **fixture daemon**, not the production Effect migration. Its measurements are not time-to-interactive or large-review gates.
- Accepted integrated UI: local unpushed `prototype/interactive-review` at `c280eca`, `prototype/web-review-loop/`. Human accepted direction; Chromium/layout checks on a Node/Vite+ fixture. No actual daemon, LSP, stack discovery, capture, reconciliation or production transport. Full-width bridge is prototype-only.

Local branches are evidence pointers, not published artifacts or dependencies of implementation. Temporary tunnel URLs are not durable assets. Inspect prototype instructions on their branches; do not merge throwaway code wholesale or depend on this checkout's unrelated prototype files.

Known implementation gates remain: supported full-width rendering; real-project project-only TS/JS usefulness; capture/GC/retry/subscription correctness; secure local/SSH access; production performance and human-set numerical release gates; and packaged platform execution. None is asserted passed by this spec. They call for implementation evidence or an explicit return with a blocker, not silent policy changes.

### Out of scope

Hosted deployment/local uploads, multi-user review, GitHub comment sync, external editor opening, agent spawning/auto-wake, stdin patches/pathspec capture, TUI preservation, schema migration/compatibility aliases, dedicated Guide me mode, dependency capture/install/reconstruction, extra language/framework support, historical semantic environments, stack orchestration/cumulative review, standalone binaries/npx/project-local launch/Windows/musl/Deno/Bun, LAN/proxy access, importable exports/selective exports/redaction/automatic publication. Reopen scope explicitly rather than smuggle these into an implementation phase.

### Decision register

| Decision                                                                                                                                 | Integrated sections                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Review loop and review states](https://github.com/chenxin-yan/gyst/issues/61#issuecomment-5841705638)                                   | Journey, Viewed, keymap/layout                                   |
| [Shape of the agent's guidance](https://github.com/chenxin-yan/gyst/issues/62#issuecomment-5842394073)                                   | Guidance, rendering, invalidation                                |
| [How an agent in the harness learns about new comments](https://github.com/chenxin-yan/gyst/issues/63#issuecomment-5829611835)           | Human-triggered workflow; later control-plane refinement applies |
| [Options for go-to-definition and references](https://github.com/chenxin-yan/gyst/issues/64)                                             | Historical research; defer-LSP recommendation superseded         |
| [Reaching gyst from a laptop when developing on a remote machine](https://github.com/chenxin-yan/gyst/issues/65#issuecomment-5829612875) | SSH access; architecture excludes proxies                        |
| [What leaving Bun for Node (or Deno) takes](https://github.com/chenxin-yan/gyst/issues/66#issuecomment-5829613383)                       | Migration evidence; runtime resolution governs                   |
| [Rendering agent Markdown and Mermaid safely and themed](https://github.com/chenxin-yan/gyst/issues/67#issuecomment-5829613886)          | Shared rich renderer/export                                      |
| [How PR stack tools model and review stacks](https://github.com/chenxin-yan/gyst/issues/68)                                              | Historical research; native-stack resolution governs             |
| [Comment threads](https://github.com/chenxin-yan/gyst/issues/69#issuecomment-5843189031)                                                 | Conversations, except subsequently removed overview targets      |
| [What survives a refresh after a fix](https://github.com/chenxin-yan/gyst/issues/70#issuecomment-5843528827)                             | Refresh and context retention                                    |
| [Native PR stack support](https://github.com/chenxin-yan/gyst/issues/71#issuecomment-5844925002)                                         | Scope and thin stack UI                                          |
| [Code navigation in v1](https://github.com/chenxin-yan/gyst/issues/72#issuecomment-5844769556)                                           | Optional frozen analysis; capture narrows dependency targets     |
| [Runtime and distribution](https://github.com/chenxin-yan/gyst/issues/73#issuecomment-5849387828)                                        | Node/npm/Vite+, add-on and platform gates                        |
| [Hosted-ready architecture seams](https://github.com/chenxin-yan/gyst/issues/74#issuecomment-5851460434)                                 | Operations, transport, lifecycle/security                        |
| [Spike: serve the React SPA from gyst's distributable](https://github.com/chenxin-yan/gyst/issues/75#issuecomment-5852481515)            | Standalone Router, bounded package evidence                      |
| [Minimal skill and CLI surface](https://github.com/chenxin-yan/gyst/issues/76#issuecomment-5854542969)                                   | Sessions, operations, pickup, workflows                          |
| [Prototype the interactive review UI](https://github.com/chenxin-yan/gyst/issues/77#issuecomment-5866603001)                             | Accepted UI, overview-thread removal, rendering gate             |
| [Capturing unchanged code for snapshot references](https://github.com/chenxin-yan/gyst/issues/79#issuecomment-5875371406)                | Capture/store/retention; preset quotas superseded                |
| [Evaluating the quality of agent guidance](https://github.com/chenxin-yan/gyst/issues/80#issuecomment-5875701403)                        | Four-fixture human quality gate                                  |
| [Responsiveness and large-diff navigation](https://github.com/chenxin-yan/gyst/issues/82#issuecomment-5876552163)                        | No preset quotas, progressive loading, measured release gates    |
| [Sharing a walkthrough as a standalone HTML export](https://github.com/chenxin-yan/gyst/issues/83#issuecomment-5877026544)               | Export, disclosure/privacy/offline gates                         |
