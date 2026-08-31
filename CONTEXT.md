# Pith

A keyboard-centric co-review TUI: the user's coding-agent harness pre-folds a diff into pattern groups and then co-reviews it live with the human. Pith reduces the human's reading; it never judges the code itself.

## Language

**Session**:
One live review of one diff range, held by the pith daemon and rendered in the TUI. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Group**:
An agent-proposed set of hunks sharing one mechanical pattern, shown folded as a single exemplar plus an occurrence count.
_Avoid_: Pattern, cluster, fold

**Spotlight**:
The residual set of hunks the human must read in full — everything not folded into a group.
_Avoid_: Meat, important hunks

**Verdict**:
The human's ruling on a group or hunk: accept the fold, expand it, or flag it. Verdicts live in the session; they are never exported.
_Avoid_: Approval, resolution

**Pre-pass**:
The agent's batch phase before the human looks: gather codebase/PR context, propose groups and the spotlight through the control plane.
_Avoid_: Analysis phase, triage

**Co-review**:
The live phase after the pre-pass: human drives the TUI, agent operates the same session through the control plane.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches pith.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Pith ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
