import { expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { type ApplyEnvelope, ApplyEnvelopeSchema, applyBatch } from "./apply.ts";
import { applyHumanAction } from "./human-action.ts";
import { refreshSession } from "./refresh.ts";
import { sanitizeOverview } from "./metadata.ts";
import { HunkSchema, SessionSchema, type StatusPayload } from "./session.ts";

const decode = Schema.decodeUnknownSync(ApplyEnvelopeSchema, { onExcessProperty: "error" });
const hunk = (id: string) => ({
  id,
  file: `${id}.ts`,
  header: "@@ -1 +1 @@",
  patch: "-a\n+b",
  contentHash: id,
  accepted: false,
});
const initial = () =>
  Schema.decodeUnknownSync(SessionSchema)({
    formatVersion: 1,
    id: "session",
    repoRoot: "/repo",
    source: { kind: "stdin" },
    createdAt: "now",
    updatedAt: "now",
    revision: 0,
    seq: 0,
    cursor: { itemId: "g", expanded: false },
    hunks: [hunk("a"), hunk("b"), hunk("c")],
    groups: [],
    queue: [],
    queueSet: false,
    acceptHistory: [],
    receiptOverviews: [],
    applyReceipts: [],
  });
const group = {
  type: "group.create",
  id: "g",
  title: "API and tests",
  overview: "Intent and evidence",
  memberHunkIds: ["b", "a"],
};
const envelope = (ops: unknown[], revision = 0, idempotencyKey = "first") =>
  decode({ revision, idempotencyKey, ops });

it("publishes complete ordered items progressively without losing verdicts or replaying state", () => {
  const firstBatch = envelope([group, { type: "queue.set", itemIds: ["g"] }]);
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
        type: "hunk.annotate",
        hunkId: "c",
        title: "Independent fix",
        overview: "Before and after",
      },
      { type: "queue.set", itemIds: ["g", "c"] },
    ],
    accepted.revision,
    "second",
  );
  const next = Result.getOrThrow(applyBatch(accepted, nextBatch, "later"));
  expect(next.status).toMatchObject({
    ready: true,
    queue: ["g", "c"],
    cursor: accepted.cursor,
    groups: [{ accepted: true, hunkIds: ["b", "a"] }],
  });
  expect(
    Result.isFailure(
      applyBatch(next.session!, { ...nextBatch, revision: 1, idempotencyKey: "stale" }, "later"),
    ),
  ).toBe(true);
  expect(Result.getOrThrow(applyBatch(next.session!, firstBatch, "later"))).toEqual({
    status: first.status,
  });
  expect(Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(next.session)))).toEqual(
    next.session!,
  );
  const refreshed = refreshSession(next.session!, [hunk("b"), hunk("c")], "later");
  expect(refreshed.groups[0]).toMatchObject({
    title: group.title,
    overview: group.overview,
    hunkIds: ["b"],
    accepted: false,
  });
  expect(refreshed.acceptHistory).toEqual([]);
});

