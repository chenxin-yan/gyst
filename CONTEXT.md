# Gyst

A keyboard-centric co-review web app, served locally: the user's coding-agent harness composes a self-contained, top-to-bottom walkthrough of a diff and co-reviews it live with the human. Gyst supplies the context for the human's judgment; it never judges the code itself.

## Language

**Session**:
One saved review of one recorded scope, with its captured code, walkthrough and human review work. The unit both the human and the agent operate on.
_Avoid_: Review, instance

**Snapshot**:
The frozen diff and captured project files from a session's source, including unchanged code that supplies supporting context. Refresh explicitly replaces it, carrying forward surviving review work and retaining older context where needed; source changes alone never alter it.

**Hunk**:
One `@@` text block of the diff, addressed by a stable id. Gyst reviews text hunks only: mode bits, renames and binary content are not part of a session, and a file that changes nothing else is rejected.

**Walkthrough**:
The ordered sequence of groups explaining a scoped change from top to bottom, including the reading order of files within each group. Every changed hunk belongs to exactly one group when preparation is complete. Until then, ungrouped hunks appear only under their files, never as a list of their own; with no groups at all, the session is a plain diff viewer.
_Avoid_: Inbox

**Walkthrough export**:
A standalone, read-only copy of one complete walkthrough and its included captured code, shared independently of the live session. It excludes private conversations and reading progress and cannot be imported as a session.

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
A code link within an overview or note to an exact captured snapshot, file, side and line range, including unchanged code outside the diff. It supplies supporting context, not a separate explanation or review item or the symbol usages discovered by Find references.

**Comment**:
A human message starting a thread on one contiguous range of captured code, on one side of one file.

**Change request**:
A human message marked as asking for a code change rather than an explanation (a Question, the default). Only a change request authorizes the agent to fix code.

**Reply**:
A subsequent message in a thread, from the human or agent, or the human message starting a conversation on a note.

**Thread**:
A flat conversation anchored to captured code or a note. Code ranges may host separate conversations; each note has at most one thread, and overviews are not conversation targets.

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

**Generated file**:
A changed file that `.gitattributes` marks `linguist-generated` or `linguist-vendored`. It starts folded but is reviewed and grouped like any other file.

**Review comment**:
Planned after v1: a human comment for a PR's author, staged in gyst and posted to GitHub as part of a review. Separate from threads, which talk to the agent.
_Avoid_: Comment (that starts a thread)

**Scope**:
What a session reviews: uncommitted changes (the default), a recorded Git revision range such as `main...feature`, or a PR whose range is resolved for capture. The scope remains the same as its source changes; it is distinct from a snapshot's frozen contents.
_Avoid_: Target, range

**Stack**:
An ordered, linear set of GitHub-native PRs providing context and navigation around a selected PR's session, not a shared review or completion state.

**Layer**:
One PR's position in a stack. Its session belongs to the PR, not its position or current head, and keeps independent captured code and review work.

**Source check**:
An informational comparison of the recorded Git scope's source with the snapshot, including captured supporting files rather than only changed hunks. It may report changed, unchanged or unavailable; a check never changes the snapshot or review progress.

**Co-review**:
The live phase once groups are published: the human drives the web app while the agent operates the same session through the control plane. It can overlap preparation of later groups.

**Control plane**:
The daemon plus the session CLI — the only surface through which any harness reaches gyst.
_Avoid_: API, integration layer

**Harness**:
The user's coding agent environment (Claude Code, Codex, pi, OpenCode). Gyst ships a skill/command per harness; all of them drive the same CLI.
_Avoid_: Agent (that's the model driving the harness), IDE
