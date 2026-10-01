import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Session, statusOf } from "@gyst/core";
import { ConfigProvider, Effect, Layer } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "./paths.ts";
import { inspectSavedSessions, SessionStore } from "./store.ts";

let dataDir: string;

const session = (id: string): Session => ({
  id,
  repoRoot: "/repo",
  scope: { kind: "uncommitted" },
  snapshotId: "snapshot",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
  hunks: [],
  groups: [],
  viewedHunkIds: [],
  receiptNoteTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
});

const run = <A, E>(effect: Effect.Effect<A, E, SessionStore>) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      SessionStore.layer.pipe(
        Layer.provide(Paths.layer),
        Layer.provide(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir }))),
      ),
    ),
  );

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-store-"));
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe("SessionStore", () => {
  it("saves atomically with owner-only permissions and leaves no temp files behind", async () => {
    await run(SessionStore.use((s) => s.save(session("a"))));
    expect((await stat(join(dataDir, "a.json"))).mode & 0o777).toBe(0o600);
    await mkdir(join(dataDir, "blocked.json"));
    const error = await run(Effect.flip(SessionStore.use((s) => s.save(session("blocked")))));
    expect(error._tag).toBe("PlatformError");
    expect((await readdir(dataDir)).sort()).toEqual(["a.json", "blocked.json"]);
    await rm(join(dataDir, "blocked.json"), { recursive: true });
  });

  it("skips undecodable session files but keeps the valid ones", async () => {
    await writeFile(join(dataDir, "corrupt.json"), "{not json");
    await writeFile(join(dataDir, "wrong-shape.json"), JSON.stringify({ id: "x" }));
    // The schema is the contract: a session saved with group verdicts and a review queue is not
    // migrated, it is skipped.
    const { viewedHunkIds: _, viewedReceipts: __, ...oldFields } = session("older");
    const older = JSON.stringify({
      ...oldFields,
      seq: 0,
      cursor: { itemId: null, pane: "queue" },
      groups: [{ id: "g", title: "old", notes: [], hunkIds: ["h"], accepted: false }],
      queue: ["g"],
      queueSet: true,
      acceptHistory: [],
    });
    await writeFile(join(dataDir, "older.json"), older);
    const loaded = await run(SessionStore.use((s) => s.loadAll));
    expect(loaded.map((loadedSession) => loadedSession.id)).toEqual(["a"]);
    expect(await readFile(join(dataDir, "older.json"), "utf8")).toBe(older);
  });

  it("round-trips semantic metadata, Viewed and their historical receipts", async () => {
    const prepared: Session = {
      ...session("semantic"),
      hunks: [{ id: "h", file: "h.ts", header: "@@ -1 +1 @@", patch: "-a\n+b", contentHash: "h" }],
      groups: [
        {
          id: "g",
          title: "API and tests",
          notes: [{ hunkId: "h", text: "Different operations, one behavior." }],
          hunkIds: ["h"],
        },
      ],
      viewedHunkIds: ["h"],
    };
    const status = statusOf(prepared);
    const saved: Session = {
      ...prepared,
      receiptNoteTexts: [prepared.groups[0]!.notes[0]!.text],
      applyReceipts: [
        {
          key: "publish",
          digest: "digest",
          status: {
            ...status,
            groups: [{ ...status.groups[0]!, notes: [{ hunkId: "h", text: 0 }] }],
          },
        },
      ],
      viewedReceipts: [
        {
          requestId: "r1",
          digest: "digest",
          result: {
            sessionId: "semantic",
            snapshotId: "snapshot",
            revision: 1,
            hunkIds: ["h"],
            viewed: true,
          },
        },
      ],
    };
    await run(SessionStore.use((s) => s.save(saved)));
    const loaded = await run(SessionStore.use((s) => s.loadAll));
    expect(loaded.find(({ id }) => id === "semantic")).toEqual(saved);
  });

  it("keeps delete receipts private, atomic and out of the session listing", async () => {
    const empty = await run(SessionStore.use((s) => s.loadDeleteReceipts));
    expect(empty).toEqual([]);
    const receipts = [{ requestId: "r1", sessionId: "a" }];
    await run(SessionStore.use((s) => s.saveDeleteReceipts(receipts)));
    expect((await stat(join(dataDir, "delete-receipts"))).mode & 0o777).toBe(0o600);
    expect(await run(SessionStore.use((s) => s.loadDeleteReceipts))).toEqual(receipts);
    expect((await run(SessionStore.use((s) => s.loadAll))).map(({ id }) => id)).not.toContain(
      "delete-receipts",
    );
    const inspected = await Effect.runPromise(
      inspectSavedSessions.pipe(
        Effect.provide(Paths.layer),
        Effect.provide(NodeServices.layer),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir })),
        ),
      ),
    );
    expect(inspected.incompatible).not.toContain("delete-receipts");
    // A receipt file that cannot be read back is a defect, never an empty history.
    await writeFile(join(dataDir, "delete-receipts"), "[{");
    await expect(run(SessionStore.use((s) => s.loadDeleteReceipts))).rejects.toThrow();
    await rm(join(dataDir, "delete-receipts"));
  });

  it.skipIf(process.getuid?.() === 0)(
    "propagates filesystem errors instead of hiding a session",
    async () => {
      await writeFile(join(dataDir, "unreadable.json"), JSON.stringify(session("unreadable")));
      await chmod(join(dataDir, "unreadable.json"), 0o000);
      const error = await run(Effect.flip(SessionStore.use((s) => s.loadAll)));
      expect(error._tag).toBe("PlatformError");
      expect(error.reason._tag).toBe("PermissionDenied");
    },
  );
});
