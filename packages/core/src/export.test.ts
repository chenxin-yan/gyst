import { Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { ManifestFile, SnapshotManifest } from "./content.ts";
import {
  disclosedSides,
  exportPlanOf,
  exportSnapshotIds,
  provenanceLines,
  readinessProblems,
  type Walkthrough,
  WalkthroughExportSchema,
} from "./export.ts";
import type { CapturedRange, Note } from "./guidance.ts";
import { approvalOf } from "./hash.ts";
import type { Group, Session } from "./session.ts";
import { parseSnapshot } from "./snapshot.ts";

const id = (name: string) => name.padEnd(64, "0");
const text = (name: string) => ({ kind: "text" as const, blob: id(name), size: name.length });
const S1 = id("51");
const S0 = id("50");

const changeA = "@@ -9,3 +9,3 @@\n l9\n-l10\n+L10\n l11";
const changeB = "@@ -4,3 +4,3 @@\n m4\n-m5\n+M5\n m6";
const hunks = Result.getOrThrow(
  parseSnapshot(
    Object.entries({ "a.ts": changeA, "b.ts": changeB })
      .map(
        ([path, body]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`,
      )
      .join(""),
  ),
);
const [hunkA, hunkB] = hunks.map((hunk) => hunk.id) as [string, string];

const file = (path: string, old: ManifestFile["old"], current: ManifestFile["new"]) =>
  ({ path, old, new: current }) satisfies ManifestFile;
/** a.ts and b.ts change; helper.ts and other.ts are unchanged supporting code; logo.bin is binary. */
const current: SnapshotManifest = {
  scope: { kind: "range", range: "main...topic" },
  provenance: {
    kind: "range",
    base: "a".repeat(40),
    head: "b".repeat(40),
    mergeBase: "c".repeat(40),
  },
  files: [
    file("a.ts", text("a0"), text("a1")),
    file("b.ts", text("b0"), text("b1")),
    file("helper.ts", text("c0"), text("c0")),
    file(
      "logo.bin",
      { kind: "unavailable", reason: "binary" },
      { kind: "unavailable", reason: "binary" },
    ),
    file("other.ts", text("d0"), text("d0")),
  ],
  hunks,
};
/** The earlier snapshot a retained reference pins: old.ts changed there, so its sides differ. */
const earlier: SnapshotManifest = {
  ...current,
  files: [file("old.ts", text("e0"), text("e1")), file("gone.ts", text("f0"), { kind: "absent" })],
};
const manifests = new Map([
  [S1, current],
  [S0, earlier],
]);

const pin = (path: string, side: "old" | "new", line: number, snapshotId = S1) =>
  ({ snapshotId, path, side, startLine: line, endLine: line }) satisfies CapturedRange;
const note = (noteId: string, anchor: CapturedRange, references: CapturedRange[] = []): Note => ({
  id: noteId,
  anchor,
  markdown: `About ${noteId}.`,
  references,
});
const group = (groupId: string, hunkIds: string[], path: string, notes: Note[]): Group => ({
  id: groupId,
  title: groupId,
  overview: { markdown: `Group ${groupId}.`, references: [] },
  hunkIds,
  files: [path],
  notes,
});

function session(): Session {
  return {
    id: "session-secret-id",
    repoRoot: "/home/someone/private-checkout",
    scope: current.scope,
    snapshotId: S1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    revision: 4,
    hunks,
    overview: {
      markdown: "The walkthrough.",
      references: [pin("old.ts", "new", 1, S0), pin("gone.ts", "new", 1, S0)],
    },
    groups: [
      group("ga", [hunkA], "a.ts", [
        note("na", pin("a.ts", "new", 10), [pin("helper.ts", "new", 2)]),
      ]),
      group("gb", [hunkB], "b.ts", [
        note("nb", pin("b.ts", "new", 5), [pin("logo.bin", "new", 1)]),
      ]),
    ],
    viewedHunkIds: [hunkA],
    receiptTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
    refreshReceipts: [],
    threads: [
      {
        id: "thread-secret",
        anchor: pin("a.ts", "new", 10),
        resolved: false,
        messages: [],
      },
    ],
    drafts: [],
    conversationReceipts: [],
    pickupReceipts: [],
  };
}

const ready = (from: Session = session()) => {
  const plan = exportPlanOf(from, manifests);
  if (plan.walkthrough === undefined) throw new Error("expected a ready walkthrough");
  return { ...plan, walkthrough: plan.walkthrough };
};

describe("exportPlanOf", () => {
  it("reads the current snapshot and every snapshot guidance pins", () => {
    expect(exportSnapshotIds(session())).toEqual([S1, S0]);
  });

  it("includes every changed file whole, the files guidance names and only the pinned earlier sides", () => {
    const { walkthrough, unavailable } = ready();
    expect(walkthrough.files.map(({ path }) => path)).toEqual([
      "a.ts",
      "b.ts",
      "helper.ts",
      "logo.bin",
    ]);
    expect(walkthrough.pinned).toEqual([
      { snapshotId: S0, path: "gone.ts", side: "new", content: { kind: "absent" } },
      { snapshotId: S0, path: "old.ts", side: "new", content: text("e1") },
    ]);
    expect(disclosedSides(walkthrough).map(({ path, side }) => `${path}:${side}`)).toEqual([
      "a.ts:old",
      "a.ts:new",
      "b.ts:old",
      "b.ts:new",
      "helper.ts:old",
      "helper.ts:new",
      "logo.bin:old",
      "logo.bin:new",
      "gone.ts:new",
      "old.ts:new",
    ]);
    // Disclosed with their reasons, and pinned where they were authored, never dropped or moved.
    expect(unavailable).toEqual([
      { target: pin("gone.ts", "new", 1, S0), reason: "absent on the new side" },
      { target: pin("logo.bin", "new", 1), reason: "new side not captured: binary" },
    ]);
  });

  it("lists a target its snapshot lacks as unavailable without including anything for it", () => {
    const base = session();
    const missing = pin("nowhere.ts", "old", 3);
    const { walkthrough, unavailable } = ready({
      ...base,
      overview: { markdown: "The walkthrough.", references: [missing] },
    });
    expect(walkthrough.files.some(({ path }) => path === "nowhere.ts")).toBe(false);
    expect(unavailable).toContainEqual({ target: missing, reason: "not in its snapshot" });
  });

  it("carries guidance, diff, scope and provenance, and nothing private of the session", () => {
    const { walkthrough } = ready();
    expect(Object.keys(walkthrough).sort()).toEqual(
      [
        "files",
        "groups",
        "hunks",
        "overview",
        "pinned",
        "provenance",
        "scope",
        "snapshotId",
      ].sort(),
    );
    expect(walkthrough.provenance).toEqual(current.provenance);
    const json = JSON.stringify(walkthrough);
    for (const secret of ["session-secret-id", "private-checkout", "thread-secret", "2026-01-0"])
      expect(json).not.toContain(secret);
  });

  it("refuses a walkthrough that is not ready, without a partial or Outdated override", () => {
    const base = session();
    const [ga, gb] = base.groups as [Group, Group];
    const refusals: [Partial<Session>, string][] = [
      [{ overview: null, groups: [] }, "the session has no walkthrough"],
      [{ groups: [ga] }, "1 of 2 changed hunks are in no group"],
      [{ overview: null }, "the walkthrough overview is missing"],
      [{ groups: [ga, { ...gb, overview: null }] }, "groups without an overview: gb"],
      [
        { overview: { markdown: "Old.", references: [], outdated: ["code"] } },
        "the walkthrough overview is Outdated",
      ],
      [
        { groups: [ga, gb, { ...gb, id: "empty", hunkIds: [], notes: [] }] },
        "Outdated or emptied groups: empty",
      ],
      [
        {
          groups: [ga, { ...gb, notes: [{ ...gb.notes[0]!, outdated: ["references"] }] }],
        },
        "Outdated notes: nb",
      ],
      [
        { groups: [ga, { ...gb, hunkIds: [hunkA, hunkB] }] },
        "a changed hunk is in more than one group",
      ],
    ];
    for (const [change, problem] of refusals) {
      const plan = exportPlanOf({ ...base, ...change }, manifests);
      expect(plan.walkthrough).toBeUndefined();
      expect(readinessProblems(plan.preparation)).toContain(problem);
    }
    expect(readinessProblems(ready().preparation)).toEqual([]);
  });
});

describe("approvalOf", () => {
  const approved = approvalOf(ready().walkthrough);

  it("names the state, so the same walkthrough is approved again and any change is not", () => {
    expect(approved).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalOf(ready().walkthrough)).toBe(approved);
    // Viewed and conversations are not part of what an export shares.
    expect(approvalOf(ready({ ...session(), viewedHunkIds: [], threads: [] }).walkthrough)).toBe(
      approved,
    );
    const base = session();
    const changed: Walkthrough[] = [
      ready({ ...base, overview: { ...base.overview!, markdown: "Reworded." } }).walkthrough,
      { ...ready().walkthrough, hunks: ready().walkthrough.hunks.slice(1) },
      { ...ready().walkthrough, snapshotId: id("52") },
      {
        ...ready().walkthrough,
        files: ready().walkthrough.files.map((entry) =>
          entry.path === "helper.ts" ? { ...entry, new: text("c1") } : entry,
        ),
      },
    ];
    for (const walkthrough of changed) expect(approvalOf(walkthrough)).not.toBe(approved);
  });
});

describe("WalkthroughExportSchema", () => {
  const { walkthrough } = ready();
  const blobs = disclosedSides(walkthrough).flatMap(({ content }) =>
    content.kind === "text" ? [content.blob] : [],
  );
  const contents = Object.fromEntries(blobs.map((blob) => [blob, `text of ${blob}`]));
  const decode = Schema.decodeUnknownSync(WalkthroughExportSchema, { onExcessProperty: "error" });
  const stamp = { gyst: "0.1.2", exportedAt: "2026-03-01T00:00:00.000Z" };

  it("carries the text of exactly the text sides it discloses", () => {
    expect(decode({ ...stamp, walkthrough, contents })).toEqual({
      ...stamp,
      walkthrough,
      contents,
    });
    const [first, ...rest] = blobs;
    expect(() =>
      decode({ ...stamp, walkthrough, contents: Object.fromEntries(rest.map((b) => [b, ""])) }),
    ).toThrow();
    expect(() =>
      decode({ ...stamp, walkthrough, contents: { ...contents, [id("ff")]: "unrelated" } }),
    ).toThrow();
    expect(first).toBeDefined();
  });

  it("refuses session state it never carries", () => {
    expect(() =>
      decode({ ...stamp, walkthrough: { ...walkthrough, threads: [] }, contents }),
    ).toThrow();
    expect(() => decode({ ...stamp, walkthrough, contents, repoRoot: "/x" })).toThrow();
  });
});

describe("provenanceLines", () => {
  const [base, head, mergeBase] = ["a", "b", "c"].map((c) => c.repeat(40)) as [
    string,
    string,
    string,
  ];
  it("states each scope's resolved identities, and never a commit for captured working-tree bytes", () => {
    expect(
      provenanceLines(
        { kind: "range", range: "main..topic" },
        {
          kind: "range",
          base,
          head,
          mergeBase: null,
        },
      ),
    ).toEqual(["Scope: Git range main..topic", `Old side: ${base}`, `New side: ${head}`]);
    expect(
      provenanceLines(
        { kind: "range", range: "main...topic" },
        {
          kind: "range",
          base,
          head,
          mergeBase,
        },
      ),
    ).toEqual([
      "Scope: Git range main...topic",
      `Old side: merge base ${mergeBase} of ${base}`,
      `New side: ${head}`,
    ]);
    expect(
      provenanceLines(
        { kind: "pr", repository: "acme/widgets", number: 7 },
        {
          kind: "pr",
          base,
          head,
          mergeBase,
        },
      ),
    ).toEqual([
      "Scope: GitHub PR acme/widgets#7",
      `Old side: merge base ${mergeBase} of base ${base}`,
      `New side: head ${head}`,
    ]);
    expect(provenanceLines({ kind: "uncommitted" }, { kind: "uncommitted", head })).toEqual([
      "Scope: uncommitted changes, untracked files included",
      `Old side: HEAD ${head}`,
      "New side: the working tree as captured, which no commit identifies",
    ]);
    expect(provenanceLines({ kind: "uncommitted" }, { kind: "uncommitted", head: null })).toEqual([
      "Scope: uncommitted changes, untracked files included",
      "Old side: an empty baseline; the repository had no commits",
      "New side: the working tree as captured, which no commit identifies",
    ]);
  });
});