it("stores each receipt overview once and replays exact historical statuses after edits", () => {
  const count = 50;
  const overview = (index: number) => `overview-${index}-`.padEnd(1024, "x");
  let session = Schema.decodeUnknownSync(SessionSchema)({
    ...initial(),
    cursor: { itemId: null, expanded: false },
    hunks: Array.from({ length: count }, (_, index) => hunk(`h${index}`)),
  });
  const published: string[] = [];
  const envelopes: ApplyEnvelope[] = [];
  const statuses: StatusPayload[] = [];
  for (let index = 0; index < count; index++) {
    published.push(`h${index}`);
    const batch = envelope(
      [
        {
          type: "hunk.annotate",
          hunkId: `h${index}`,
          title: `item ${index}`,
          overview: overview(index),
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
  // Each overview appears in the current hunk and once in the receipt table; never once per receipt.
  const json = JSON.stringify(session);
  for (let index = 0; index < count; index++)
    expect(json.split(`overview-${index}-`).length - 1).toBe(2);
  expect(session.applyReceipts).toHaveLength(count);

  const moved = Result.getOrThrow(
    applyHumanAction(session, { type: "cursor.move", itemId: "h3" }, "later"),
  );
  const accepted = Result.getOrThrow(
    applyHumanAction(
      moved,
      { type: "verdict.toggle", itemId: "h3", sessionId: "session", revision: moved.revision },
      "later",
    ),
  );
  const edited = Result.getOrThrow(
    applyBatch(
      accepted,
      envelope(
        [{ type: "hunk.annotate", hunkId: "h0", title: "item 0", overview: "rewritten" }],
        accepted.revision,
        "edit",
      ),
      "later",
    ),
  ).session!;
  const reloaded = Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(edited)));
  expect(reloaded).toEqual(edited);
  for (const index of [0, count - 1]) {
    expect(applyBatch(reloaded, envelopes[index]!, "later")).toEqual(
      Result.succeed({ status: statuses[index]! }),
    );
  }
  expect(statuses[count - 1]!.spotlight[0]?.overview).toBe(overview(0));
  expect(reloaded.hunks[0]?.overview).toBe("rewritten");
  expect(reloaded.hunks[3]).toMatchObject({ accepted: true });
  expect(reloaded.cursor).toEqual({ itemId: "h3", expanded: false });

  // Interned text must retain the same validation as the wire overview it reconstructs.
  for (const invalid of ["", "x".repeat(64 * 1024 + 1)]) {
    expect(() =>
      Schema.decodeUnknownSync(SessionSchema)({
        ...edited,
        receiptOverviews: [invalid, ...edited.receiptOverviews.slice(1)],
      }),
    ).toThrow();
  }

  // A persisted reference outside the overview table must not decode into an undefined wire overview.
  const receipt = edited.applyReceipts[0]!;
  for (const overviewRef of [-1, 1.5, edited.receiptOverviews.length]) {
    const corrupt = {
      ...edited,
      applyReceipts: [
        {
          ...receipt,
          status: {
            ...receipt.status,
            spotlight: [{ ...receipt.status.spotlight[0]!, overview: overviewRef }],
          },
        },
      ],
    };
    expect(() =>
      Schema.decodeUnknownSync(SessionSchema)(JSON.parse(JSON.stringify(corrupt))),
    ).toThrow();
  }
});

it("validates Unicode title/UTF-8 overview bounds, paired metadata and legacy fields", () => {
  for (const title of [
    "",
    " ",
    "x\ny",
    "x\ty",
    "\u001b[31m",
    "\u009b31m",
    "x\u2028y",
    "😀".repeat(121),
  ]) {
    expect(() => envelope([{ ...group, title }])).toThrow();
  }
  for (const overview of ["", " ", "é".repeat(32769)])
    expect(() => envelope([{ ...group, overview }])).toThrow();
  expect(() =>
    envelope([{ ...group, title: "😀".repeat(120), overview: "é".repeat(32768) }]),
  ).not.toThrow();
  for (const field of ["tldr", "exemplarHunkId"]) {
    expect(() => envelope([{ type: "group.update", id: "g", [field]: "old" }])).toThrow();
    expect(() => envelope([{ ...group, [field]: "old" }])).toThrow();
  }
  for (const metadata of [{ title: "only" }, { overview: "only" }])
    expect(() => Schema.decodeUnknownSync(HunkSchema)({ ...hunk("a"), ...metadata })).toThrow();
});

it("neutralizes terminal controls while preserving Markdown and ordinary code fences", () => {
  const markdown =
    "# Intent\n\n| before | after |\n| --- | --- |\n| a | b |\n\n```mermaid\nA --> B\n```\n\tcode";
  expect(sanitizeOverview(markdown)).toBe(markdown);
  const unsafe = "\u001b[31mred\u0007\u009b0m\r\u202e";
  expect(sanitizeOverview(unsafe)).toBe("[31mred0m");
  expect(() => envelope([{ ...group, overview: "\u0007\u001b\u009b" }])).toThrow();
});

it("rejects duplicate members and incomplete queues atomically", () => {
  const before = initial();
  for (const ops of [
    [{ ...group, memberHunkIds: ["a", "a"] }],
    [group, { type: "queue.set", itemIds: [] }],
  ])
    expect(Result.isFailure(applyBatch(before, envelope(ops), "later"))).toBe(true);
  expect(before).toEqual(initial());
});
