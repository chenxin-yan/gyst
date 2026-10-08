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
import { refreshSession } from "./refresh.ts";
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
  refreshReceipts: [],
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
        session,
      ),
    ).toEqual([
      { path: "a.ts", side: "new" },
      { path: "a.ts", side: "old" },
    ]);
    expect(capturedSideKey("old", "a.ts")).toBe("old\0a.ts");
  });

  it("pins references in every written text to the batch's snapshot, unchanged files included", () => {
    const markdown =
      "Uses [the helper](gyst:new/support.ts#L2-L4) like [before](gyst:old/a.ts#L10), " +
      "[again](gyst:new/support.ts#L2-L4) and [docs](https://example.com).";
    const changed = applied([
      { type: "walkthrough.update", overview: markdown },
      { ...third, overview: markdown },
      { type: "group.update", id: "g2", overview: markdown },
      {
        type: "note.create",
        id: "n2",
        group: "g2",
        anchor: range("b.ts", "new", 1),
        markdown,
      },
      { type: "note.update", id: "n1", markdown },
    ]);
    const references = [pin(range("support.ts", "new", 2, 4)), pin(range("a.ts", "old", 10))];
    const texts = [
      changed.overview,
      ...changed.groups.flatMap((group) => [group.overview, ...group.notes]),
    ];
    // g1's untouched overview has none.
    expect(texts.map((text) => text?.references)).toEqual([
      references,
      [],
      references,
      references,
      references,
      references,
    ]);
    // The pins travel in status and survive a reload.
    expect(statusOf(changed).groups[1]?.notes[0]?.references).toEqual(references);
    expect(Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(changed)))).toEqual(
      changed,
    );
    expect(
      capturedTargetsOf(
        batch([
          { type: "walkthrough.update", overview: markdown },
          { type: "group.update", id: "g1", overview: "[x](gyst:new/b.ts#L1)" },
          { type: "group.update", id: "g1", overview: null },
          { type: "note.update", id: "n1", markdown: "[x](gyst:old/live.ts#L1)" },
        ]),
        session,
      ),
    ).toEqual([
      { path: "support.ts", side: "new" },
      { path: "a.ts", side: "old" },
      { path: "b.ts", side: "new" },
      { path: "live.ts", side: "old" },
    ]);
  });

  it("rejects references outside the captured snapshot and links the policy refuses", () => {
    for (const [href, message] of [
      ["gyst:new/live.ts#L1", "live.ts is not in the captured snapshot"],
      ["gyst:new/unindexed.ts#L1", "unindexed.ts is not in the captured snapshot"],
      ["gyst:old/added.ts#L1", "the old side of added.ts does not exist"],
      ["gyst:new/image.png#L1", "the new side of image.png is binary, not captured text"],
      [
        "gyst:new/support.ts#L5-L6",
        "lines 5-6 are outside the new side of support.ts, which has 5 lines",
      ],
    ] as const) {
      const markdown = `See [this](${href}).`;
      for (const op of [
        { type: "walkthrough.update", overview: markdown },
        { ...third, overview: markdown },
        { type: "group.update", id: "g1", overview: markdown },
        { type: "note.update", id: "n1", markdown },
        { type: "note.create", id: "n", group: "g1", anchor: range("a.ts", "new", 2), markdown },
      ] satisfies ApplyOp[]) {
        const ops = op.type === "group.create" ? [op] : [third, op];
        expect(rejected(ops).detail, `${op.type} ${href}`).toEqual([
          { opIndex: ops.length - 1, message: `reference ${href}: ${message}` },
        ]);
      }
    }
    expect(
      rejected([
        { type: "walkthrough.update", overview: "![logo](https://example.com/x.png)" },
        { type: "note.update", id: "n1", markdown: "[x](javascript:alert(1))" },
        {
          type: "group.update",
          id: "g1",
          overview: "Fine.\n\n```mermaid\n%%{init: {}}%%\ngraph TD\n```",
        },
      ]).detail,
    ).toEqual([
      { opIndex: 0, message: "line 1: images are not allowed" },
      {
        opIndex: 1,
        message:
          'line 1: link "javascript:alert(1)" must be an absolute http(s) URL or a gyst: reference',
      },
      { opIndex: 2, message: "line 3: Mermaid diagrams may not carry %%{ }%% directives" },
    ]);
  });

  it("keeps the pins of untouched and rewritten-identical texts instead of rebinding them", () => {
    const older = { snapshotId: "older", ...range("gone.ts", "new", 1) };
    const pinned: Session = {
      ...session,
      overview: { markdown: "See [gone](gyst:new/gone.ts#L1).", references: [older] },
      groups: session.groups.map((group, index) =>
        index === 0
          ? { ...group, overview: { markdown: "[g](gyst:new/gone.ts#L1)", references: [older] } }
          : group,
      ),
    };
    const edited = applied(
      [
        { type: "note.update", id: "n1", markdown: "[s](gyst:new/support.ts#L1)" },
        { type: "walkthrough.update", overview: "See [gone](gyst:new/gone.ts#L1)." },
        { type: "group.update", id: "g1", title: "Renamed" },
      ],
      pinned,
    );
    expect(edited.overview?.references).toEqual([older]);
    expect(edited.groups[0]?.overview?.references).toEqual([older]);
    expect(edited.groups[0]?.notes[0]?.references).toEqual([pin(range("support.ts", "new", 1))]);
    // Rewriting that text re-derives its pins from the current snapshot, which lacks gone.ts.
    expect(
      rejected(
        [{ type: "walkthrough.update", overview: "Now [gone](gyst:new/gone.ts#L1)!" }],
        pinned,
      ).detail,
    ).toEqual([
      {
        opIndex: 0,
        message: "reference gyst:new/gone.ts#L1: gone.ts is not in the captured snapshot",
      },
    ]);
  });

  it("keeps authoring pins through a refresh to a new snapshot and later unrelated edits", () => {
    const markdown = "Read [the helper](gyst:new/support.ts#L1-L2) first.";
    const published = applied([
      { type: "walkthrough.update", overview: markdown },
      { type: "group.update", id: "g1", overview: markdown },
    ]);
    // Nothing captured maps the pins onto "next", so the texts turn Outdated with their pins kept.
    const refreshed = refreshSession(
      published,
      { snapshotId: "next", snapshot: { files: [], hunks } },
      new Map(),
      LATER,
    );
    const authored = [pin(range("support.ts", "new", 1, 2))];
    expect(refreshed.overview?.references).toEqual(authored);
    expect(refreshed.groups[0]?.overview?.references).toEqual(authored);
    const later = Result.getOrThrow(
      applyBatch(
        refreshed,
        {
          ...batch([{ type: "group.update", id: "g2", overview: "Second." }], "later"),
          revision: refreshed.revision,
          snapshotId: "next",
        },
        { snapshotId: "next", sides: new Map() },
        LATER,
      ),
    ).session!;
    expect(later.overview?.references).toEqual(authored);
    expect(later.groups[0]?.overview?.references).toEqual(authored);
    expect(later.groups[1]?.overview?.references).toEqual([]);
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
      overviewOutdated: false,
      groupsOutdated: [],
      notesOutdated: [],
    });
    expect(statusOf(session).preparation).toEqual({
      state: "incomplete",
      groupedHunks: 4,
      totalHunks: 5,
      overviewMissing: false,
      groupsMissingOverview: ["g2"],
      overviewOutdated: false,
      groupsOutdated: [],
      notesOutdated: [],
    });
    const complete = applied([third, { type: "group.update", id: "g2", overview: "Second." }]);
    expect(statusOf(complete).preparation).toEqual({
      state: "complete",
      groupedHunks: 5,
      totalHunks: 5,
      overviewMissing: false,
      groupsMissingOverview: [],
      overviewOutdated: false,
      groupsOutdated: [],
      notesOutdated: [],
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

describe("Outdated guidance", () => {
  const earlier = (range: CodeRange) => ({ snapshotId: "earlier", ...range });
  const link = "Read [the helper](gyst:new/support.ts#L1-L2).";
  // As a refresh leaves it: pins to the replaced snapshot and an anchor that no longer maps.
  const outdated: Session = {
    ...session,
    overview: {
      markdown: link,
      references: [earlier(range("support.ts", "new", 1, 2))],
      outdated: ["code"],
    },
    groups: [
      {
        ...session.groups[0]!,
        overview: { ...text("First group."), outdated: ["code"] },
        notes: [
          { ...note("n1", range("a.ts", "new", 2)), outdated: ["references"] },
          {
            ...note("gone", range("a.ts", "new", 40)),
            anchor: earlier(range("a.ts", "new", 40)),
            outdated: ["code"],
          },
        ],
      },
      session.groups[1]!,
    ],
  };

  it("revalidates unchanged wording against the batch's snapshot without touching Viewed", () => {
    const ops: ApplyOp[] = [
      { type: "walkthrough.revalidate" },
      { type: "group.revalidate", id: "g1" },
      { type: "note.revalidate", id: "n1" },
    ];
    const revalidated = applied(ops, outdated);
    expect(revalidated.overview).toEqual({
      markdown: link,
      references: [pin(range("support.ts", "new", 1, 2))],
    });
    expect(revalidated.groups[0]!.overview).toEqual(text("First group."));
    expect(revalidated.groups[0]!.notes[0]).toEqual(note("n1", range("a.ts", "new", 2)));
    expect(unviewedBy(ops, outdated)).toEqual([]);
    expect(capturedTargetsOf(batch(ops), outdated)).toEqual([{ path: "support.ts", side: "new" }]);
    // The note still anchored to the replaced snapshot keeps the walkthrough incomplete.
    expect(statusOf(revalidated).preparation).toMatchObject({
      state: "incomplete",
      overviewOutdated: false,
      groupsOutdated: [],
      notesOutdated: ["gone"],
    });
  });

  it("re-anchors a note in place, unviewing its new hunks, before it can be revalidated", () => {
    expect(rejected([{ type: "note.revalidate", id: "gone" }], outdated).detail).toEqual([
      {
        opIndex: 0,
        message: "note gone is anchored to an earlier snapshot; re-anchor it with note.update",
      },
    ]);
    const ops: ApplyOp[] = [
      { type: "note.update", id: "gone", anchor: range("a.ts", "new", 11) },
      { type: "note.revalidate", id: "gone" },
    ];
    const reanchored = applied(ops, outdated);
    expect(reanchored.groups[0]!.notes.map(({ id }) => id)).toEqual(["n1", "gone"]);
    expect(reanchored.groups[0]!.notes[1]).toEqual(note("gone", range("a.ts", "new", 11)));
    expect(unviewedBy(ops, outdated)).toEqual(["a2"]);
  });

  it("never verifies unavailable context or guidance that is not Outdated", () => {
    const unavailable: Session = {
      ...outdated,
      overview: {
        markdown: "See [the image](gyst:new/image.png#L1) and [live](gyst:new/live.ts#L1).",
        references: [],
        outdated: ["references"],
      },
    };
    expect(rejected([{ type: "walkthrough.revalidate" }], unavailable).detail).toEqual([
      {
        opIndex: 0,
        message:
          "reference gyst:new/image.png#L1: the new side of image.png is binary, not captured text",
      },
      {
        opIndex: 0,
        message: "reference gyst:new/live.ts#L1: live.ts is not in the captured snapshot",
      },
    ]);
    expect(rejected([{ type: "group.revalidate", id: "g2" }], outdated).detail).toEqual([
      { opIndex: 0, message: "the overview of group g2 does not exist" },
    ]);
    expect(rejected([{ type: "note.revalidate", id: "n1" }]).detail).toEqual([
      { opIndex: 0, message: "note n1 is not Outdated" },
    ]);
    // A newer snapshot than the one the agent checked conflicts.
    const stale = applyBatch(
      outdated,
      { ...batch([{ type: "walkthrough.revalidate" }]), snapshotId: "earlier" },
      captured,
      LATER,
    );
    expect(Result.getOrThrow(Result.flip(stale))._tag).toBe("stale_revision");
  });

  it("keeps Outdated through unrelated edits, and an edit of the wording clears it", () => {
    const unrelated = applied([{ type: "group.update", id: "g2", overview: "Second." }], outdated);
    expect(unrelated.overview?.outdated).toEqual(["code"]);
    expect(unrelated.groups[0]!.notes[1]!.outdated).toEqual(["code"]);
    const same = applied(
      [
        { type: "walkthrough.update", overview: link },
        { type: "note.update", id: "n1", markdown: "About n1." },
      ],
      outdated,
    );
    expect(same.overview?.outdated).toEqual(["code"]);
    expect(same.groups[0]!.notes[0]!.outdated).toEqual(["references"]);
    const rewritten = applied(
      [
        { type: "walkthrough.update", overview: "Rewritten." },
        { type: "note.update", id: "n1", markdown: "Rewritten n1." },
      ],
      outdated,
    );
    expect(rewritten.overview).toEqual(text("Rewritten."));
    expect(rewritten.groups[0]!.notes[0]).toEqual(
      note("n1", range("a.ts", "new", 2), "Rewritten n1."),
    );
  });
});
