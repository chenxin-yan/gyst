import { describe, expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import type { CapturedIndex } from "./apply.ts";
import { applyBatch } from "./apply.ts";
import {
  anchorKey,
  type ConversationRequest,
  converse,
  pickUp,
  type ThreadsRequest,
} from "./conversation.ts";
import type { CapturedRange } from "./guidance.ts";
import { setViewed } from "./human-action.ts";
import { type Session, SessionSchema } from "./session.ts";
import { statusOf } from "./status.ts";
import type { Thread, ThreadCode } from "./thread.ts";

const LATER = "2026-02-02T00:00:00.000Z";
const SNAPSHOT = "snapshot";

const range = (startLine: number, endLine = startLine, snapshotId = SNAPSHOT): CapturedRange => ({
  snapshotId,
  path: "a.ts",
  side: "new",
  startLine,
  endLine,
});

const base: Session = {
  id: "session",
  repoRoot: "/repo",
  scope: { kind: "uncommitted" },
  snapshotId: SNAPSHOT,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  hunks: [
    {
      id: "a1",
      file: "a.ts",
      header: "@@ -1,3 +1,3 @@",
      patch: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c",
      contentHash: "a1",
    },
  ],
  overview: null,
  groups: [
    {
      id: "g1",
      title: "first",
      overview: { markdown: "First group.", references: [] },
      hunkIds: ["a1"],
      files: ["a.ts"],
      notes: [{ id: "n1", anchor: range(2), markdown: "About B.", references: [] }],
    },
  ],
  viewedHunkIds: ["a1"],
  receiptTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
  refreshReceipts: [],
  threads: [],
  drafts: [],
  conversationReceipts: [],
  pickupReceipts: [],
};

const captured: CapturedIndex[] = [
  { snapshotId: SNAPSHOT, sides: new Map([["new\0a.ts", { kind: "text", lines: 20 }]]) },
];

type Act = ConversationRequest extends infer Request
  ? Request extends ConversationRequest
    ? Omit<Request, "session" | "requestId">
    : never
  : never;

const act = (session: Session, requestId: string, request: Act) =>
  converse(session, { session: session.id, requestId, ...request }, captured, LATER);
const done = (session: Session, requestId: string, request: Act) =>
  Result.getOrThrow(act(session, requestId, request));
const refused = (session: Session, requestId: string, request: Act) =>
  Result.getOrThrow(Result.flip(act(session, requestId, request)));

/** Drafts and sends one message, returning the session and what the send made. */
function post(
  session: Session,
  target: Extract<Act, { command: "draft" }>["target"],
  markdown: string,
  extra: { wording?: string; kind?: "question" | "change"; id?: string } = {},
) {
  const id = extra.id ?? markdown;
  const drafted = done(session, `draft-${id}`, {
    command: "draft",
    target,
    ...(extra.wording && { wording: extra.wording }),
  });
  const sent = done(drafted.session!, `send-${id}`, {
    command: "send",
    draft: drafted.result.draft!,
    markdown,
    kind: extra.kind ?? "question",
  });
  return { session: sent.session!, thread: sent.result.thread!, message: sent.result.message! };
}

const code = (session: Session): ReadonlyMap<string, ThreadCode> =>
  new Map(session.threads.map(({ anchor }) => [anchorKey(anchor), { kind: "text", lines: ["B"] }]));
const threadsRequest = (mode: ThreadsRequest["mode"], requestId: string): ThreadsRequest => ({
  command: "threads",
  session: "session",
  mode,
  requestId,
});
const pick = (session: Session, mode: ThreadsRequest["mode"], requestId: string) =>
  Result.getOrThrow(pickUp(session, threadsRequest(mode, requestId), code(session), LATER));

describe("human conversation actions", () => {
  it("comments on any captured range through a pinned draft, Pending until read", () => {
    const drafted = done(base, "r1", {
      command: "draft",
      target: { kind: "comment", anchor: range(4, 6) },
    });
    // The pin alone is no review change: no revision, no Viewed.
    expect(drafted.session).toMatchObject({ revision: 3, drafts: [{ anchor: range(4, 6) }] });
    const sent = done(drafted.session!, "r2", {
      command: "send",
      draft: drafted.result.draft!,
      markdown: "Why *this*?",
      kind: "change",
    });
    expect(sent.result).toEqual({
      sessionId: "session",
      revision: 4,
      thread: sent.result.thread,
      message: sent.result.message,
    });
    expect(sent.session).toMatchObject({ drafts: [], viewedHunkIds: ["a1"] });
    expect(sent.session!.threads).toEqual([
      {
        id: sent.result.thread,
        anchor: range(4, 6),
        resolved: false,
        messages: [
          {
            id: sent.result.message,
            author: "human",
            kind: "change",
            pending: true,
            markdown: "Why *this*?",
            references: [],
            createdAt: LATER,
          },
        ],
      },
    ]);
    // Several threads may share one range.
    const again = post(sent.session!, { kind: "comment", anchor: range(4, 6) }, "And this?");
    expect(again.session.threads.map(({ anchor }) => anchor)).toEqual([range(4, 6), range(4, 6)]);
    expect(Schema.decodeUnknownSync(SessionSchema)(again.session)).toEqual(again.session);
  });

  it("refuses comments outside captured text or retained snapshots", () => {
    expect(
      refused(base, "r1", { command: "draft", target: { kind: "comment", anchor: range(19, 21) } }),
    ).toMatchObject({ _tag: "validation_failed" });
    expect(
      refused(base, "r1", {
        command: "draft",
        target: { kind: "comment", anchor: range(1, 1, "reclaimed") },
      }),
    ).toMatchObject({ _tag: "stale_revision" });
  });

  it("replays a request id's recorded result and refuses it for another payload", () => {
    const first = done(base, "r1", {
      command: "draft",
      target: { kind: "comment", anchor: range(4) },
    });
    const later = post(first.session!, { kind: "comment", anchor: range(5) }, "Later.").session;
    expect(
      act(later, "r1", { command: "draft", target: { kind: "comment", anchor: range(4) } }),
    ).toEqual(Result.succeed({ result: first.result }));
    expect(
      refused(later, "r1", { command: "draft", target: { kind: "comment", anchor: range(5) } }),
    ).toMatchObject({
      _tag: "validation_failed",
      message: "request id reused with a different payload",
    });
  });

  it("starts a note's only thread with its first reply, each reply keeping the wording it saw", () => {
    const stale = refused(base, "r1", {
      command: "draft",
      target: { kind: "note", note: "n1" },
      wording: "An older wording.",
    });
    expect(stale._tag).toBe("stale_revision");
    const first = post(base, { kind: "note", note: "n1" }, "Why B?", { wording: "About B." });
    expect(first.session.threads[0]).toMatchObject({
      anchor: range(2),
      note: { id: "n1", removed: false },
      messages: [{ wording: { markdown: "About B.", references: [], anchor: range(2) } }],
    });
    // The agent rewrites the note twice; each later reply, in the same thread, keeps the wording
    // it was composed against, and a draft begun before a rewrite keeps the older one.
    const rewrite = (session: Session, markdown: string) =>
      Result.getOrThrow(
        applyBatch(
          session,
          {
            revision: session.revision,
            snapshotId: SNAPSHOT,
            idempotencyKey: markdown,
            ops: [{ type: "note.update", id: "n1", markdown }],
          },
          captured[0]!,
          LATER,
        ),
      ).session!;
    const rewritten = rewrite(first.session, "B, explained better.");
    const second = post(rewritten, { kind: "note", note: "n1" }, "Thanks, and C?", {
      wording: "B, explained better.",
    });
    const begun = done(second.session, "d3", {
      command: "draft",
      target: { kind: "note", note: "n1" },
      wording: "B, explained better.",
    });
    const again = rewrite(begun.session!, "B, explained a third way.");
    const third = done(again, "s3", {
      command: "send",
      draft: begun.result.draft!,
      markdown: "Which is it?",
      kind: "question",
    }).session!;
    expect(third.threads).toHaveLength(1);
    expect(
      third.threads[0]!.messages.map(
        (message) => "wording" in message && message.wording?.markdown,
      ),
    ).toEqual(["About B.", "B, explained better.", "B, explained better."]);
    // Every wording keeps its references' snapshots pinned.
    expect(Schema.decodeUnknownSync(SessionSchema)(third)).toEqual(third);
  });

  it("lets only Pending human messages change, never once read or an agent's", () => {
    const { session, message } = post(base, { kind: "comment", anchor: range(4) }, "Typo");
    const edited = done(session, "e1", {
      command: "edit",
      message,
      seen: { markdown: "Typo", kind: "question" },
      markdown: "Is this a typo?",
      kind: "change",
    }).session!;
    expect(edited.threads[0]!.messages[0]).toMatchObject({
      markdown: "Is this a typo?",
      kind: "change",
      pending: true,
    });
    const read = pick(edited, "pending", "p1").session!;
    const seen = { markdown: "Is this a typo?", kind: "change" } as const;
    for (const request of [
      { command: "edit", message, seen, kind: "question" },
      { command: "retract", message, seen },
    ] as const)
      expect(refused(read, "late", request)).toMatchObject({
        _tag: "validation_failed",
        message: `message ${message} was already read; send a correction as a new reply`,
      });
    // The correction is a new reply in the same thread.
    const corrected = post(
      read,
      { kind: "thread", thread: read.threads[0]!.id },
      "I meant line 5.",
    );
    expect(corrected.session.threads[0]!.messages).toHaveLength(2);
  });

  it("deletes a Pending message without cascading; an emptied thread goes, its note stays", () => {
    const first = post(base, { kind: "note", note: "n1" }, "One?", { wording: "About B." });
    const second = post(first.session, { kind: "note", note: "n1" }, "Two?", {
      wording: "About B.",
    });
    const once = done(second.session, "x1", {
      command: "retract",
      message: first.message,
      seen: { markdown: "One?", kind: "question" },
    }).session!;
    expect(once.threads[0]!.messages.map(({ markdown }) => markdown)).toEqual(["Two?"]);
    const empty = done(once, "x2", {
      command: "retract",
      message: second.message,
      seen: { markdown: "Two?", kind: "question" },
    }).session!;
    expect(empty.threads).toEqual([]);
    expect(empty.groups[0]!.notes.map(({ id }) => id)).toEqual(["n1"]);
  });

  it("asks for reopening before a human reply to a resolved thread", () => {
    const { session, thread } = post(base, { kind: "comment", anchor: range(4) }, "Why?");
    const resolved = done(session, "s1", { command: "resolve", thread, resolved: true }).session!;
    expect(statusOf(resolved).threads).toEqual({ open: 0, resolved: 1, pending: 1 });
    expect(
      refused(resolved, "d1", { command: "draft", target: { kind: "thread", thread } }),
    ).toMatchObject({ _tag: "validation_failed" });
    // A draft opened before the resolution cannot be sent into it either.
    const drafted = done(session, "d2", { command: "draft", target: { kind: "thread", thread } });
    const late = done(drafted.session!, "s2", { command: "resolve", thread, resolved: true });
    expect(
      refused(late.session!, "send", {
        command: "send",
        draft: drafted.result.draft!,
        markdown: "More?",
        kind: "question",
      }),
    ).toMatchObject({ _tag: "validation_failed" });
    const reopened = done(resolved, "s3", { command: "resolve", thread, resolved: false }).session!;
    expect(
      post(reopened, { kind: "thread", thread }, "More?").session.threads[0]!.messages,
    ).toHaveLength(2);
    // Read, reply and resolution never touch Viewed.
    expect(reopened.viewedHunkIds).toEqual(["a1"]);
  });

  it("pins a message's references to the current snapshot, within captured text", () => {
    const { session } = post(
      base,
      { kind: "comment", anchor: range(4) },
      "See [here](gyst:new/a.ts#L7).",
    );
    expect(session.threads[0]!.messages[0]!.references).toEqual([range(7)]);
    const drafted = done(base, "d", {
      command: "draft",
      target: { kind: "comment", anchor: range(4) },
    });
    for (const markdown of ["See [far](gyst:new/a.ts#L30).", "![image](https://example.com/a.png)"])
      expect(
        refused(drafted.session!, "s", {
          command: "send",
          draft: drafted.result.draft!,
          markdown,
          kind: "question",
        })._tag,
      ).toBe("validation_failed");
  });

  it("keeps the code a note reply was composed against when the agent re-anchors the note", () => {
    const old: CapturedRange = { ...range(2), side: "old" };
    const sides: CapturedIndex = {
      snapshotId: SNAPSHOT,
      sides: new Map([
        ["new\0a.ts", { kind: "text", lines: 20 }],
        ["old\0a.ts", { kind: "text", lines: 20 }],
      ]),
    };
    const reanchor = (session: Session) =>
      Result.getOrThrow(
        applyBatch(
          session,
          {
            revision: session.revision,
            snapshotId: SNAPSHOT,
            idempotencyKey: "move",
            ops: [{ type: "note.update", id: "n1", anchor: old }],
          },
          sides,
          LATER,
        ),
      ).session!;
    const drafted = done(base, "d", {
      command: "draft",
      target: { kind: "note", note: "n1" },
      wording: "About B.",
    });
    const moved = reanchor(drafted.session!);
    // The draft sits with its note now, but keeps the code it was begun against.
    expect(moved.drafts[0]).toMatchObject({
      anchor: old,
      wording: { markdown: "About B.", anchor: range(2) },
    });
    const sent = done(moved, "s", {
      command: "send",
      draft: drafted.result.draft!,
      markdown: "Why B?",
      kind: "question",
    }).session!;
    expect(sent.threads[0]).toMatchObject({
      anchor: old,
      messages: [{ wording: { anchor: range(2) } }],
    });
    // The agent receives that earlier code beside the note's current code.
    const lines = new Map<string, ThreadCode>([
      [anchorKey(old), { kind: "text", lines: ["b"] }],
      [anchorKey(range(2)), { kind: "text", lines: ["B"] }],
    ]);
    const picked = Result.getOrThrow(
      pickUp(sent, threadsRequest("pending", "p"), lines, LATER),
    ).result;
    expect(picked.threads[0]).toMatchObject({
      code: { kind: "text", lines: ["b"] },
      earlierCode: [{ anchor: range(2), code: { kind: "text", lines: ["B"] } }],
    });
  });

  it("pins a draft's links where it was begun and keeps an edit's unchanged links on theirs", () => {
    const next: CapturedIndex = {
      snapshotId: "next",
      sides: new Map([["new\0a.ts", { kind: "text", lines: 20 }]]),
    };
    const both = [...captured, next];
    const at = (session: Session, requestId: string, request: Act) =>
      Result.getOrThrow(
        converse(session, { session: session.id, requestId, ...request }, both, LATER),
      );
    const posted = post(
      base,
      { kind: "comment", anchor: range(4) },
      "See [here](gyst:new/a.ts#L7).",
    );
    const drafted = done(posted.session, "d", {
      command: "draft",
      target: { kind: "comment", anchor: range(5) },
    });
    // A refresh made "next" current; the earlier snapshot stays pinned by the message and draft.
    const refreshed: Session = { ...drafted.session!, snapshotId: "next" };
    const sent = at(refreshed, "s", {
      command: "send",
      draft: drafted.result.draft!,
      markdown: "Like [this](gyst:new/a.ts#L9)?",
      kind: "question",
    }).session!;
    expect(sent.threads[1]!.messages[0]!.references).toEqual([range(9)]);
    const edited = at(sent, "e", {
      command: "edit",
      message: posted.message,
      seen: { markdown: "See [here](gyst:new/a.ts#L7).", kind: "question" },
      markdown: "See [here](gyst:new/a.ts#L7), and [there](gyst:new/a.ts#L8).",
    }).session!;
    expect(edited.threads[0]!.messages[0]!.references).toEqual([range(7), range(8, 8, "next")]);
  });

  it("refuses an edit or deletion of a message changed since its author read it", () => {
    const { session, message } = post(base, { kind: "comment", anchor: range(4) }, "Typo");
    const seen = { markdown: "Typo", kind: "question" } as const;
    // Another tab changed the kind first; this tab's edit was made against the older message.
    const elsewhere = done(session, "k", {
      command: "edit",
      message,
      seen,
      kind: "change",
    }).session!;
    for (const request of [
      { command: "edit", message, seen, markdown: "Is this a typo?" },
      { command: "retract", message, seen },
    ] as const)
      expect(refused(elsewhere, "stale", request)).toMatchObject({ _tag: "stale_revision" });
    expect(elsewhere.threads[0]!.messages[0]).toMatchObject({ markdown: "Typo", kind: "change" });
  });

  it("keeps a draft's context when its note is removed, sending into the retained place", () => {
    const drafted = done(base, "d", {
      command: "draft",
      target: { kind: "note", note: "n1" },
      wording: "About B.",
    });
    const removed = Result.getOrThrow(
      applyBatch(
        drafted.session!,
        {
          revision: 3,
          snapshotId: SNAPSHOT,
          idempotencyKey: "rm",
          ops: [{ type: "note.remove", id: "n1" }],
        },
        captured[0]!,
        LATER,
      ),
    ).session!;
    expect(removed.drafts).toEqual([
      { ...drafted.session!.drafts[0], note: { id: "n1", removed: true } },
    ]);
    const sent = done(removed, "s", {
      command: "send",
      draft: drafted.result.draft!,
      markdown: "Was this right?",
      kind: "question",
    }).session!;
    expect(sent.threads[0]).toMatchObject({
      anchor: range(2),
      note: { id: "n1", removed: true },
      messages: [{ wording: { markdown: "About B." } }],
    });
  });
});

describe("pickUp", () => {
  const two = () => {
    const a = post(base, { kind: "comment", anchor: range(4) }, "A?");
    const b = post(a.session, { kind: "comment", anchor: range(5) }, "B?", { kind: "change" });
    return b.session;
  };

  it("freezes exactly the Pending messages it returns and records the bundle", () => {
    const session = two();
    const picked = pick(session, "pending", "p1");
    expect(picked.result).toMatchObject({
      sessionId: "session",
      revision: session.revision + 1,
      progress: { viewed: 1, total: 1 },
      openThreads: 2,
    });
    expect(
      picked.result.threads.map(({ unread, code: lines, messages }) => ({
        unread,
        lines,
        messages,
      })),
    ).toEqual(
      session.threads.map(({ messages }) => ({
        unread: [messages[0]!.id],
        lines: { kind: "text", lines: ["B"] },
        messages: [{ ...messages[0], pending: false }],
      })),
    );
    // Kinds come back on human messages.
    expect(
      picked.result.threads.map(
        ({ messages }) => messages[0]!.author === "human" && messages[0]!.kind,
      ),
    ).toEqual(["question", "change"]);
    expect(statusOf(picked.session!).threads).toEqual({ open: 2, resolved: 0, pending: 0 });
    // Viewed is untouched; the next pickup has nothing.
    expect(picked.session!.viewedHunkIds).toEqual(["a1"]);
    const empty = pick(picked.session!, "pending", "p2");
    expect(empty.result).toMatchObject({
      threads: [],
      openThreads: 2,
      revision: picked.result.revision,
    });
  });

  it("returns the recorded bundle to a retry even after later arrivals, which wait", () => {
    const session = two();
    const picked = pick(session, "pending", "p1");
    const arrived = post(
      picked.session!,
      { kind: "thread", thread: session.threads[0]!.id },
      "And?",
    );
    const retried = pickUp(arrived.session, threadsRequest("pending", "p1"), new Map(), LATER);
    expect(retried).toEqual(Result.succeed({ result: picked.result }));
    // A lost acknowledgement left nothing unread behind: the later message waits for a new pickup.
    expect(statusOf(arrived.session).threads.pending).toBe(1);
    const next = pick(arrived.session, "pending", "p2");
    expect(next.result.threads.map(({ unread }) => unread)).toEqual([[arrived.message]]);
    expect(
      Result.getOrThrow(
        Result.flip(pickUp(arrived.session, threadsRequest("open", "p1"), new Map(), LATER)),
      ),
    ).toMatchObject({ _tag: "validation_failed" });
  });

  it("returns only what was Pending when it was asked for; arrivals meanwhile wait", () => {
    const invoked = two();
    const [first, second] = invoked.threads as [Thread, Thread];
    // While its code was read: a reply and a new thread arrived, and the second Pending message was deleted.
    const replied = post(invoked, { kind: "thread", thread: first.id }, "And?");
    const started = post(replied.session, { kind: "comment", anchor: range(6) }, "New?");
    const now = done(started.session, "x", {
      command: "retract",
      message: second.messages[0]!.id,
      seen: { markdown: "B?", kind: "change" },
    }).session!;
    const picked = Result.getOrThrow(
      pickUp(now, threadsRequest("pending", "p"), code(now), LATER, invoked),
    );
    expect(
      picked.result.threads.map(({ id, unread, messages }) => ({
        id,
        unread,
        messages: messages.map(({ id }) => id),
      })),
    ).toEqual([
      { id: first.id, unread: [first.messages[0]!.id], messages: [first.messages[0]!.id] },
    ]);
    expect(statusOf(picked.session!).threads.pending).toBe(2);
    expect(
      pick(picked.session!, "pending", "p2").result.threads.flatMap(({ unread }) => unread),
    ).toEqual([replied.message, started.message]);
  });

  it("skips resolved threads until reopened, and recovers open work after a crash", () => {
    const session = two();
    const [first, second] = session.threads.map(({ id }) => id) as [string, string];
    const resolved = done(session, "r", {
      command: "resolve",
      thread: second,
      resolved: true,
    }).session!;
    const picked = pick(resolved, "pending", "p1");
    expect(picked.result.threads.map(({ id }) => id)).toEqual([first]);
    // The agent crashed before answering: open recovery returns the read work again, freezing nothing new.
    const recovered = pick(picked.session!, "open", "o1");
    expect(recovered.result.threads.map(({ id, unread }) => ({ id, unread }))).toEqual([
      { id: first, unread: [] },
    ]);
    expect(recovered.result.revision).toBe(picked.result.revision);
    const reopened = done(recovered.session!, "o", {
      command: "resolve",
      thread: second,
      resolved: false,
    }).session!;
    const exposed = pick(reopened, "pending", "p2");
    expect(exposed.result.threads.map(({ id }) => id)).toEqual([second]);
  });

  it("freezes unread bodies returned by open recovery under the same rules", () => {
    const session = two();
    const recovered = pick(session, "open", "o1");
    expect(recovered.result.threads.flatMap(({ unread }) => unread)).toHaveLength(2);
    expect(statusOf(recovered.session!).threads.pending).toBe(0);
  });

  it("serializes against pending edits: a deleted message is never returned, an edited one returns as edited", () => {
    const session = two();
    const [a, b] = session.threads.map(({ messages }) => messages[0]!.id) as [string, string];
    const edited = done(session, "e", {
      command: "edit",
      message: a,
      seen: { markdown: "A?", kind: "question" },
      markdown: "A, edited?",
    }).session!;
    const kinded = done(edited, "k", {
      command: "edit",
      message: a,
      seen: { markdown: "A, edited?", kind: "question" },
      kind: "change",
    }).session!;
    const deleted = done(kinded, "x", {
      command: "retract",
      message: b,
      seen: { markdown: "B?", kind: "change" },
    }).session!;
    const picked = pick(deleted, "pending", "p1");
    expect(picked.result.threads.flatMap(({ messages }) => messages)).toMatchObject([
      { id: a, markdown: "A, edited?", kind: "change", pending: false },
    ]);
  });

  it("lets agent replies land in resolved threads without reopening them, immutable afterwards", () => {
    const session = pick(two(), "pending", "p1").session!;
    const thread = session.threads[0]!.id;
    const resolved = done(session, "r", { command: "resolve", thread, resolved: true }).session!;
    const replied = Result.getOrThrow(
      applyBatch(
        resolved,
        {
          revision: resolved.revision,
          snapshotId: SNAPSHOT,
          idempotencyKey: "late",
          ops: [{ type: "thread.reply", thread, markdown: "It was a typo; fixed." }],
        },
        captured[0]!,
        LATER,
      ),
    ).session!;
    expect(replied.threads[0]).toMatchObject({ resolved: true });
    const reply = replied.threads[0]!.messages.at(-1)!;
    expect(reply).toMatchObject({ author: "agent", markdown: "It was a typo; fixed." });
    expect("kind" in reply).toBe(false);
    expect(
      refused(replied, "e", {
        command: "edit",
        message: reply.id,
        seen: { markdown: "It was a typo; fixed.", kind: "question" },
        markdown: "Changed.",
      }),
    ).toMatchObject({
      message: "agent replies cannot be changed",
    });
    expect(statusOf(replied).viewedHunkIds).toEqual(["a1"]);
  });

  it("keeps human authority apart: Viewed, resolution and messages move independently", () => {
    const session = two();
    const thread = session.threads[0]!.id;
    const unviewed = Result.getOrThrow(
      setViewed(
        session,
        {
          command: "viewed",
          session: "session",
          snapshotId: SNAPSHOT,
          revision: session.revision,
          requestId: "v",
          hunkIds: ["a1"],
          viewed: false,
        },
        LATER,
      ),
    ).session!;
    const resolved = done(unviewed, "r", { command: "resolve", thread, resolved: true }).session!;
    expect(resolved).toMatchObject({
      viewedHunkIds: [],
      threads: [{ resolved: true }, { resolved: false }],
    });
  });
});
