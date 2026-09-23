import { expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { type ApplyEnvelope, ApplyEnvelopeSchema, applyBatch } from "./apply.ts";
import { applyHumanAction } from "./human-action.ts";
import { refreshSession } from "./refresh.ts";
import { HunkSchema, SessionSchema, type StatusPayload } from "./session.ts";

const decode = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" });
const hunk = (id: string) => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: "-a\n+b",
  contentHash: id,
});
const initial = () =>
  Schema.decodeUnknownSync(SessionSchema)({
    id: "session",
    repoRoot: "/repo",
    source: { kind: "stdin" },
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    seq: 0,
    cursor: { itemId: null, pane: "queue" },
    hunks: [hunk("a"), hunk("b"), hunk("c")],
    groups: [],
    queue: [],
    queueSet: false,
    acceptHistory: [],
    receiptNoteTexts: [],
    applyReceipts: [],
  });
const note = (hunkId: string, text = "Intent and evidence") => ({ hunkId, text });
const group = {
  type: "group.create",
  id: "g",
  title: "API and tests",
  notes: [note("b")],
  memberHunkIds: ["b", "a"],
};
const queue = { type: "queue.set", itemIds: ["g"] };
const envelope = (ops: unknown[], revision = 0, idempotencyKey = "first") =>
  decode({ revision, idempotencyKey, ops });

it("publishes groups progressively and preserves unrelated verdicts and exact replay", () => {
  const firstBatch = envelope([group, queue]);
  const first = Result.getOrThrow(applyBatch(initial(), firstBatch, "later"));
  expect(first.status.ready).toBe(false);
  expect(first.status.inbox.map(({ id }) => id)).toEqual(["c"]);
  const accepted = Result.getOrThrow(
    applyHumanAction(
      first.session!,
      { type: "verdict.toggle", itemId: "g", sessionId: "session", revision: 1 },
      "later",
    ),
  );
  const nextBatch = envelope(
    [
      {
        type: "group.create",
        id: "independent",
        memberHunkIds: ["c"],
        title: "Independent fix",
        notes: [],
      },
      { type: "queue.set", itemIds: ["g", "independent"] },
    ],
    accepted.revision,
    "second",
  );
  const next = Result.getOrThrow(applyBatch(accepted, nextBatch, "later"));
  expect(next.status).toMatchObject({
    ready: true,
    queue: ["g", "independent"],
    cursor: accepted.cursor,
    groups: [
      { accepted: true, hunkIds: ["b", "a"] },
      { accepted: false, hunkIds: ["c"] },
    ],
  });
  expect(
    Result.isFailure(
      applyBatch(next.session!, { ...nextBatch, revision: 1, idempotencyKey: "stale" }, "later"),
    ),
  ).toBe(true);
  expect(Result.getOrThrow(applyBatch(next.session!, firstBatch, "later"))).toEqual({
    status: first.status,
  });
  const refreshed = refreshSession(next.session!, [hunk("b"), hunk("c")], "later");
  expect(refreshed.groups[0]).toMatchObject({
    title: group.title,
    notes: [],
    hunkIds: ["b"],
    accepted: false,
  });
  expect(refreshed.groups[1]).toEqual(next.session!.groups[1]);
  expect(refreshed.acceptHistory).toEqual([]);
});

