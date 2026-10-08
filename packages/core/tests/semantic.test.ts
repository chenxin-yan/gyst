import { expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import {
  type ApplyEnvelope,
  ApplyEnvelopeSchema,
  applyBatch,
  type CapturedIndex,
  type CapturedSide,
} from "../src/apply.ts";
import { setViewed, type ViewedRequest } from "../src/human-action.ts";
import { refreshSession } from "../src/refresh.ts";
import { HunkSchema, type Session, SessionSchema, type StatusPayload } from "../src/session.ts";

const decode = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" });
const hunk = (id: string) => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: "@@ -1 +1 @@\n-a\n+b",
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
    overview: null,
    groups: [],
    viewedHunkIds: [],
    receiptTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
    refreshReceipts: [],
  });
/** The hunks' files, each side its own content, except `reverted` files' new sides. */
const files = (...reverted: string[]) =>
  ["a", "b", "c"].map((id) => ({
    path: `${id}.ts`,
    old: { kind: "text" as const, blob: `old-${id}`, size: 2 },
    new: {
      kind: "text" as const,
      blob: reverted.includes(id) ? `old-${id}` : `new-${id}`,
      size: 2,
    },
  }));
// Every hunk's file has one captured line on each side.
const captured = (session: Session): CapturedIndex => ({
  snapshotId: session.snapshotId,
  sides: new Map(
    session.hunks.flatMap(({ file }) =>
      (["old", "new"] as const).map((side): [string, CapturedSide] => [
        `${side}\0${file}`,
        { kind: "text", lines: 1 },
      ]),
    ),
  ),
});
const apply = (session: Session, envelope: ApplyEnvelope) =>
  applyBatch(session, envelope, captured(session), "later");
const anchor = (hunkId: string) => ({
  path: `${hunkId}.ts`,
  side: "new",
  startLine: 1,
  endLine: 1,
});
const note = (id: string, group: string, hunkId: string, markdown = "Intent and evidence.") => ({
  type: "note.create",
  id,
  group,
  anchor: anchor(hunkId),
  markdown,
});
const group = {
  type: "group.create",
  id: "g",
  title: "API and tests",
  overview: "Why the API changed and how the tests pin it.",
  memberHunkIds: ["b", "a"],
};
const envelope = (ops: unknown[], revision = 0, idempotencyKey = "first") =>
  decode({ revision, snapshotId: "snapshot", idempotencyKey, ops });
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

it("publishes a walkthrough progressively beside per-hunk Viewed and replays exactly", () => {
  expect(Result.getOrThrow(apply(initial(), envelope([]))).status.preparation.state).toBe("plain");
  const firstBatch = envelope([group, note("n", "g", "b")]);
  const first = Result.getOrThrow(apply(initial(), firstBatch));
  expect(first.status.groups.map(({ id }) => id)).toEqual(["g"]);
  // Partial coverage is valid and visible, not refused.
  expect(first.status.preparation).toEqual({
    state: "incomplete",
    groupedHunks: 2,
    totalHunks: 3,
    overviewMissing: true,
    groupsMissingOverview: [],
    overviewOutdated: false,
    groupsOutdated: [],
    notesOutdated: [],
  });
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
        overview: "A separate fix.",
      },
      { type: "walkthrough.update", overview: "One API change and one fix." },
    ],
    viewed.revision,
    "second",
  );
  const next = Result.getOrThrow(apply(viewed, nextBatch));
  expect(next.status).toMatchObject({
    viewedHunkIds: ["b", "c"],
    groups: [{ hunkIds: ["b", "a"] }, { hunkIds: ["c"] }],
    preparation: { state: "complete", groupedHunks: 3, totalHunks: 3 },
  });
  expect(
    Result.isFailure(apply(next.session!, { ...nextBatch, revision: 1, idempotencyKey: "stale" })),
  ).toBe(true);
  expect(Result.getOrThrow(apply(next.session!, firstBatch))).toEqual({ status: first.status });
  // a.ts went back to its old bytes, so its hunk is gone; b.ts and c.ts are as they were.
  const refreshed = refreshSession(
    next.session!,
    { snapshotId: "next", snapshot: { files: files("a"), hunks: [hunk("b"), hunk("c")] } },
    new Map([["snapshot", { files: files(), hunks: initial().hunks }]]),
    "later",
  );
  expect(refreshed.groups[0]).toMatchObject({
    title: group.title,
    overview: { outdated: ["code"] },
    notes: [{ id: "n", anchor: { snapshotId: "next" } }],
    hunkIds: ["b"],
  });
  expect(refreshed.groups[0]!.notes[0]!.outdated).toBeUndefined();
  expect(refreshed.groups[1]).toEqual(next.session!.groups[1]);
  expect(refreshed.viewedHunkIds).toEqual(["b", "c"]);
});

