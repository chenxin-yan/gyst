---
name: gyst-respond
description: Answer the human's pending comments in one gyst session, then stop. Invoked by the human as /gyst-respond <session-id>; retrieves one bounded set of Pending messages, replies, fixes only what was marked Change request, repairs guidance and reports.
disable-model-invocation: true
---

# Respond to one set of review comments

The human reads a gyst walkthrough in the browser and leaves comments on code and replies to notes. Each human message is a **Question** (`kind: "question"`) or a **Change request** (`kind: "change"`), and stays Pending until you retrieve it. This workflow retrieves the Pending messages once, answers them, and stops. Gyst never launches or wakes you: later messages wait for the human to invoke this workflow again.

The human names the exact session: `/gyst-respond <session-id>`. Pass `--session <id>` to every command. If no id was given, ask for it; do not pick one from `gyst session list`.

Read the `gyst` skill's [authoring reference](../gyst/references/authoring.md) before changing any guidance; [its examples](../gyst/references/examples.md) include reply batches. Use the `gyst-cli` skill for exact syntax, ops, output and error codes.

## 1. Pick up once

Choose one request id for this pickup before running it, such as `respond-` and a fresh UUID, and keep it:

```sh
gyst session threads --session <id> --pending --request-id <request-id>
```

This one step takes the open threads with Pending messages as of now, marks exactly the messages it returns as read (frozen: the human can no longer edit them) and records the bundle under that request id. Run it once per invocation.

- **Lost reply** (timeout, killed process, `daemon_unreachable`, output you could not read): run the same command with the **same request id**. It returns the same bundle and freezes nothing more. Never mint a new id to retry; a new id is a new pickup.
- Messages that arrive after the pickup are not in the bundle and stay Pending for the next invocation. Do not retrieve again to catch them.

The bundle has `snapshotId`, `revision`, `progress` (`viewed` of `total` current hunks), `openThreads`, and `threads`. Each thread carries its whole history in `messages`, the ids of the messages this pickup read in `unread`, its `anchor` and captured `code`, and for note threads `note` and each human reply's `wording` (the note text that reply was written against), with `earlierCode` where that note has moved since.

## 2. An empty bundle

If `threads` is empty there is nothing to answer. Report from the bundle's `progress` and stop:

- `viewed` equals `total`: the review is finished, with every hunk Viewed and nothing waiting for an answer. Mention `openThreads` if any remain open for the human to resolve.
- Otherwise: nothing to answer yet; the human is still reading (`viewed` of `total` hunks Viewed).

Do not ask the human to confirm, wait, poll or retrieve again.

## 3. Answer each thread

First read `gyst session status --session <id>`; do not assume this invocation prepared the session or that the current directory is its checkout. `session.repoRoot` is the repository the session reviews and `session.scope` its recorded scope, which section 4 depends on. A PR session's `pullRequest` holds the selected PR and its verified native stack, each layer with its title and description: use the whole stack as context, but reply and fix only in this session.

Answer the messages listed in `unread`, reading the whole thread for context and the code the thread is anchored to. Check claims against the snapshot with `gyst session code --snapshot <snapshotId>` rather than the live checkout.

- **Question**: it authorizes an explanation, never a code change, whatever its wording ("could you rename this?" is still a Question). Explain, and if it implies a change, say the human can send a Change request. If the next reader would ask the same thing, improve the reusable guidance (a note, a group or the walkthrough overview) in the same batch and keep the reply brief; otherwise reply only.
- **Change request**: it authorizes the fix it asks for and nothing broader. Follow section 4.

Replies are free-form Markdown, posted with `thread.reply` by thread id; there is no required verdict wording. They are immutable once posted. You cannot resolve or reopen threads, mark anything Viewed, start a thread or write as the human, and you should not claim a thread is resolved: only the human resolves. A reply to a resolved thread stays in that thread without reopening it.

## 4. Change requests

Make the requested change in the session's repository (`repoRoot`) and verify it as far as you can. Then decide whether the session's recorded scope includes it:

- **Uncommitted changes** (`scope.kind` `uncommitted`): a working-tree edit is in scope. Refresh with `gyst session refresh --session <id> --snapshot <snapshotId> --request-id <new id>`, using the current snapshot id, then repair the guidance as the authoring reference's "After a refresh" section says, and reply on the new snapshot and revision. Retry a lost refresh reply with the same request id; `stale_revision` means the session was refreshed already, so reread status instead of refreshing again.
- **A Git range or a GitHub PR**: the range is committed history and the PR is what was pushed, so a working-tree edit is not part of it. Do not commit, push, retarget the session, restack or refresh to make it fit. Leave the edit in the checkout, say in the reply what you changed locally and that the session does not show it, and report it. Only when the human has already committed or pushed it, so that `gyst session check --session <id>` reports `changed`, does a refresh include it.

## 5. Publish replies and guidance

Send replies and guidance changes in one batch, or a few, to `gyst session apply --session <id>`, with the bundle's `snapshotId` and `revision` (or the snapshot and revision after a refresh, or from the last successful reply). Choose each batch's `idempotencyKey` before sending it.

- Lost reply: resend the identical batch with the same key; it returns the recorded result and posts nothing twice.
- `stale_revision`: the human acted meanwhile, such as marking Viewed or sending a message. Nothing from the rejected batch was posted. Reread `gyst session status --session <id>`, rebuild the batch on its revision and send it under a new key.
- `validation_failed`: fix what `detail` names and send it under a new key.

Editing a note or overview unviews the hunks it covers, so improve guidance only where it helps the next reader.

## 6. Report and stop

Report briefly: which threads you answered, which Change requests you fixed and whether each is in the session or only a local edit, which guidance you changed (so the human rereads it), and every thread from this bundle you did not finish, with why. Do not claim everything is answered when it is not. Then stop: do not retrieve again or wait for more messages.

### Recovering interrupted work

If an earlier `/gyst-respond` was cut off after its pickup, its messages are read but may be unanswered. Retry that pickup with its own request id if you still have it; otherwise `gyst session threads --session <id> --open --request-id <new id>` returns every open thread with its whole history, already-read messages included. Answer every message in its `unread`: this retrieval was the first to read them. For the already-read human messages, check what the replies after them actually say: a reply may answer only some of the messages before it, or report work as unfinished, so a later agent reply does not mean a message was answered. Answer what is still open and report as above.
