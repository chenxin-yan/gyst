import { expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import { type ApplyEnvelope, ApplyEnvelopeSchema, applyBatch } from "../src/apply.ts";
import { setViewed, type ViewedRequest } from "../src/human-action.ts";
import { refreshSession } from "../src/refresh.ts";
import { HunkSchema, type Session, SessionSchema, type StatusPayload } from "../src/session.ts";

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
    scope: { kind: "uncommitted" },
    snapshotId: "snapshot",
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    hunks: [hunk("a"), hunk("b"), hunk("c")],
    groups: [],
    viewedHunkIds: [],
    receiptNoteTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
  });
const note = (hunkId: string, text = "Intent and evidence") => ({ hunkId, text });
const group = {
  type: "group.create",
  id: "g",
  title: "API and tests",
  notes: [note("b")],
  memberHunkIds: ["b", "a"],
};
const envelope = (ops: unknown[], revision = 0, idempotencyKey = "first") =>
  decode({ revision, idempotencyKey, ops });
const view = (session: Session, hunkIds: string[], requestId: string) => {
  const request: ViewedRequest = {
    command: "viewed",
    session: session.id,
    snapshotId: session.snapshotId,
    revision: session.revision,
    requestId,
    hunkIds,
    viewed: true,
  };
  return Result.getOrThrow(setViewed(session, request, "later")).session!;
};

it("publishes groups progressively beside per-hunk Viewed and replays exactly", () => {
  const firstBatch = envelope([group]);
  const first = Result.getOrThrow(applyBatch(initial(), firstBatch, "later"));
  expect(first.status.groups.map(({ id }) => id)).toEqual(["g"]);
  // Viewed is the human's per-hunk progress; it moves the one review revision.
  const viewed = view(first.session!, ["b", "c"], "view");
  expect(viewed.revision).toBe(2);
  const nextBatch = envelope(
    [
      {
        type: "group.create",
        id: "independent",
        memberHunkIds: ["c"],
        title: "Independent fix",
        notes: [],
      },
    ],
    viewed.revision,
    "second",
  );
  const next = Result.getOrThrow(applyBatch(viewed, nextBatch, "later"));
  expect(next.status).toMatchObject({
    viewedHunkIds: ["b", "c"],
    groups: [{ hunkIds: ["b", "a"] }, { hunkIds: ["c"] }],
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
  expect(refreshed.groups[0]).toMatchObject({ title: group.title, notes: [], hunkIds: ["b"] });
  expect(refreshed.groups[1]).toEqual(next.session!.groups[1]);
  expect(refreshed.viewedHunkIds).toEqual(["b", "c"]);
});

it("interns note text once and replays exact historical notes and anchors after refresh", () => {
  const count = 50;
  const text = (index: number) => `note-${index}-`.padEnd(400, "x");
  let session = Schema.decodeUnknownSync(SessionSchema)({
    ...initial(),
    hunks: Array.from({ length: count }, (_, index) => hunk(`h${index}`)),
  });
  const envelopes: ApplyEnvelope[] = [];
  const statuses: StatusPayload[] = [];
  for (let index = 0; index < count; index++) {
    const batch = envelope(
      [
        {
          type: "group.create",
          id: `g${index}`,
          memberHunkIds: [`h${index}`],
          title: `item ${index}`,
          notes: [note(`h${index}`, text(index))],
        },
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
  const viewed = view(session, ["h3"], "view");
  const edited = Result.getOrThrow(
    applyBatch(
      viewed,
      envelope(
        [{ type: "group.update", id: "g0", notes: [note("h0", "rewritten")] }],
        viewed.revision,
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
  expect(reloaded.viewedHunkIds).toEqual(["h3"]);
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
  // Verdicts and the review queue are gone; their old fields and op are rejected, not translated.
  expect(() => envelope([{ ...group, accepted: false }])).toThrow();
  expect(() => envelope([{ type: "queue.set", itemIds: ["g"] }])).toThrow();
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

it("rejects invalid anchors atomically; update omission retains and empty notes clears", () => {
  const before = initial();
  for (const ops of [
    [{ ...group, memberHunkIds: ["a", "a"] }],
    [{ ...group, notes: [note("c")] }],
    [{ ...group, notes: [note("b"), note("b")] }],
    [group, { type: "group.update", id: "g", memberHunkIds: ["a"] }],
  ])
    expect(Result.isFailure(applyBatch(before, envelope(ops), "later"))).toBe(true);
  expect(before).toEqual(initial());
  const first = Result.getOrThrow(applyBatch(before, envelope([group]), "later")).session!;
  const retained = Result.getOrThrow(
    applyBatch(
      first,
      envelope([{ type: "group.update", id: "g", title: "New title" }], first.revision, "retain"),
      "later",
    ),
  ).session!;
  expect(retained.groups[0]!.notes).toEqual(group.notes);
  const cleared = Result.getOrThrow(
    applyBatch(
      retained,
      envelope(
        [{ type: "group.update", id: "g", notes: [], memberHunkIds: ["a"] }],
        retained.revision,
        "clear",
      ),
      "later",
    ),
  ).session!;
  expect(cleared.groups[0]!.notes).toEqual([]);
});
