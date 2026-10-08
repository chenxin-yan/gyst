import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ExportPreviewPayload } from "@gyst/core";
import { Effect } from "effect";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { disclosureOf, writeNewFile } from "./export.ts";

const S1 = "1".repeat(64);
const S0 = "0".repeat(64);
const preview: ExportPreviewPayload = {
  sessionId: "s1",
  snapshotId: S1,
  revision: 3,
  preparation: {
    state: "complete",
    groupedHunks: 1,
    totalHunks: 1,
    overviewMissing: false,
    groupsMissingOverview: [],
    overviewOutdated: false,
    groupsOutdated: [],
    notesOutdated: [],
  },
  approval: "a".repeat(64),
  scope: { kind: "uncommitted" },
  provenance: { kind: "uncommitted", head: null },
  included: [
    { snapshotId: S1, path: "a.ts", side: "old", content: { kind: "absent" } },
    {
      snapshotId: S1,
      path: "a.ts",
      side: "new",
      content: { kind: "text", blob: "b".repeat(64), size: 12 },
    },
    {
      snapshotId: S0,
      path: "helper.ts",
      side: "new",
      content: { kind: "text", blob: "c".repeat(64), size: 3 },
    },
  ],
  unavailable: [
    {
      target: { snapshotId: S1, path: "logo.png", side: "new", startLine: 1, endLine: 2 },
      reason: "new side not captured: binary",
    },
  ],
};

describe("disclosureOf", () => {
  it("lists every included side with its identity, the unavailable targets and the warning", () => {
    expect(disclosureOf(preview, "/out/w.html").split("\n")).toEqual([
      "gyst would write a standalone walkthrough to /out/w.html",
      "  Scope: uncommitted changes, untracked files included",
      "  Old side: an empty baseline; the repository had no commits",
      "  New side: the working tree as captured, which no commit identifies",
      `  Snapshot: ${S1}`,
      "",
      "Included in full (3 file sides):",
      "  a.ts (old): absent",
      `  a.ts (new): sha256 ${"b".repeat(64)} (12 bytes)`,
      `  helper.ts (new, earlier snapshot ${S0}): sha256 ${"c".repeat(64)} (3 bytes)`,
      "",
      "Unavailable references, shown in the file with their reason:",
      `  logo.png:1-2 (new, snapshot ${S1}): new side not captured: binary`,
      "",
      "WARNING: the file contains every file above in full and all of the walkthrough's guidance.",
      "Full files and guidance may disclose secrets or confidential content. Check them before you",
      "share the file; gyst does not scan or redact anything.",
      "",
    ]);
  });

  it("shows a hostile file name's terminal controls as escapes, so it cannot hide or forge any other line", () => {
    const hostile = "z\u001b[2J\u001b[H\rb.ts\n  forged.ts (new): absent\u202e\u0085\u2028";
    const shown = disclosureOf(
      {
        ...preview,
        included: [{ snapshotId: S1, path: hostile, side: "new", content: { kind: "absent" } }],
        unavailable: [
          {
            target: { snapshotId: S1, path: hostile, side: "new", startLine: 1, endLine: 1 },
            reason: "absent on the new side",
          },
        ],
      },
      "/out/\u001b[8mw.html",
    );
    // eslint-disable-next-line no-control-regex -- the controls a terminal would act on
    const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
    expect(shown).not.toMatch(controls);
    const escaped = String.raw`z\u001b[2J\u001b[H\u000db.ts\u000a  forged.ts (new): absent\u202e\u0085\u2028`;
    expect(shown.split("\n")).toEqual(
      expect.arrayContaining([
        String.raw`gyst would write a standalone walkthrough to /out/\u001b[8mw.html`,
        `  ${escaped} (new): absent`,
        `  ${escaped}:1-1 (new, snapshot ${S1}): absent on the new side`,
      ]),
    );
    expect(shown.split("\n").filter((line) => line.includes("forged.ts"))).toHaveLength(2);
  });
});

describe("writeNewFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gyst-export-write-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const write = (path: string, text: string) =>
    Effect.runPromise(
      Effect.flip(writeNewFile(path, text)).pipe(
        Effect.map((error) => ({ error })),
        Effect.orElseSucceed(() => ({ error: undefined })),
        Effect.provide(NodeServices.layer),
      ),
    );

  it("writes the whole file and leaves nothing else behind", async () => {
    expect(await write(join(dir, "w.html"), "<!doctype html>whole")).toEqual({ error: undefined });
    expect(await readFile(join(dir, "w.html"), "utf8")).toBe("<!doctype html>whole");
    expect(await readdir(dir)).toEqual(["w.html"]);
  });

  it("never replaces an existing file and reports a failed write as failed, writing nothing", async () => {
    await writeFile(join(dir, "kept.html"), "the human's own file");
    expect((await write(join(dir, "kept.html"), "export")).error).toMatchObject({
      _tag: "bad_args",
      message: `${join(dir, "kept.html")} already exists; choose another --output. Nothing was written.`,
    });
    expect(await readFile(join(dir, "kept.html"), "utf8")).toBe("the human's own file");
    expect((await write(join(dir, "missing", "w.html"), "export")).error).toMatchObject({
      _tag: "bad_args",
      message: `could not write ${join(dir, "missing", "w.html")}. Nothing was written.`,
    });
    expect((await readdir(dir)).sort()).toEqual(["kept.html", "w.html"]);
  });
});
