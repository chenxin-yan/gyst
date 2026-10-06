# Review GitHub PRs from gyst

## Status

Specified for **after v1**; [Interactive web review](web-review-ui.md) keeps it out of v1 scope. This records the agreed direction so the v1 design does not close it off. It authorizes no implementation; split it into tickets when it is taken up.

## The user story

The human reviews a teammate's PR in gyst, using the agent's walkthrough to understand it, and sends the PR author a GitHub review: inline comments, a summary and a verdict. GitHub only, matching the native stack support; other forges are not planned.

Gyst's v1 threads talk to the agent. A review talks to the PR author. The two audiences never mix: an agent conversation must not reach a PR, and a review comment must not reach the agent's pickup.

## Review comments

A **review comment** is its own record, not a third message kind on a thread. It shares the composer and the code-range anchor: in a PR session the composer offers _Ask agent_ or _Comment on PR_. Review comments are never part of pending pickup, thread history or Viewed.

Gyst is the staging area for one review per PR session:

- The human's drafts and the agent's drafts are staged together. Agent drafts are labelled "Drafted by agent" in gyst only.
- Any draft can be edited or deleted until submission. There is no per-comment accept step.
- **Submit** shows one preview: every inline comment (agent drafts counted and grouped), comments that will move into the summary, the summary and the verdict. One explicit human approval posts the whole review. Gyst does not create a GitHub pending review to finish on GitHub.
- Posted comments freeze and keep their GitHub IDs and URLs. Gyst does not sync later edits or replies made on GitHub.

## Summary and verdict

The **summary** is the review's top-level body: the human's overall message to the author. GitHub requires one for _Comment_ and _Request changes_ and makes it optional for _Approve_ ([API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)). The agent may draft it, staged like its comments.

The **verdict** (Comment, Approve or Request changes) is always the human's choice. The agent never proposes one. Viewed stays reading progress; approval happens only through an explicit submission.

## Mapping to GitHub

- GitHub accepts inline comments only on lines inside the PR's diff hunks. A comment on expanded context or a supporting file moves into the summary as a `path:line` quote, marked "will post in summary" in the preview. Nothing is dropped silently.
- A review is posted with `commit_id` set to the snapshot's head. If the PR head has moved since capture, submission refuses and asks for a refresh; refresh carries drafts forward under the existing reconciliation rules. Gyst never posts a review on code the human has not read.

## Existing GitHub threads

PR sessions show the PR's existing review threads read-only:

- Threads whose lines still match the snapshot appear inline, labelled GitHub and collapsed by default.
- Other threads appear only in the Comments list, marked as being on an older commit.
- No replying or resolving from gyst.
- The agent can read them through the CLI as context, for example to explain what a reviewer asked about. It never replies to them on GitHub.

## Agent-drafted comments

The agent drafts review comments and the summary only when the human asks, never on its own initiative.

## Open questions

- How the human asks for agent drafts. It must stay within gyst's two workflows (`/gyst` and `/gyst-respond`) and must not go through an agent thread, which would mix the audiences.
