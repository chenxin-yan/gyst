# Gyst

A keyboard-centric co-review TUI: the user's coding-agent harness pre-folds a diff into pattern groups and then co-reviews it live with the human. Gyst reduces the human's reading; it never judges the code itself.

## Language

**Session**:
One live review of one diff range, held by the gyst daemon and rendered in the TUI. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Hunk**:
One `@@` text block of the diff, addressed by a stable id. Gyst reviews text hunks only: mode bits, renames and binary content are not part of a session, and a file that changes nothing else is rejected.

**Group**:
An agent-proposed set of hunks sharing one mechanical pattern, shown folded as a single exemplar plus an occurrence count.
_Avoid_: Pattern, cluster, fold

**Spotlight**:
An ungrouped hunk with an agent-written tldr, left for the human to read in full.
_Avoid_: Meat, important hunks

**Inbox**:
An ungrouped hunk without a tldr that still needs agent triage. An empty inbox plus a set review queue means the session is ready for the human.
_Avoid_: Spotlight, unreviewed hunks

**Verdict**:
The human's single ruling on a group or spotlight hunk: accept — "done reviewing this part". Expanding a group is a view action, not a verdict; there is no flag. Verdicts live in the session; they are never exported.
_Avoid_: Approval, resolution, flag

**Pre-pass**:
The agent's batch phase before the human looks: gather context on the scoped change, propose groups and the spotlight through the control plane.
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
