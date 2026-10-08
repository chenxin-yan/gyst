// The gyst and gyst-respond workflows driven step by step through the installed CLI, as their
// SKILL.md files instruct an agent, with the human acting through the daemon's viewer. These check
// the operations each step relies on, not the prose an agent would write.
import { changedLinesOf } from "@gyst/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { privateRefs, refState, stackedRepository } from "../github.ts";
import {
  failed,
  git,
  json,
  launchViewer,
  repo,
  type Sandbox,
  sandbox,
  succeeded,
} from "./installed-gyst.ts";

type Hunk = { id: string; file: string; patch: string };

const write = async (cwd: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
};

/**
 * A checkout whose uncommitted changes add an expiry guard to `src/auth.ts` and inject the clock in
 * `src/clock.ts`: one hunk each.
 */
async function authChange(box: Sandbox) {
  const cwd = await repo(box, "auth");
  await write(cwd, {
    "src/auth.ts": "export function authenticate(token, clock) {\n  return lookup(token);\n}\n",
    "src/clock.ts": "export const now = () => Date.now();\n",
  });
  git(box, cwd, "add", ".");
  git(box, cwd, "commit", "-qm", "auth");
  await write(cwd, {
    "src/auth.ts":
      'export function authenticate(token, clock) {\n  if (token.expiresAt <= clock.now()) return { error: "expired" };\n  return lookup(token);\n}\n',
    "src/clock.ts": "export const systemClock = { now: () => Date.now() };\n",
  });
  return cwd;
}

/** The agent's commands for one exact session, as the workflows name them. */
function agentOf(box: Sandbox, cwd: string, id: string) {
  const session = (args: string[], stdin?: string) =>
    box.gyst(cwd, ["session", ...args, "--session", id], stdin);
  const hunks = async (): Promise<Hunk[]> => json(await session(["diff"])).hunks;
  return {
    session,
    status: async () => json(await session(["status"])),
    hunks,
    hunkOf: async (file: string) => (await hunks()).find((hunk) => hunk.file === file)!,
    threads: (mode: "pending" | "open", requestId: string) =>
      session(["threads", `--${mode}`, "--request-id", requestId]),
    apply: (batch: object) => session(["apply"], JSON.stringify(batch)),
    refresh: (snapshotId: string, requestId: string) =>
      session(["refresh", "--snapshot", snapshotId, "--request-id", requestId]),
  };
}

/** The human's side: browser operations on the link one-shot `gyst` printed for `args`. */
async function humanOf(box: Sandbox, cwd: string, args: string[]) {
  const viewer = await launchViewer(args, { cwd, env: box.env });
  let requests = 0;
  const act = async (operation: object): Promise<any> => {
    const reply = await viewer.operation({ session: viewer.id, ...operation });
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.value;
  };
  const say = async (
    target: object,
    markdown: string,
    kind: "question" | "change",
    wording?: string,
  ) => {
    const id = `human-${++requests}`;
    const { draft } = await act({ command: "draft", requestId: `${id}-draft`, target, wording });
    return act({ command: "send", requestId: id, draft, markdown, kind });
  };
  return {
    id: viewer.id,
    comment: (anchor: object, markdown: string, kind: "question" | "change" = "question") =>
      say({ kind: "comment", anchor }, markdown, kind),
    /** A reply to a note, written against the note text `wording` the human read. */
    replyToNote: (note: string, wording: string, markdown: string) =>
      say({ kind: "note", note }, markdown, "question", wording),
    viewAll: async (snapshotId: string, revision: number, hunkIds: string[]) =>
      act({
        command: "viewed",
        requestId: `human-${++requests}`,
        snapshotId,
        revision,
        hunkIds,
        viewed: true,
      }),
  };
}

const newLines = (hunk: Hunk) => {
  const lines = changedLinesOf(hunk).new;
  return { startLine: lines[0]!, endLine: lines.at(-1)! };
};