it("interns guidance text once and replays exact historical guidance after refresh", () => {
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
          overview: "Shared overview.",
        },
        note(`n${index}`, `g${index}`, `h${index}`, text(index)),
      ],
      session.revision,
      `publish-${index}`,
    );
    const outcome = Result.getOrThrow(apply(session, batch));
    envelopes.push(batch);
    statuses.push(outcome.status);
    session = outcome.session!;
  }
  const json = JSON.stringify(session);
  for (let index = 0; index < count; index++)
    expect(json.split(`note-${index}-`).length - 1).toBe(2);
  expect(json.split("Shared overview.").length - 1).toBe(count + 1);
  expect(session.receiptTexts).toHaveLength(count + 1);
  const viewed = view(session, ["h3"], "view");
  const edited = Result.getOrThrow(
    apply(
      viewed,
      envelope([{ type: "note.update", id: "n0", markdown: "rewritten" }], viewed.revision, "edit"),
    ),
  ).session!;
  const refreshed = refreshSession(
    edited,
    { snapshotId: "snapshot", snapshot: { files: [], hunks: edited.hunks.slice(1) } },
    new Map(),
    "later",
  );
  const reloaded = Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(refreshed)));
  for (const index of [0, count - 1])
    expect(apply(reloaded, envelopes[index]!)).toEqual(
      Result.succeed({ status: statuses[index]! }),
    );
  expect(statuses[count - 1]!.groups[0]?.notes[0]?.markdown).toBe(text(0));
  expect(edited.groups[0]?.notes[0]?.markdown).toBe("rewritten");
  expect(reloaded.viewedHunkIds).toEqual(["h3"]);
  for (const invalid of ["", " ", "bad\u0007text"])
    expect(() =>
      Schema.decodeUnknownSync(SessionSchema)({
        ...edited,
        receiptTexts: [invalid, ...edited.receiptTexts.slice(1)],
      }),
    ).toThrow();
  const receipt = edited.applyReceipts[0]!;
  const recorded = receipt.status.groups[0]!;
  for (const ref of [-1, 1.5, edited.receiptTexts.length]) {
    for (const groups of [
      [{ ...recorded, notes: [{ ...recorded.notes[0]!, markdown: ref }] }],
      [{ ...recorded, overview: { markdown: ref, references: [] } }],
    ])
      expect(() =>
        Schema.decodeUnknownSync(SessionSchema)({
          ...edited,
          applyReceipts: [{ ...receipt, status: { ...receipt.status, groups } }],
        }),
      ).toThrow();
  }
});

it("validates titles and rejects obsolete metadata strictly", () => {
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
  expect(() => envelope([{ ...group, title: "😀".repeat(120) }])).not.toThrow();
  for (const field of ["tldr", "exemplarHunkId", "notes"]) {
    expect(() => envelope([{ type: "group.update", id: "g", [field]: "old" }])).toThrow();
    expect(() => envelope([{ ...group, [field]: "old" }])).toThrow();
  }
  // Verdicts and the review queue are gone; their old fields and op are rejected, not translated.
  expect(() => envelope([{ ...group, accepted: false }])).toThrow();
  expect(() => envelope([{ type: "queue.set", itemIds: ["g"] }])).toThrow();
  for (const metadata of [{ title: "only" }, { notes: [] }, { accepted: true }])
    expect(() =>
      Schema.decodeUnknownSync(HunkSchema, { onExcessProperty: "error" })({
        ...hunk("a"),
        ...metadata,
      }),
    ).toThrow();
});

it("rejects invalid members and anchors atomically; update omission retains notes", () => {
  const before = initial();
  for (const ops of [
    [{ ...group, memberHunkIds: ["a", "a"] }],
    [group, note("n", "g", "c")],
    [group, note("n", "g", "b"), note("n", "g", "a")],
    [group, note("n", "g", "b"), { type: "group.update", id: "g", memberHunkIds: ["a"] }],
  ])
    expect(Result.isFailure(apply(before, envelope(ops)))).toBe(true);
  expect(before).toEqual(initial());
  const first = Result.getOrThrow(apply(before, envelope([group, note("n", "g", "b")]))).session!;
  const retained = Result.getOrThrow(
    apply(
      first,
      envelope([{ type: "group.update", id: "g", title: "New title" }], first.revision, "retain"),
    ),
  ).session!;
  expect(retained.groups[0]!.notes).toEqual(first.groups[0]!.notes);
  const cleared = Result.getOrThrow(
    apply(
      retained,
      envelope(
        [
          { type: "note.remove", id: "n" },
          { type: "group.update", id: "g", memberHunkIds: ["a"] },
        ],
        retained.revision,
        "clear",
      ),
    ),
  ).session!;
  expect(cleared.groups[0]!.notes).toEqual([]);
});