it("interns note text once and replays exact historical notes, anchors and cursors after refresh", () => {
  const count = 50;
  const text = (index: number) => `note-${index}-`.padEnd(400, "x");
  let session = Schema.decodeUnknownSync(SessionSchema)({
    ...initial(),
    hunks: Array.from({ length: count }, (_, index) => hunk(`h${index}`)),
  });
  const published: string[] = [];
  const envelopes: ApplyEnvelope[] = [];
  const statuses: StatusPayload[] = [];
  for (let index = 0; index < count; index++) {
    published.push(`g${index}`);
    const batch = envelope(
      [
        {
          type: "group.create",
          id: `g${index}`,
          memberHunkIds: [`h${index}`],
          title: `item ${index}`,
          notes: [note(`h${index}`, text(index))],
        },
        { type: "queue.set", itemIds: [...published] },
      ],
      session.revision,
      `publish-${index}`,
    );
    const outcome = Result.getOrThrow(applyBatch(session, batch, "later"));
    envelopes.push(batch);
    statuses.push(outcome.status);
    session = outcome.session!;
  }
  const json = JSON.stringify(session);
  for (let index = 0; index < count; index++)
    expect(json.split(`note-${index}-`).length - 1).toBe(2);
  expect(session.receiptNoteTexts).toHaveLength(count);
  const moved = Result.getOrThrow(
    applyHumanAction(session, { type: "cursor.move", itemId: "g3" }, "later"),
  );
  const accepted = Result.getOrThrow(
    applyHumanAction(
      moved,
      { type: "verdict.toggle", itemId: "g3", sessionId: "session", revision: moved.revision },
      "later",
    ),
  );
  const edited = Result.getOrThrow(
    applyBatch(
      accepted,
      envelope(
        [
          { type: "group.update", id: "g0", notes: [note("h0", "rewritten")] },
          { type: "queue.set", itemIds: [...published] },
        ],
        accepted.revision,
        "edit",
      ),
      "later",
    ),
  ).session!;
  const refreshed = refreshSession(edited, edited.hunks.slice(1), "later");
  const reloaded = Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(refreshed)));
  for (const index of [0, count - 1])
    expect(applyBatch(reloaded, envelopes[index]!, "later")).toEqual(
      Result.succeed({ status: statuses[index]! }),
    );
  expect(statuses[count - 1]!.groups[0]?.notes).toEqual([note("h0", text(0))]);
  expect(edited.groups[0]?.notes).toEqual([note("h0", "rewritten")]);
  expect(reloaded.groups.find(({ id }) => id === "g3")).toMatchObject({ accepted: true });
  expect(reloaded.cursor).toEqual({ itemId: "g4", pane: "queue", hunkId: "h4" });
  for (const invalid of ["", "x".repeat(401), "bad\ntext"])
    expect(() =>
      Schema.decodeUnknownSync(SessionSchema)({
        ...edited,
        receiptNoteTexts: [invalid, ...edited.receiptNoteTexts.slice(1)],
      }),
    ).toThrow();
  const receipt = edited.applyReceipts[0]!;
  for (const ref of [-1, 1.5, edited.receiptNoteTexts.length])
    expect(() =>
      Schema.decodeUnknownSync(SessionSchema)({
        ...edited,
        applyReceipts: [
          {
            ...receipt,
            status: {
              ...receipt.status,
              groups: [{ ...receipt.status.groups[0]!, notes: [{ hunkId: "h0", text: ref }] }],
            },
          },
        ],
      }),
    ).toThrow();
});

it("validates bounded plain note text and rejects obsolete metadata strictly", () => {
  for (const title of [
    "",
    " ",
    "x\ny",
    "x\ty",
    "\u001b[31m",
    "\u009b31m",
    "x\u2028y",
    "😀".repeat(121),
  ])
    expect(() => envelope([{ ...group, title }])).toThrow();
  for (const text of [
    "",
    " ",
    "😀".repeat(401),
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u0007b",
    "a\u001bb",
    "a\u009bb",
    "a\u2028b",
    "a\u2029b",
    "a\u202eb",
    "a\u2066b",
  ])
    expect(() => envelope([{ ...group, notes: [note("b", text)] }])).toThrow();
  expect(() =>
    envelope([{ ...group, title: "😀".repeat(120), notes: [note("b", "😀".repeat(400))] }]),
  ).not.toThrow();
  expect(() => envelope([{ ...group, notes: [] }])).not.toThrow();
  for (const field of ["overview", "tldr", "exemplarHunkId"]) {
    expect(() => envelope([{ type: "group.update", id: "g", [field]: "old" }])).toThrow();
    expect(() => envelope([{ ...group, [field]: "old" }])).toThrow();
  }
  const { notes: _, ...missing } = group;
  expect(() => envelope([missing])).toThrow();
  for (const metadata of [{ title: "only" }, { notes: [] }, { accepted: true }])
    expect(() =>
      Schema.decodeUnknownSync(HunkSchema, { onExcessProperty: "error" })({
        ...hunk("a"),
        ...metadata,
      }),
    ).toThrow();
});

it("rejects invalid anchors and queues atomically; update omission retains and empty notes clears", () => {
  const before = initial();
  for (const ops of [
    [{ ...group, memberHunkIds: ["a", "a"] }],
    [{ ...group, notes: [note("c")] }, queue],
    [{ ...group, notes: [note("b"), note("b")] }, queue],
    [group, { type: "queue.set", itemIds: [] }],
    [group, { type: "group.update", id: "g", memberHunkIds: ["a"] }, queue],
  ])
    expect(Result.isFailure(applyBatch(before, envelope(ops), "later"))).toBe(true);
  expect(before).toEqual(initial());
  const first = Result.getOrThrow(applyBatch(before, envelope([group, queue]), "later")).session!;
  expect(
    Result.isFailure(
      applyBatch(
        first,
        envelope([{ type: "group.update", id: "g", notes: [] }], first.revision, "missing-queue"),
        "later",
      ),
    ),
  ).toBe(true);
  const retained = Result.getOrThrow(
    applyBatch(
      first,
      envelope(
        [{ type: "group.update", id: "g", title: "New title" }, queue],
        first.revision,
        "retain",
      ),
      "later",
    ),
  ).session!;
  expect(retained.groups[0]!.notes).toEqual(group.notes);
  const cleared = Result.getOrThrow(
    applyBatch(
      retained,
      envelope(
        [{ type: "group.update", id: "g", notes: [], memberHunkIds: ["a"] }, queue],
        retained.revision,
        "clear",
      ),
      "later",
    ),
  ).session!;
  expect(cleared.groups[0]!.notes).toEqual([]);
});
