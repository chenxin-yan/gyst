import { describe, expect, it } from "vite-plus/test";
import { Result, Schema } from "effect";
import {
  type ApplyEnvelope,
  ApplyEnvelopeSchema,
  type ApplyOp,
  applyBatch,
  type CapturedIndex,
  type CapturedSide,
  capturedSideKey,
  capturedTargetsOf,
} from "./apply.ts";
import type { CodeRange, Note } from "./guidance.ts";
import { type Hunk, type Session, SessionSchema } from "./session.ts";
import { statusOf } from "./status.ts";

const LATER = "2026-02-02T00:00:00.000Z";
const SNAPSHOT = "snapshot";

const hunk = (id: string, file: string, patch: string): Hunk => ({
  id,
  file,
  header: patch.slice(0, patch.indexOf("\n")),
  patch,
  contentHash: id,
});
// a.ts: a1 changes line 2, a2 line 11, a3 line 31 (both sides); a4 deletes old lines 50-51.
const hunks = [
  hunk("a1", "a.ts", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"),
  hunk("a2", "a.ts", "@@ -10,3 +10,3 @@\n x\n-y\n+Y\n z"),
  hunk("a3", "a.ts", "@@ -30,3 +30,3 @@\n x\n-y\n+Y\n z"),
  hunk("a4", "a.ts", "@@ -50,2 +49,0 @@\n-gone\n-gone"),
  hunk("b1", "b.ts", "@@ -1 +1 @@\n-p\n+q"),
];
const text = (markdown: string) => ({ markdown, references: [] });
const pin = (range: CodeRange) => ({ snapshotId: SNAPSHOT, ...range });
const range = (path: string, side: "old" | "new", startLine: number, endLine = startLine) => ({
  path,
  side,
  startLine,
  endLine,
});
const note = (id: string, anchor: CodeRange, markdown = `About ${id}.`): Note => ({
  id,
  anchor: pin(anchor),
  ...text(markdown),
});

const session: Session = {
  id: "session",
  repoRoot: "/repo",
  scope: { kind: "uncommitted" },
  snapshotId: SNAPSHOT,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  hunks,
  overview: text("The walkthrough."),
  groups: [
    {
      id: "g1",
      title: "first",
      overview: text("First group."),
      hunkIds: ["a1", "a2"],
      files: ["a.ts"],
      notes: [note("n1", range("a.ts", "new", 2))],
    },
    {
      id: "g2",
      title: "second",
      overview: null,
      hunkIds: ["b1", "a3"],
      files: ["b.ts", "a.ts"],
      notes: [],
    },
  ],
  viewedHunkIds: ["a1", "a2", "a3", "a4", "b1"],
  receiptTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
};

const sides: [string, CapturedSide][] = [
  ["old\0a.ts", { kind: "text", lines: 60 }],
  ["new\0a.ts", { kind: "text", lines: 60 }],
  ["new\0b.ts", { kind: "text", lines: 3 }],
  ["new\0support.ts", { kind: "text", lines: 5 }],
  ["old\0added.ts", { kind: "absent" }],
  ["new\0image.png", { kind: "unavailable", reason: "binary" }],
  ["new\0live.ts", { kind: "missing" }],
];
const captured: CapturedIndex = { snapshotId: SNAPSHOT, sides: new Map(sides) };

const batch = (ops: ApplyOp[], idempotencyKey = "key", revision = 3): ApplyEnvelope => ({
  revision,
  snapshotId: SNAPSHOT,
  idempotencyKey,
  ops,
});
const outcome = (ops: ApplyOp[], from = session, idempotencyKey?: string) =>
  Result.getOrThrow(applyBatch(from, batch(ops, idempotencyKey, from.revision), captured, LATER));
const applied = (ops: ApplyOp[], from = session, idempotencyKey?: string) =>
  outcome(ops, from, idempotencyKey).session!;
const rejected = (ops: ApplyOp[], from = session) => {
  const result = applyBatch(from, batch(ops, "key", from.revision), captured, LATER);
  if (Result.isSuccess(result)) throw new Error("expected validation failure");
  return result.failure;
};
const unviewedBy = (ops: ApplyOp[], from = session) => {
  const viewed = new Set(applied(ops, from).viewedHunkIds);
  return from.viewedHunkIds.filter((id) => !viewed.has(id));
};

const third: ApplyOp = {
  type: "group.create",
  id: "g3",
  title: "third",
  overview: "Removes the dead branch.",
  memberHunkIds: ["a4"],
};

describe("applyBatch", () => {
  it("publishes a walkthrough, groups, file order and notes as one batch", () => {
    const changed = applied([
      { type: "walkthrough.update", overview: "Rewritten walkthrough." },
      third,
      {
        type: "group.update",
        id: "g2",
        title: "Second",
        overview: "Second group.",
        files: ["a.ts", "b.ts"],
      },
      {
        type: "note.create",
        id: "n2",
        group: "g3",
        anchor: range("a.ts", "old", 49, 52),
        markdown: "**Why** it goes.",
      },
      { type: "note.update", id: "n1", markdown: "Reworded `n1`." },
      { type: "walkthrough.update", groupOrder: ["g3", "g1", "g2"] },
    ]);
    expect(changed.overview).toEqual(text("Rewritten walkthrough."));
    expect(changed.groups).toEqual([
      {
        id: "g3",
        title: "third",
        overview: text("Removes the dead branch."),
        hunkIds: ["a4"],
        files: ["a.ts"],
        notes: [note("n2", range("a.ts", "old", 49, 52), "**Why** it goes.")],
      },
      { ...session.groups[0]!, notes: [note("n1", range("a.ts", "new", 2), "Reworded `n1`.")] },
      {
        ...session.groups[1]!,
        title: "Second",
        overview: text("Second group."),
        files: ["a.ts", "b.ts"],
      },
    ]);
    expect(changed.revision).toBe(4);
    expect(changed.updatedAt).toBe(LATER);
    expect(session.groups[0]?.notes[0]?.markdown).toBe("About n1.");
  });

  it("rolls back the whole batch when any op is invalid", () => {
    const before = structuredClone(session);
    for (const [ops, detail] of [
      [
        [third, { type: "group.update", id: "", title: "renamed" }],
        { opIndex: 1, message: "group id must not be empty" },
      ],
      [
        [third, { ...third, id: "g4", memberHunkIds: [] }],
        { opIndex: 1, message: "group members must be non-empty and unique" },
      ],
      [
        [third, { ...third, id: "g4", memberHunkIds: ["gone"] }],
        { opIndex: 1, message: "group member does not exist" },
      ],
      [[third, { ...third, id: "a1" }], { opIndex: 1, message: "item id a1 already exists" }],
      [
        [third, { type: "group.dissolve", id: "g9" }],
        { opIndex: 1, message: "group g9 does not exist" },
      ],
      [
        [third, { type: "note.remove", id: "n9" }],
        { opIndex: 1, message: "note n9 does not exist" },
      ],
      [
        [
          third,
          {
            type: "note.create",
            id: "n1",
            group: "g1",
            anchor: range("a.ts", "new", 2),
            markdown: "x",
          },
        ],
        { opIndex: 1, message: "note n1 already exists" },
      ],
      [
        [third, { type: "walkthrough.update", groupOrder: ["g1", "g2"] }],
        { opIndex: 1, message: "groupOrder must list every current group once" },
      ],
    ] satisfies [ApplyOp[], unknown][]) {
      const error = rejected(ops);
      expect(error._tag).toBe("validation_failed");
      expect(error.detail).toEqual([detail]);
    }
    expect(session).toEqual(before);
  });

  it("validates exclusive membership and file order on the resulting state, not op by op", () => {
    expect(rejected([{ ...third, memberHunkIds: ["a1"] }]).detail).toEqual([
      {
        opIndex: 0,
        message: "hunk a1 is in groups g1 and g3; a hunk may belong to only one group",
      },
    ]);
    expect(rejected([{ type: "group.update", id: "g2", files: ["b.ts"] }]).detail).toEqual([
      { opIndex: 0, message: "files of group g2 must list each of its members' files once" },
    ]);
    for (const files of [
      ["a.ts", "a.ts"],
      ["a.ts", "c.ts"],
    ])
      expect(rejected([{ ...third, files }])._tag).toBe("validation_failed");
    // Moving a hunk between groups holds whichever group the batch updates first.
    const moved = applied([
      { type: "group.update", id: "g2", memberHunkIds: ["b1", "a3", "a2"] },
      { type: "group.update", id: "g1", memberHunkIds: ["a1"] },
    ]);
    expect(moved.groups.map(({ hunkIds, files }) => ({ hunkIds, files }))).toEqual([
      { hunkIds: ["a1"], files: ["a.ts"] },
      { hunkIds: ["b1", "a3", "a2"], files: ["b.ts", "a.ts"] },
    ]);
    // New members' files follow the kept order; dropped files leave it.
    const regrouped = applied([
      { type: "group.update", id: "g2", memberHunkIds: ["a3"] },
      { type: "group.update", id: "g2", memberHunkIds: ["a3", "b1"] },
    ]);
    expect(regrouped.groups[1]?.files).toEqual(["a.ts", "b.ts"]);
  });

  it("leaves dissolved members ungrouped under their files and drops the group's notes", () => {
    const dissolved = applied([{ type: "group.dissolve", id: "g1" }]);
    expect(statusOf(dissolved).groups.map(({ id }) => id)).toEqual(["g2"]);
    expect(dissolved.hunks).toEqual(session.hunks);
    // A dissolved note's id is free again.
    const recreated = applied([
      { type: "group.dissolve", id: "g1" },
      { ...third, memberHunkIds: ["a1", "a2"] },
      {
        type: "note.create",
        id: "n1",
        group: "g3",
        anchor: range("a.ts", "new", 11),
        markdown: "Moved.",
      },
    ]);
    expect(recreated.groups[1]?.notes.map(({ id }) => id)).toEqual(["n1"]);
  });

  it("replays only an identical envelope under a reused idempotency key", () => {
    const first = outcome([third]);
    const next = first.session!;
    // Later edits do not change what the first batch answered.
    const later = applied(
      [
        { type: "group.update", id: "g3", overview: "Edited." },
        { type: "note.remove", id: "n1" },
      ],
      next,
      "later",
    );
    const reloaded = Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(later)));
    expect(applyBatch(reloaded, batch([third]), captured, LATER)).toEqual(
      Result.succeed({ status: first.status }),
    );

    for (const different of [
      batch([{ ...third, overview: "changed" }]),
      { ...batch([third]), revision: next.revision },
      { ...batch([third]), snapshotId: "other" },
    ]) {
      const reused = applyBatch(next, different, captured, LATER);
      if (Result.isSuccess(reused)) throw new Error("expected validation failure");
      expect(reused.failure).toMatchObject({
        _tag: "validation_failed",
        message: "idempotency key reused with a different batch",
      });
    }
  });

  it("conflicts on a stale revision or snapshot instead of overwriting", () => {
    const current = "current snapshot is snapshot at revision 3";
    for (const [envelope, index, message] of [
      [{ ...batch([third]), revision: 2 }, captured, `apply revision 2 is stale; ${current}`],
      [
        { ...batch([third]), snapshotId: "older" },
        captured,
        `apply snapshot older is stale; ${current}`,
      ],
      [
        batch([third]),
        { ...captured, snapshotId: "older" },
        `the snapshot changed while the batch was checked; ${current}`,
      ],
    ] as const) {
      const result = applyBatch(session, envelope, index, LATER);
      if (Result.isSuccess(result)) throw new Error("expected stale revision");
      expect(result.failure).toMatchObject({
        _tag: "stale_revision",
        detail: [{ opIndex: -1, message }],
      });
    }
  });

  it("rejects obsolete and unknown authoring fields instead of translating them", () => {
    const decode = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" });
    const envelope = (ops: unknown[]) => decode({ ...batch([]), ops });
    expect(() => envelope([third])).not.toThrow();
    for (const op of [
      { ...third, notes: [] },
      { ...third, notes: [{ hunkId: "a4", text: "old" }] },
      { type: "group.update", id: "g1", notes: [] },
      { ...third, tldr: "old" },
      { ...third, accepted: false },
      { type: "queue.set", itemIds: ["g1"] },
      { type: "note.create", id: "n", group: "g1", hunkId: "a1", text: "old" },
      { type: "note.update", id: "n1", text: "old" },
      { type: "walkthrough.update", groups: [] },
    ])
      expect(() => envelope([op]), JSON.stringify(op)).toThrow();
    // A group needs an overview at creation; a batch names its snapshot.
    const { overview: _, ...bare } = third;
    expect(() => envelope([bare])).toThrow();
    const { snapshotId: __, ...unpinned } = batch([third]);
    expect(() => decode(unpinned)).toThrow();
  });

  it("accepts Markdown notes without a length cap across own-group hunks and unchanged lines", () => {
    const long = `${"Context. ".repeat(200)}\n\n- list\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
    const changed = applied([
      {
        type: "note.create",
        id: "span",
        group: "g1",
        anchor: range("a.ts", "new", 1, 12),
        markdown: long,
      },
      {
        type: "note.create",
        id: "old",
        group: "g1",
        anchor: range("a.ts", "old", 2, 11),
        markdown: "Old side.",
      },
    ]);
    expect(changed.groups[0]!.notes.map(({ id }) => id)).toEqual(["old", "span", "n1"]);
    expect(changed.groups[0]!.notes[1]).toEqual(note("span", range("a.ts", "new", 1, 12), long));
  });

  it("rejects a note that covers another group's or an ungrouped changed line, or none of its own", () => {
    const create = (anchor: CodeRange, group = "g1"): ApplyOp => ({
      type: "note.create",
      id: "n",
      group,
      anchor,
      markdown: "x",
    });
    expect(rejected([create(range("a.ts", "new", 2, 31))]).detail).toEqual([
      {
        opIndex: 0,
        message: "note n covers changed lines of hunk a3, which is in group g2, not group g1",
      },
    ]);
    expect(rejected([create(range("a.ts", "old", 11, 50))]).detail).toEqual([
      {
        opIndex: 0,
        message: "note n covers changed lines of hunk a3, which is in group g2, not group g1",
      },
      {
        opIndex: 0,
        message: "note n covers changed lines of hunk a4, which is ungrouped, not group g1",
      },
    ]);
    // Unchanged lines alone, an unchanged supporting file and a pure deletion's new side miss.
    for (const anchor of [
      range("a.ts", "new", 3, 10),
      range("a.ts", "old", 3, 10),
      range("support.ts", "new", 1),
    ])
      expect(rejected([create(anchor)]).detail).toEqual([
        { opIndex: 0, message: "note n must cover a changed line of its group g1" },
      ]);
    expect(rejected([create(range("a.ts", "new", 49, 52), "g2")]).detail).toEqual([
      { opIndex: 0, message: "note n must cover a changed line of its group g2" },
    ]);
  });

  it("checks written anchors against the captured snapshot's lines", () => {
    const create = (anchor: CodeRange): ApplyOp => ({
      type: "note.create",
      id: "n",
      group: "g1",
      anchor,
      markdown: "x",
    });
    for (const [anchor, message] of [
      [
        range("a.ts", "new", 59, 61),
        "lines 59-61 are outside the new side of a.ts, which has 60 lines",
      ],
      [range("added.ts", "old", 1), "the old side of added.ts does not exist"],
      [range("image.png", "new", 1), "the new side of image.png is binary, not captured text"],
      [range("live.ts", "new", 1), "live.ts is not in the captured snapshot"],
      [range("unindexed.ts", "new", 1), "unindexed.ts is not in the captured snapshot"],
    ] as const)
      expect(rejected([create(anchor)]).detail).toEqual([
        { opIndex: 0, message: `note n: ${message}` },
      ]);
    expect(
      rejected([{ type: "note.update", id: "n1", anchor: range("a.ts", "new", 2, 61) }]).detail,
    ).toEqual([
      {
        opIndex: 0,
        message: "note n1: lines 2-61 are outside the new side of a.ts, which has 60 lines",
      },
    ]);
    expect(
      capturedTargetsOf(
        batch([
          create(range("a.ts", "new", 2)),
          { type: "note.update", id: "n1", anchor: range("a.ts", "new", 11) },
          { type: "note.update", id: "n1", markdown: "x" },
          create(range("a.ts", "old", 2)),
        ]),
      ),
    ).toEqual([
      { path: "a.ts", side: "new" },
      { path: "a.ts", side: "old" },
    ]);
    expect(capturedSideKey("old", "a.ts")).toBe("old\0a.ts");
  });

  it("rejects a membership change that strands a retained note", () => {
    expect(rejected([{ type: "group.update", id: "g1", memberHunkIds: ["a2"] }]).detail).toEqual([
      { opIndex: 0, message: "note n1 must cover a changed line of its group g1" },
      {
        opIndex: 0,
        message: "note n1 covers changed lines of hunk a1, which is ungrouped, not group g1",
      },
    ]);
    // Re-anchoring in the same batch keeps the note.
    const kept = applied([
      { type: "group.update", id: "g1", memberHunkIds: ["a2"] },
      { type: "note.update", id: "n1", anchor: range("a.ts", "new", 11) },
    ]);
    expect(kept.groups[0]!.notes).toEqual([note("n1", range("a.ts", "new", 11))]);
  });

  it("unviews exactly the hunks whose guidance changed", () => {
    const create = (anchor: CodeRange, group = "g1"): ApplyOp => ({
      type: "note.create",
      id: "n",
      group,
      anchor,
      markdown: "x",
    });
    expect(unviewedBy([create(range("a.ts", "new", 31), "g2")])).toEqual(["a3"]);
    expect(unviewedBy([create(range("a.ts", "new", 2, 11))])).toEqual(["a1", "a2"]);
    expect(unviewedBy([{ type: "note.update", id: "n1", markdown: "Edited." }])).toEqual(["a1"]);
    expect(unviewedBy([{ type: "note.remove", id: "n1" }])).toEqual(["a1"]);
    // Re-anchoring unviews the old and the new anchored hunks.
    expect(
      unviewedBy([{ type: "note.update", id: "n1", anchor: range("a.ts", "new", 11) }]),
    ).toEqual(["a1", "a2"]);
    expect(unviewedBy([{ type: "group.update", id: "g1", overview: "Edited." }])).toEqual([
      "a1",
      "a2",
    ]);
    expect(unviewedBy([{ type: "group.update", id: "g1", overview: null }])).toEqual(["a1", "a2"]);
    expect(unviewedBy([{ type: "group.dissolve", id: "g1" }])).toEqual(["a1", "a2"]);
    // Every grouped hunk, never the ungrouped a4.
    for (const overview of ["Edited.", null])
      expect(unviewedBy([{ type: "walkthrough.update", overview }])).toEqual([
        "a1",
        "a2",
        "a3",
        "b1",
      ]);
  });

  it("keeps Viewed through first publication, reordering, titles, membership and reverted edits", () => {
    for (const ops of [
      [{ type: "group.update", id: "g2", overview: "First publication." }],
      [{ type: "walkthrough.update", groupOrder: ["g2", "g1"] }],
      [{ type: "group.update", id: "g2", files: ["a.ts", "b.ts"], title: "Renamed" }],
      [{ type: "group.update", id: "g2", memberHunkIds: ["b1", "a3", "a4"] }],
      [third],
      [
        { type: "note.update", id: "n1", markdown: "Edited." },
        { type: "group.update", id: "g1", overview: "Edited." },
        { type: "note.update", id: "n1", markdown: "About n1." },
        { type: "group.update", id: "g1", overview: "First group." },
      ],
      [{ type: "walkthrough.update", overview: "The walkthrough." }],
    ] satisfies ApplyOp[][])
      expect(unviewedBy(ops), JSON.stringify(ops)).toEqual([]);
    const unpublished = { ...session, overview: null };
    expect(unviewedBy([{ type: "walkthrough.update", overview: "First." }], unpublished)).toEqual(
      [],
    );
  });

  it("stores notes in code order: file order, hunk order, old side first, then start line", () => {
    const create = (id: string, group: string, anchor: CodeRange): ApplyOp => ({
      type: "note.create",
      id,
      group,
      anchor,
      markdown: "x",
    });
    const sorted = applied([
      create("late", "g1", range("a.ts", "new", 11)),
      create("wide", "g1", range("a.ts", "new", 1, 11)),
      create("new", "g1", range("a.ts", "new", 2, 3)),
      create("old", "g1", range("a.ts", "old", 2)),
      create("a", "g2", range("a.ts", "new", 31)),
      create("b", "g2", range("b.ts", "new", 1)),
    ]);
    expect(sorted.groups.map(({ notes }) => notes.map(({ id }) => id))).toEqual([
      ["old", "wide", "n1", "new", "late"],
      ["b", "a"],
    ]);
  });

  it("reports preparation as plain, incomplete or complete without refusing partial work", () => {
    const plain = { ...session, overview: null, groups: [] };
    expect(statusOf(plain).preparation).toEqual({
      state: "plain",
      groupedHunks: 0,
      totalHunks: 5,
      overviewMissing: true,
      groupsMissingOverview: [],
    });
    expect(statusOf(session).preparation).toEqual({
      state: "incomplete",
      groupedHunks: 4,
      totalHunks: 5,
      overviewMissing: false,
      groupsMissingOverview: ["g2"],
    });
    const complete = applied([third, { type: "group.update", id: "g2", overview: "Second." }]);
    expect(statusOf(complete).preparation).toEqual({
      state: "complete",
      groupedHunks: 5,
      totalHunks: 5,
      overviewMissing: false,
      groupsMissingOverview: [],
    });
    const status = statusOf(
      applied([{ type: "walkthrough.update", overview: null }], complete, "k2"),
    );
    expect(status.preparation).toMatchObject({ state: "incomplete", overviewMissing: true });
    expect(statusOf({ ...plain, overview: text("Overview only.") }).preparation.state).toBe(
      "incomplete",
    );
  });
});