/** Publishes the authChange walkthrough completely in one batch. */
async function prepare(agent: ReturnType<typeof agentOf>) {
  const status = await agent.status();
  const auth = await agent.hunkOf("src/auth.ts");
  const clock = await agent.hunkOf("src/clock.ts");
  return json(
    await agent.apply({
      revision: status.revision,
      snapshotId: status.session.snapshotId,
      idempotencyKey: "prepare",
      ops: [
        { type: "walkthrough.update", overview: "Expired credentials are now refused." },
        {
          type: "group.create",
          id: "reject-expired",
          title: "Reject expired credentials",
          overview: "The guard runs before the lookup.",
          memberHunkIds: [auth.id],
        },
        {
          type: "note.create",
          id: "expiry-guard",
          group: "reject-expired",
          anchor: { path: "src/auth.ts", side: "new", ...newLines(auth) },
          markdown: "`<=` fails closed at the boundary.",
        },
        {
          type: "group.create",
          id: "injected-clock",
          title: "Read time from an injected clock",
          overview: "Production still reads `Date.now()`.",
          memberHunkIds: [clock.id],
        },
      ],
    }),
  );
}

describe("review workflows through the installed CLI", () => {
  it("gyst opens headlessly, publishes complete groups progressively, relays the link, and refreshes only when asked", async () => {
    const box = await sandbox();
    const cwd = await authChange(box);

    // 1. Open headlessly and keep the returned identity.
    const opened = json(await box.gyst(cwd, ["session", "open"]));
    expect(opened).toMatchObject({ created: true, session: { scope: { kind: "uncommitted" } } });
    const { id, snapshotId } = opened.session;
    expect(opened.link).toBe(
      `http://localhost:${box.env.GYST_PORT}/session/${encodeURIComponent(id)}`,
    );
    const agent = agentOf(box, cwd, id);
    const plain = await agent.status();
    expect(plain.preparation).toMatchObject({ state: "plain", groupedHunks: 0, totalHunks: 2 });

    // 2–5. The first batch publishes the walkthrough overview and one complete group.
    const auth = await agent.hunkOf("src/auth.ts");
    const first = json(
      await agent.apply({
        revision: plain.revision,
        snapshotId,
        idempotencyKey: "prepare-1",
        ops: [
          { type: "walkthrough.update", overview: "Expired credentials are now refused." },
          {
            type: "group.create",
            id: "reject-expired",
            title: "Reject expired credentials",
            overview: "The guard runs before [the lookup](gyst:new/src/auth.ts#L3).",
            memberHunkIds: [auth.id],
          },
          {
            type: "note.create",
            id: "expiry-guard",
            group: "reject-expired",
            anchor: { path: "src/auth.ts", side: "new", ...newLines(auth) },
            markdown: "`<=` fails closed at the boundary.",
          },
        ],
      }),
    );
    expect(first.preparation).toMatchObject({ state: "incomplete", groupedHunks: 1 });

    // The link to relay is the one `session open` returned; reopening returns it unchanged.
    const reopened = { created: false, link: opened.link, session: { id, snapshotId } };
    expect(json(await agent.session(["open"]))).toMatchObject(reopened);

    // Reopening the scope after the checkout moved on neither refreshes nor rewrites guidance.
    await write(cwd, {
      "src/auth.ts":
        'export function authenticate(token, clock) {\n  if (token.expiresAt <= clock.now()) return { error: "credential_expired" };\n  return lookup(token);\n}\n',
    });
    expect(json(await box.gyst(cwd, ["session", "open"]))).toMatchObject(reopened);
    expect(await agent.status()).toEqual(first);

    // The next complete group; a lost reply is resent with the same key and applies once.
    const clock = await agent.hunkOf("src/clock.ts");
    const second = {
      revision: first.revision,
      snapshotId,
      idempotencyKey: "prepare-2",
      ops: [
        {
          type: "group.create",
          id: "injected-clock",
          title: "Read time from an injected clock",
          overview: "Production still reads `Date.now()`.",
          memberHunkIds: [clock.id],
        },
      ],
    };
    const published = await agent.apply(second);
    expect((await agent.apply(second)).stdout).toBe(published.stdout);
    expect(json(published).preparation).toMatchObject({ state: "complete", totalHunks: 2 });
    expect((await agent.status()).groups.map(({ id }: { id: string }) => id)).toEqual([
      "reject-expired",
      "injected-clock",
    ]);

    // 6. Asked to refresh: the same request id replays, an old snapshot is stale, then repair.
    const refreshed = await agent.refresh(snapshotId, "refresh-1");
    expect(json(refreshed)).toMatchObject({ previousSnapshotId: snapshotId, replaced: true });
    expect((await agent.refresh(snapshotId, "refresh-1")).stdout).toBe(refreshed.stdout);
    expect(failed(await agent.refresh(snapshotId, "refresh-2")).code).toBe("stale_revision");
    const after = await agent.status();
    expect(after.preparation).toMatchObject({
      state: "incomplete",
      groupedHunks: 1,
      notesOutdated: ["expiry-guard"],
    });
    const renamed = await agent.hunkOf("src/auth.ts");
    const repaired = json(
      await agent.apply({
        revision: after.revision,
        snapshotId: after.session.snapshotId,
        idempotencyKey: "repair-1",
        ops: [
          { type: "group.update", id: "reject-expired", memberHunkIds: [renamed.id] },
          {
            type: "note.update",
            id: "expiry-guard",
            anchor: { path: "src/auth.ts", side: "new", ...newLines(renamed) },
          },
          { type: "note.revalidate", id: "expiry-guard" },
          ...after.preparation.groupsOutdated.map((group: string) => ({
            type: "group.revalidate",
            id: group,
          })),
          ...(after.preparation.overviewOutdated ? [{ type: "walkthrough.revalidate" }] : []),
        ],
      }),
    );
    expect(repaired.preparation).toMatchObject({ state: "complete", groupedHunks: 2 });
  }, 60_000);

  it("gyst-respond answers one bounded bundle, recovers lost replies and read work, and stops on an empty bundle", async () => {
    const box = await sandbox();
    const cwd = await authChange(box);
    const human = await humanOf(box, cwd, []);
    const agent = agentOf(box, cwd, human.id);
    const prepared = await prepare(agent);
    const snapshotId = prepared.session.snapshotId;
    const clock = await agent.hunkOf("src/clock.ts");
    const asked = await human.comment(
      { snapshotId, path: "src/clock.ts", side: "new", startLine: 1, endLine: 1 },
      "Why an object rather than a function?",
    );
    const onNote = await human.replyToNote(
      "expiry-guard",
      "`<=` fails closed at the boundary.",
      "What about clock skew?",
    );

    // 1. One pickup under a request id chosen first; a lost reply is retried with that id.
    const pickup = await agent.threads("pending", "respond-1");
    const bundle = json(pickup);
    expect(bundle.threads.map(({ id, unread }: any) => [id, unread])).toEqual([
      [asked.thread, [asked.message]],
      [onNote.thread, [onNote.message]],
    ]);
    expect(bundle.threads[1].messages[0]).toMatchObject({
      kind: "question",
      wording: { markdown: "`<=` fails closed at the boundary." },
    });
    // A message sent after the pickup is not in it, even on retry, and stays Pending.
    const later = await human.comment(
      { snapshotId, path: "src/auth.ts", side: "new", startLine: 2, endLine: 2 },
      "Is `expired` the final name?",
    );
    expect((await agent.threads("pending", "respond-1")).stdout).toBe(pickup.stdout);
    expect((await agent.status()).threads).toEqual({ open: 3, resolved: 0, pending: 1 });

    // 5. One answer improves reusable guidance with its reply. The human acted since the pickup,
    // so its revision is stale: reread status and send the rebuilt batch under a new key.
    const answer = (revision: number, idempotencyKey: string) => ({
      revision,
      snapshotId,
      idempotencyKey,
      ops: [
        {
          type: "group.update",
          id: "injected-clock",
          overview: "Production still reads `Date.now()`; an object lets tests pass a fixed clock.",
        },
        {
          type: "thread.reply",
          thread: asked.thread,
          markdown: "So tests can pass a fixed clock; the group overview now says so.",
        },
      ],
    });
    expect(failed(await agent.apply(answer(bundle.revision, "respond-1-a"))).code).toBe(
      "stale_revision",
    );
    const current = await agent.status();
    const answered = await agent.apply(answer(current.revision, "respond-1-b"));
    expect((await agent.apply(answer(current.revision, "respond-1-b"))).stdout).toBe(
      answered.stdout,
    );
    expect(json(answered).groups[1].overview.markdown).toContain("fixed clock");

    // The run is cut off before answering the note reply: --open recovers the read work.
    const recovered = json(await agent.threads("open", "recover-1"));
    // The resent batch posted its reply once.
    expect(
      recovered.threads
        .find(({ id }: { id: string }) => id === asked.thread)
        .messages.filter(({ author }: { author: string }) => author === "agent"),
    ).toHaveLength(1);
    const unanswered = recovered.threads.filter(
      ({ messages }: { messages: { author: string }[] }) => messages.at(-1)!.author === "human",
    );
    expect(unanswered.map(({ id }: { id: string }) => id)).toEqual([onNote.thread, later.thread]);
    // Recovery reads, and so freezes, the later message it returns.
    expect(recovered.threads.find(({ id }: { id: string }) => id === later.thread).unread).toEqual([
      later.message,
    ]);
    json(
      await agent.apply({
        revision: recovered.revision,
        snapshotId,
        idempotencyKey: "recover-1-a",
        ops: [
          { type: "thread.reply", thread: onNote.thread, markdown: "Skew fails closed too." },
          { type: "thread.reply", thread: later.thread, markdown: "Yes." },
        ],
      }),
    );

    // 2. Empty bundles report from progress and stop: still reading, then finished.
    const reading = json(await agent.threads("pending", "respond-2"));
    expect(reading).toMatchObject({ threads: [], progress: { viewed: 0, total: 2 } });
    const status = await agent.status();
    await human.viewAll(snapshotId, status.revision, [clock.id, status.groups[0].hunkIds[0]]);
    const finished = json(await agent.threads("pending", "respond-3"));
    expect(finished).toMatchObject({
      threads: [],
      progress: { viewed: 2, total: 2 },
      openThreads: 3,
    });
  }, 60_000);

  it("gyst-respond tells a Change request from a Question, fixes the request inside an uncommitted scope, refreshes and repairs guidance", async () => {
    const box = await sandbox();
    const cwd = await authChange(box);
    const human = await humanOf(box, cwd, []);
    const agent = agentOf(box, cwd, human.id);
    const prepared = await prepare(agent);
    const snapshotId = prepared.session.snapshotId;
    const anchor = { snapshotId, path: "src/auth.ts", side: "new", startLine: 2, endLine: 2 };
    const change = await human.comment(
      anchor,
      "Rename `expired` to `credential_expired`.",
      "change",
    );
    const question = await human.comment(anchor, "Could this be `<`?");

    const bundle = json(await agent.threads("pending", "respond-1"));
    expect(
      bundle.threads.map(({ id, messages }: any) => [id, messages.map(({ kind }: any) => kind)]),
    ).toEqual([
      [change.thread, ["change"]],
      [question.thread, ["question"]],
    ]);
    expect(prepared.session.scope).toEqual({ kind: "uncommitted" });

    // The Change request's fix is a working-tree edit, which the recorded scope includes.
    await write(cwd, {
      "src/auth.ts":
        'export function authenticate(token, clock) {\n  if (token.expiresAt <= clock.now()) return { error: "credential_expired" };\n  return lookup(token);\n}\n',
    });
    expect(json(await agent.session(["check"])).state).toBe("changed");
    const refreshed = json(await agent.refresh(bundle.snapshotId, "respond-1-refresh"));
    expect(refreshed).toMatchObject({ previousSnapshotId: snapshotId, replaced: true });

    const after = await agent.status();
    const renamed = await agent.hunkOf("src/auth.ts");
    const repaired = json(
      await agent.apply({
        revision: after.revision,
        snapshotId: refreshed.snapshotId,
        idempotencyKey: "respond-1-repair",
        ops: [
          { type: "group.update", id: "reject-expired", memberHunkIds: [renamed.id] },
          {
            type: "note.update",
            id: "expiry-guard",
            anchor: { path: "src/auth.ts", side: "new", ...newLines(renamed) },
          },
          { type: "note.revalidate", id: "expiry-guard" },
          ...after.preparation.groupsOutdated.map((group: string) => ({
            type: "group.revalidate",
            id: group,
          })),
          ...(after.preparation.overviewOutdated ? [{ type: "walkthrough.revalidate" }] : []),
          {
            type: "thread.reply",
            thread: change.thread,
            markdown: "Renamed in [the guard](gyst:new/src/auth.ts#L2) and refreshed.",
          },
          {
            type: "thread.reply",
            thread: question.thread,
            markdown: "`<` would accept a credential at its expiry instant.",
          },
        ],
      }),
    );
    expect(repaired.preparation).toMatchObject({ state: "complete" });
    expect(repaired.threads).toEqual({ open: 2, resolved: 0, pending: 0 });
  }, 60_000);

  it("gyst-respond keeps a requested fix outside a PR's range local, with whole-stack context and only the selected layer prepared", async () => {
    const box = await sandbox();
    const stack = await stackedRepository(box);
    const { checkout, fake } = stack;
    const url = (number: number) => `https://github.com/acme/widgets/pull/${number}`;

    // gyst: open layer B; status carries the whole stack, and only B has a session.
    const opened = json(await box.gyst(checkout, ["session", "open", "--pr", url(2)]));
    const agent = agentOf(box, checkout, opened.session.id);
    const status = await agent.status();
    expect(status.session.scope).toMatchObject({ kind: "pr", number: 2 });
    expect(status.pullRequest).toMatchObject({
      selected: 2,
      unavailable: null,
      stack: {
        verifiedAt: expect.any(String),
        membership: "stacked",
        layers: [stack.a, stack.b, stack.c].map(({ number, title, body }, index) => ({
          position: index + 1,
          pullRequest: { number, title, description: body },
        })),
      },
      sessions: [{ number: 2, sessionId: opened.session.id }],
    });
    // A claim about layer A is checked in B's own snapshot, where A's file is inherited source.
    expect(
      json(
        await agent.session([
          "code",
          "--snapshot",
          opened.session.snapshotId,
          "--file",
          "a.txt",
          "--side",
          "new",
        ]),
      ).content,
    ).toMatchObject({ kind: "text", text: "layer a\n" });
    const [hunk] = await agent.hunks();
    json(
      await agent.apply({
        revision: status.revision,
        snapshotId: opened.session.snapshotId,
        idempotencyKey: "prepare-b",
        ops: [
          { type: "walkthrough.update", overview: "Adds layer B on top of layer A." },
          {
            type: "group.create",
            id: "layer-b",
            title: "Add layer B",
            overview: "One new file; [layer A's](gyst:new/a.txt#L1) is unchanged.",
            memberHunkIds: [hunk!.id],
          },
        ],
      }),
    );
    expect(json(await box.gyst(checkout, ["session", "list"])).sessions).toHaveLength(1);

    // gyst-respond: a Change request on B, fixed in the checkout of B's branch.
    const human = await humanOf(box, checkout, ["--session", opened.session.id]);
    const change = await human.comment(
      {
        snapshotId: opened.session.snapshotId,
        path: "b.txt",
        side: "new",
        startLine: 1,
        endLine: 1,
      },
      "Say what layer B is for.",
      "change",
    );
    git(box, checkout, "fetch", "-q", "origin", "layer-b:layer-b");
    git(box, checkout, "switch", "-q", "layer-b");
    const before = refState(checkout);
    const refs = privateRefs(checkout);
    const ghCalls = (await fake.calls()).length;

    const bundle = json(await agent.threads("pending", "respond-1"));
    expect(bundle.threads[0].messages[0]).toMatchObject({ id: change.message, kind: "change" });
    await write(checkout, { "b.txt": "layer b: the second layer\n" });
    // A PR scope is what was pushed: the edit is reported, not committed, pushed or refreshed.
    const replied = json(
      await agent.apply({
        revision: bundle.revision,
        snapshotId: bundle.snapshotId,
        idempotencyKey: "respond-1-a",
        ops: [
          {
            type: "thread.reply",
            thread: change.thread,
            markdown:
              "Edited `b.txt` in the local checkout only; it is not part of this PR until committed and pushed.",
          },
        ],
      }),
    );
    expect(replied.session.snapshotId).toBe(opened.session.snapshotId);
    expect(replied.preparation.state).toBe("complete");
    const after = refState(checkout);
    expect({ ...after, status: before.status }).toEqual(before);
    expect(after.status).toContain("b.txt");
    expect(privateRefs(checkout)).toEqual(refs);
    expect(await fake.calls()).toHaveLength(ghCalls);
    succeeded(await box.gyst(checkout, ["session", "status", "--session", opened.session.id]));
  }, 60_000);
});
