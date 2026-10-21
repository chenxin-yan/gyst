# Example batches

Complete `gyst session apply` batches for one small change, read with [the authoring reference](authoring.md). Replace every id, revision, snapshot id, key, hunk id and line range with values from your own session: `snapshotId` and `revision` from status or the reply that last changed the session, hunk ids from `gyst session diff`, thread ids from `gyst session threads`, and line numbers from the snapshot's captured code. Choose a new `idempotencyKey` for every new batch, and reuse one only to resend that same batch after a lost reply.

The change: an auth service accepted expired credentials. It now rejects them before the account lookup, and the clock it compares against moved behind an interface so tests can fix the time.

## First batch: walkthrough overview and the first complete group

```json
{
  "revision": 0,
  "snapshotId": "snapshot-id-from-status",
  "idempotencyKey": "prepare-1",
  "ops": [
    {
      "type": "walkthrough.update",
      "overview": "Before this change, `authenticate` looked up the account for any credential and never compared its expiry, so an expired token still logged in. Now an expiry check runs first and fails closed; everything after it is unchanged.\n\nRead it in two steps:\n\n1. **Reject expired credentials**: the new guard and the test that pins its boundary.\n2. **Read time from an injected clock**: a refactor that lets the test fix the time; behavior is unchanged."
    },
    {
      "type": "group.create",
      "id": "reject-expired",
      "title": "Reject expired credentials",
      "overview": "The guard sits at the top of [`authenticate`](gyst:new/src/auth.ts#L12-L24), before any database access, so an expired credential costs no lookup. The test then pins the boundary case.\n\nFor example, with the clock at 12:00, a token expiring at 11:59 or 12:00 is now refused with `expired`; one expiring at 12:01 still loads the account.",
      "memberHunkIds": ["hunk-id-auth-guard", "hunk-id-auth-test"]
    },
    {
      "type": "note.create",
      "id": "expiry-guard",
      "group": "reject-expired",
      "anchor": { "path": "src/auth.ts", "side": "new", "startLine": 14, "endLine": 16 },
      "markdown": "`<=` makes a credential expiring exactly now count as expired: the guard fails closed at the boundary."
    },
    {
      "type": "note.create",
      "id": "expiry-boundary-test",
      "group": "reject-expired",
      "anchor": { "path": "test/auth.test.ts", "side": "new", "startLine": 40, "endLine": 46 },
      "markdown": "Pins the boundary with the clock fixed at the expiry instant. Test inspected, not run."
    }
  ]
}
```

## Next batch: a refactor group with its invariant

````json
{
  "revision": 1,
  "snapshotId": "snapshot-id-from-status",
  "idempotencyKey": "prepare-2",
  "ops": [
    {
      "type": "group.create",
      "id": "injected-clock",
      "title": "Read time from an injected clock",
      "overview": "A refactor so the boundary test can fix the time. Invariant: production still reads the system clock, because [the service wiring](gyst:new/src/server.ts#L8-L10) passes `systemClock`, which returns `Date.now()` exactly as the removed inline call did.\n\n```mermaid\nflowchart LR\n  server[server.ts wiring] -->|systemClock| auth[authenticate]\n  test[auth.test.ts] -->|fixedClock| auth\n```",
      "memberHunkIds": ["hunk-id-clock", "hunk-id-server"]
    },
    {
      "type": "note.create",
      "id": "clock-removed-call",
      "group": "injected-clock",
      "anchor": { "path": "src/auth.ts", "side": "old", "startLine": 13, "endLine": 13 },
      "markdown": "The inline `Date.now()` moves behind `Clock`; nothing else in `authenticate` read the time."
    }
  ]
}
````

## Answering: a reply with a guidance improvement, and a reply alone

Two Questions from one pickup. The first would puzzle every reader, so the note improves and the reply stays short; the second concerns only this reader, so it gets a reply alone. Both go in one batch, under the `revision` the pickup returned.

```json
{
  "revision": 4,
  "snapshotId": "snapshot-id-from-the-bundle",
  "idempotencyKey": "respond-pickup-7-1",
  "ops": [
    {
      "type": "note.update",
      "id": "expiry-guard",
      "markdown": "`<=` makes a credential expiring exactly now count as expired: the guard fails closed at the boundary. It compares against this machine's clock, so skew still moves the cutoff: a fast clock rejects a token early, a slow one accepts it late."
    },
    {
      "type": "thread.reply",
      "thread": "thread-id-on-the-guard",
      "markdown": "`<=` only settles the boundary instant; it does not correct skew, which can reject a token early or accept it late. I added that to the note so the next reader sees it too."
    },
    {
      "type": "thread.reply",
      "thread": "thread-id-on-the-test",
      "markdown": "No: the test fixes the clock with `fixedClock`, so it never depends on the machine's time. See [the setup](gyst:new/test/auth.test.ts#L30-L34)."
    }
  ]
}
```

## Repairing after a Change request was fixed and refreshed

The human marked a message Change request: rename `expired` to `credential_expired`. In an uncommitted-changes session the fix is in the recorded scope, so it was made, refreshed, and the guidance repaired on the new snapshot. The renamed line changed the guard's hunk, so it came back ungrouped, and the note on it, the group overview and the walkthrough overview are Outdated; the test's hunk was unchanged and kept its place. The group overview quotes the old name, so it is rewritten; the note and the walkthrough overview never mention it, so after rechecking them they keep their wording.

```json
{
  "revision": 9,
  "snapshotId": "snapshot-id-from-the-refresh",
  "idempotencyKey": "respond-pickup-8-repair",
  "ops": [
    {
      "type": "group.update",
      "id": "reject-expired",
      "memberHunkIds": ["hunk-id-auth-guard-after-refresh", "hunk-id-auth-test"],
      "overview": "The guard sits at the top of [`authenticate`](gyst:new/src/auth.ts#L12-L24), before any database access, so an expired credential costs no lookup. The test then pins the boundary case.\n\nFor example, with the clock at 12:00, a token expiring at 11:59 or 12:00 is now refused with `credential_expired`; one expiring at 12:01 still loads the account."
    },
    {
      "type": "note.update",
      "id": "expiry-guard",
      "anchor": { "path": "src/auth.ts", "side": "new", "startLine": 14, "endLine": 16 }
    },
    { "type": "note.revalidate", "id": "expiry-guard" },
    { "type": "walkthrough.revalidate" },
    {
      "type": "thread.reply",
      "thread": "thread-id-on-the-error-name",
      "markdown": "Renamed to `credential_expired` in [the guard](gyst:new/src/auth.ts#L14-L16) and its test, and refreshed the session. Ran `pnpm test test/auth.test.ts`: passes."
    }
  ]
}
```

## Reporting a fix outside the recorded scope

The same Change request on a GitHub PR session. The PR's range is what was pushed, so a working-tree edit is not part of it; the edit stays local and uncommitted, nothing is pushed or refreshed, and the reply says so.

```json
{
  "revision": 5,
  "snapshotId": "snapshot-id-from-the-bundle",
  "idempotencyKey": "respond-pickup-9-1",
  "ops": [
    {
      "type": "thread.reply",
      "thread": "thread-id-on-the-error-name",
      "markdown": "I renamed it to `credential_expired` in `src/auth.ts` and `test/auth.test.ts` in the local checkout only. That edit is not part of this PR until it is committed and pushed, so this session still shows the old name; I did not commit, push or refresh."
    }
  ]
}
```
