# Gyst

A keyboard-centric co-review TUI: the user's coding-agent harness pre-folds a diff into pattern groups and then co-reviews it live with the human. Gyst reduces the human's reading; it never judges the code itself.

## Language

**Session**:
One live review of one diff, held by the gyst daemon and rendered in the TUI. The unit both the human and the agent operate on. At most one per repo.
_Avoid_: Review, instance

**Snapshot**:
The frozen set of files and hunks a session captured at creation or last refresh. Groups, verdicts, and the spotlight all reference its hunks; it never shifts under the reviewer.
_Avoid_: Diff state, working copy

**Refresh**:
Re-deriving the snapshot — replaying the session's recorded git args, or the agent piping a new diff. Unchanged hunks keep their groups and verdicts; new or changed hunks land in the inbox unruled.
_Avoid_: Reload, watch

**Group**:
An agent-proposed set of hunks sharing one mechanical pattern, shown folded as a single exemplar plus an occurrence count.
_Avoid_: Pattern, cluster, fold

**Spotlight**:
The ungrouped hunks the agent annotated with a tldr — deliberately left for the human to read in full.
_Avoid_: Meat, important hunks

**Inbox**:
Hunks not yet triaged — ungrouped and without a tldr. Where hunks land at create and refresh; the agent empties it by folding into groups or annotating into the spotlight. Ready to review means the inbox is empty.
_Avoid_: Untriaged, pending

**Tldr**:
The agent's one-line annotation on a group or spotlight hunk — what it is, and why it's folded or why it needs eyes. One concept for both; every group and every spotlight hunk carries exactly one.
_Avoid_: Label, summary, note

**Verdict**:
The human's ruling on a group or hunk: accept. The only verdict; it toggles in place and is undoable. Expanding a group is a view toggle, not a verdict. Verdicts live in the session; they are never exported.
_Avoid_: Approval, resolution, flag

**Pre-pass**:
The agent's batch phase before the human looks: gather codebase/PR context, propose groups and the spotlight through the control plane.
_Avoid_: Analysis phase, triage

**Co-review**:
The live phase after the pre-pass: human drives the TUI, agent operates the same session through the control plane.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches gyst.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Gyst ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
