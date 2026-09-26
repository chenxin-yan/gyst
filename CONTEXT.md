# Gyst

A keyboard-centric co-review web app, served locally: the user's coding-agent harness composes a self-contained, top-to-bottom walkthrough of a diff and co-reviews it live with the human. Gyst supplies the context for the human's judgment; it never judges the code itself.

## Language

**Session**:
One live review of one diff range, held by the gyst daemon and rendered in the web app. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Snapshot**:
The frozen diff captured from a session's source. Refresh explicitly replaces it, carrying forward surviving review work and retaining older context where needed; source changes alone never alter it.

**Hunk**:
One `@@` text block of the diff, addressed by a stable id. Gyst reviews text hunks only: mode bits, renames and binary content are not part of a session, and a file that changes nothing else is rejected.

**Walkthrough**:
The ordered sequence of groups explaining a scoped change from top to bottom, including the reading order of files within each group. Every changed hunk belongs to exactly one group when preparation is complete. Until then, ungrouped hunks appear only under their files, never as a list of their own; with no groups at all, the session is a plain diff viewer.
_Avoid_: Inbox

**Group**:
One self-contained walkthrough step containing hunks contributing to one coherent change. Its overview, ordered files and anchored notes provide context; after refresh, an Outdated group may temporarily retain its place and guidance without any current hunks.
_Avoid_: Spotlight, pattern, cluster, fold

**Title**:
The short, plain-text name of a group, identifying its change in the walkthrough.

**Overview**:
An agent-authored introduction to a walkthrough or group, giving the big picture before its code and notes. A walkthrough overview explains the overall change; a group overview explains that group's contribution.

**Note**:
An agent-authored explanation of a logical step and its relevant context, anchored to one old- or new-side file range intersecting its group's changed hunks in the snapshot it explains. It accompanies the code and may contain examples, diagrams and references.
_Avoid_: Comment thread

**Outdated guidance**:
A retained explanation whose supporting code or referenced context changed during refresh and has not yet been revalidated. Outdated signals that the explanation may no longer describe the current snapshot.

**Reference**:
A code link within an overview or note to an exact captured file, side and line range, including unchanged code outside the diff. It supplies supporting context, not a separate explanation or review item.

**Comment**:
A human message starting a thread on one contiguous range of captured code, on one side of one file.

**Reply**:
A subsequent message in a thread, from the human or agent, or the human message starting a conversation on a note or overview.

**Thread**:
A flat conversation anchored to captured code, a note or an overview. Code ranges may host separate conversations; each note or overview has at most one thread.

**Pending message**:
A human comment or reply not yet read by the agent, still editable and deletable by its author. Reading freezes that message; corrections then become new replies.

**Outdated reply**:
A reply whose referenced explanation has since changed or been removed, retaining the wording it refers to. Outdated describes its context, not the validity of the question.

**Resolved thread**:
A conversation the human has marked as finished, hidden from the diff but retained in the Comments list and reopenable. Resolution is independent of Viewed.

**Viewed**:
The human's per-hunk reading state, shared across every view of that hunk. It records review progress, not correctness approval or thread resolution.
_Avoid_: Verdict, group Done

**Pre-pass**:
The agent's preparation of a walkthrough: understand the whole scoped change, plan complete coverage and order, then publish self-contained groups top to bottom. Preparation may continue while the human reviews groups already published.
_Avoid_: Analysis phase, triage

**Scope**:
What a session reviews: uncommitted changes (the default) or a Git revision range such as `main...feature`. A PR is resolved to its range before capture. Named in the invocation (`gyst main...feature`, "/gyst this PR") and shown exactly in the session header.
_Avoid_: Target, range

**Source check**:
An informational comparison of the recorded Git scope with the snapshot. It may report changed, unchanged or unavailable. A check never changes the snapshot or review progress.

**Co-review**:
The live phase once groups are published: the human drives the web app while the agent operates the same session through the control plane. It can overlap preparation of later groups.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches gyst.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Gyst ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
