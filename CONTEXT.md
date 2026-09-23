# Gyst

A keyboard-centric co-review TUI: the user's coding-agent harness composes a self-contained, top-to-bottom walkthrough of a diff and co-reviews it live with the human. Gyst supplies the context for the human's judgment; it never judges the code itself.

## Language

**Session**:
One live review of one diff range, held by the gyst daemon and rendered in the TUI. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Snapshot**:
The frozen diff captured from a session's source. Refresh explicitly replaces it, retaining only still-valid review work; source changes alone never alter it.

**Hunk**:
One `@@` text block of the diff, addressed by a stable id. Gyst reviews text hunks only: mode bits, renames and binary content are not part of a session, and a file that changes nothing else is rejected.

**Walkthrough**:
The ordered sequence of groups explaining a scoped change from top to bottom. Every changed hunk belongs to exactly one group when preparation is complete.

**Group**:
One self-contained walkthrough step and the unit of a human verdict, containing one or more hunks contributing to one coherent change. Its explanation and selected source context let the human understand the change without reconstructing other steps.
_Avoid_: Spotlight, pattern, cluster, fold

**Title**:
The short, plain-text name of a group, identifying its change in the walkthrough.

**Overview**:
A concise, agent-authored breakdown of a group's intent, relevant context, and behavioral changes, with selected source context where needed. It lets the human skim the change and exercise judgment without replacing the changed hunks or asserting an unverified verdict.
_Avoid_: TLDR, annotation

**Inbox**:
Hunks not yet published in a group. Published groups can be reviewed while the inbox still contains hunks awaiting preparation.
_Avoid_: Unreviewed hunks

**Verdict**:
The human's single ruling on a group: accept — "done reviewing this part". It covers every member hunk; verdicts live in the session and are never exported.
_Avoid_: Approval, resolution, flag

**Pre-pass**:
The agent's preparation of a walkthrough: understand the whole scoped change, plan complete coverage and order, then publish self-contained groups top to bottom. Preparation may continue while the human reviews groups already published.
_Avoid_: Analysis phase, triage

**Scope**:
What the human hands the harness to review — any diff range, not just a PR: uncommitted changes, a ref range, a PR. Named in the invocation ("/gyst uncommitted changes", "/gyst PR 42") and shown in the session header.
_Avoid_: Target, range

**Source check**:
An informational comparison of the recorded Git scope with the snapshot. It may report changed, unchanged or unavailable; stdin has no replayable source. A check never changes the snapshot, review revision, cursor, queue or verdicts.

**Co-review**:
The live phase once groups are published: the human drives the TUI while the agent operates the same session through the control plane. It can overlap preparation of later groups.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches gyst.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Gyst ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
