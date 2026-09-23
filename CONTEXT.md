# Gyst

A keyboard-centric co-review TUI: the user's coding-agent harness organizes a diff into coherent review items and co-reviews them live with the human. Gyst supplies the context for the human's judgment; it never judges the code itself.

## Language

**Session**:
One live review of one diff range, held by the gyst daemon and rendered in the TUI. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Hunk**:
One `@@` text block of the diff, addressed by a stable id. Gyst reviews text hunks only: mode bits, renames and binary content are not part of a session, and a file that changes nothing else is rejected.

**Review item**:
A unit presented for one human verdict: either a group or a spotlight hunk.
_Avoid_: Highlight, card

**Group**:
An agent-proposed set of hunks best understood and reviewed together because they contribute to one coherent change. Its members may perform different operations; shared context, not mechanical repetition, makes them a group.
_Avoid_: Pattern, cluster, fold

**Spotlight**:
An ungrouped hunk prepared as a review item with an agent-written title and overview.
_Avoid_: Highlight, meat, important hunks

**Title**:
The short, plain-text name of a review item, identifying its change in the review queue.

**Overview**:
An agent-authored explanation of a review item's intent, relevant context, and behavioral changes, grounded in the source. It supports the human's judgment without replacing the code or asserting an unverified verdict.
_Avoid_: TLDR, annotation

**Inbox**:
Ungrouped hunks not yet prepared as review items. Published review items can be reviewed while the inbox still contains hunks awaiting agent triage.
_Avoid_: Spotlight, unreviewed hunks

**Verdict**:
The human's single ruling on a review item: accept — "done reviewing this part". A group's verdict covers all its member hunks; verdicts live in the session and are never exported.
_Avoid_: Approval, resolution, flag

**Pre-pass**:
The agent's preparation of the scoped change for review: gather context, organize the hunks, and publish complete review items. Preparation may continue while the human reviews items already published.
_Avoid_: Analysis phase, triage

**Scope**:
What the human hands the harness to review — any diff range, not just a PR: uncommitted changes, a ref range, a PR. Named in the invocation ("/gyst uncommitted changes", "/gyst PR 42") and shown in the session header.
_Avoid_: Target, range

**Co-review**:
The live phase after the pre-pass: human drives the TUI, agent operates the same session through the control plane.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches gyst.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Gyst ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
