import { expect, it } from "bun:test";
import { Result, Schema } from "effect";
import { ApplyEnvelopeSchema, applyBatch } from "./apply.ts";
import { applyHumanAction } from "./human-action.ts";
import { refreshSession } from "./refresh.ts";
import { sanitizeOverview } from "./metadata.ts";
import { HunkSchema, SessionSchema } from "./session.ts";

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
