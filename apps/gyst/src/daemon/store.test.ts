import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Session, statusOf } from "@gyst/core";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  overview: null,
  groups: [],
  viewedHunkIds: [],
  receiptTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
  refreshReceipts: [],
  threads: [],
  drafts: [],
  conversationReceipts: [],
  pickupReceipts: [],
});

/** `wrap` may replace file system operations to observe or fail them. */
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionStore>,
  wrap: (real: FileSystem.FileSystem) => FileSystem.FileSystem = (real) => real,
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      SessionStore.layer.pipe(
        Layer.provide(Paths.layer),
        Layer.provide(Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, wrap))),
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

  /**
   * Records each sync and rename. `fails` names the sync that fails; `afterRename` runs once each
   * rename has happened.
   */
  const observing =
    (
      calls: string[],
      options: { fails?: "file" | "directory"; afterRename?: Effect.Effect<void> } = {},
    ) =>
    (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
      ...real,
      open: (path, openOptions) =>
        Effect.map(real.open(path, openOptions), (handle) =>
          Object.create(handle, {
            sync: {
              value: Effect.suspend(() => {
                const synced = path === dataDir ? "directory" : "file";
                calls.push(synced === "directory" ? "sync directory" : `sync ${basename(path)}`);
                return options.fails === synced
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "sync",
                      }),
                    )
                  : handle.sync;
              }),
            },
          }),
        ),
      rename: (from, to) =>
        Effect.suspend(() => {
          calls.push(`rename to ${basename(to)}`);
          return real.rename(from, to).pipe(Effect.andThen(options.afterRename ?? Effect.void));
        }),
    });
  const leftovers = async () => (await readdir(dataDir)).filter((name) => !name.endsWith(".json"));
  const revisionOnDisk = async (id: string) =>
    JSON.parse(await readFile(join(dataDir, `${id}.json`), "utf8")).revision;

  it("syncs a saved file before its rename and its directory after, and the directory on request", async () => {
    const calls: string[] = [];
    await run(
      SessionStore.use((s) => s.save(session("synced"))),
      observing(calls),
    );
    expect(calls).toEqual([
      expect.stringMatching(/^sync /),
      "rename to synced.json",
      "sync directory",
    ]);
    calls.length = 0;
    await run(
      SessionStore.use((s) => s.syncSaved),
      observing(calls),
    );
    expect(calls).toEqual(["sync directory"]);
    await rm(join(dataDir, "synced.json"));
  });

  it("keeps the old file when the new one cannot be synced, and reports a replacement it cannot make durable", async () => {
    await run(SessionStore.use((s) => s.save(session("unsynced"))));
    const saveRevision = (revision: number, fails: "file" | "directory") =>
      run(
        Effect.flip(SessionStore.use((s) => s.save({ ...session("unsynced"), revision }))),
        observing([], { fails }),
      );
    expect((await saveRevision(1, "file"))._tag).toBe("PlatformError");
    expect(await revisionOnDisk("unsynced")).toBe(0);
    expect(await leftovers()).toEqual([]);
    // Renamed before its directory sync failed: visible, but it may not survive a crash.
    expect((await saveRevision(2, "directory"))._tag).toBe("PlatformError");
    expect(await revisionOnDisk("unsynced")).toBe(2);
    expect(await leftovers()).toEqual([]);
    expect(
      (
        await run(
          Effect.flip(SessionStore.use((s) => s.syncSaved)),
          observing([], { fails: "directory" }),
        )
      )._tag,
    ).toBe("PlatformError");
    await rm(join(dataDir, "unsynced.json"));
  });

  it("syncs the directory of a renamed file even when interrupted after the rename", async () => {
    const calls: string[] = [];
    const renamed = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    await run(
      Effect.gen(function* () {
        const saving = yield* Effect.forkChild(
          SessionStore.use((s) => s.save(session("interrupted"))),
        );
        yield* Deferred.await(renamed);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(saving));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
      }),
      observing(calls, {
        afterRename: Deferred.succeed(renamed, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      }),
    );
    expect(calls).toEqual([
      expect.stringMatching(/^sync /),
      "rename to interrupted.json",
      "sync directory",
    ]);
    expect(await leftovers()).toEqual([]);
    await rm(join(dataDir, "interrupted.json"));
  });

  it("skips undecodable session files but keeps the valid ones", async () => {
    await writeFile(join(dataDir, "corrupt.json"), "{not json");
    await writeFile(join(dataDir, "wrong-shape.json"), JSON.stringify({ id: "x" }));
    // The schema is the contract: a session saved with group verdicts and a review queue is not
    // migrated, it is skipped. The fixture keeps every required field, so only the legacy extras
    // can reject it.
    const older = JSON.stringify({
      ...session("older"),
      seq: 0,
      cursor: { itemId: null, pane: "queue" },
      groups: [{ id: "g", title: "old", notes: [], hunkIds: ["h"], accepted: false }],
      queue: ["g"],
      queueSet: true,
      acceptHistory: [],
    });
    await writeFile(join(dataDir, "older.json"), older);
    // Hunk-anchored plain-text notes are superseded by range notes; such a session is skipped too.
    const { overview: _, receiptTexts: __, ...unprepared } = session("hunk-notes");
    const hunkNotes = JSON.stringify({
      ...unprepared,
      groups: [{ id: "g", title: "old", notes: [{ hunkId: "h", text: "old" }], hunkIds: ["h"] }],
      receiptNoteTexts: [],
    });
    await writeFile(join(dataDir, "hunk-notes.json"), hunkNotes);
    const loaded = await run(SessionStore.use((s) => s.loadAll));
    expect(loaded.map((loadedSession) => loadedSession.id)).toEqual(["a"]);
    // Reclaiming captured content still reads what it skipped.
    const saved = await run(SessionStore.use((s) => s.loadSaved));
    expect(saved.sessions).toEqual(loaded);
    expect(saved.undecodable.toSorted()).toEqual(
      ["{not json", JSON.stringify({ id: "x" }), older, hunkNotes].toSorted(),
    );
    expect(await readFile(join(dataDir, "older.json"), "utf8")).toBe(older);
    expect(await readFile(join(dataDir, "hunk-notes.json"), "utf8")).toBe(hunkNotes);
  });

  it("round-trips semantic metadata, Viewed, conversations and their historical receipts", async () => {
    const prepared: Session = {
      ...session("semantic"),
      hunks: [
        {
          id: "h",
          file: "h.ts",
          header: "@@ -1 +1 @@",
          patch: "@@ -1 +1 @@\n-a\n+b",
          contentHash: "h",
        },
      ],
      overview: { markdown: "One behavior, **two** operations.", references: [] },
      groups: [
        {
          id: "g",
          title: "API and tests",
          overview: null,
          hunkIds: ["h"],
          files: ["h.ts"],
          notes: [
            {
              id: "n",
              anchor: {
                snapshotId: "snapshot",
                path: "h.ts",
                side: "new",
                startLine: 1,
                endLine: 1,
              },
              markdown: "Different operations, one behavior.",
              references: [],
              outdated: ["references"],
            },
          ],
        },
      ],
      viewedHunkIds: ["h"],
    };
    const status = statusOf(prepared);
    const saved: Session = {
      ...prepared,
      receiptTexts: [prepared.overview!.markdown, prepared.groups[0]!.notes[0]!.markdown],
      applyReceipts: [
        {
          key: "publish",
          digest: "digest",
          status: {
            ...status,
            overview: { ...status.overview!, markdown: 0 },
            groups: [
              {
                ...status.groups[0]!,
                overview: null,
                notes: [{ ...status.groups[0]!.notes[0]!, markdown: 1 }],
              },
            ],
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
      refreshReceipts: [
        {
          requestId: "r2",
          digest: "digest",
          result: {
            sessionId: "semantic",
            previousSnapshotId: "earlier",
            snapshotId: "snapshot",
            revision: 1,
            replaced: true,
          },
        },
      ],
    };
    const anchor = {
      snapshotId: "earlier",
      path: "h.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
    } as const;
    const thread: Session["threads"][number] = {
      id: "t",
      anchor,
      note: { id: "n", removed: false },
      resolved: true,
      messages: [
        {
          id: "m1",
          author: "human",
          kind: "change",
          pending: false,
          markdown: "Rename it?",
          references: [],
          wording: {
            markdown: "Different operations, one behavior.",
            references: [anchor],
            anchor,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          author: "agent",
          markdown: "Renamed.",
          references: [anchor],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const conversing: Session = {
      ...saved,
      threads: [thread],
      drafts: [
        {
          id: "d",
          snapshotId: "snapshot",
          anchor,
          thread: "t",
          note: { id: "n", removed: false },
        },
      ],
      conversationReceipts: [
        {
          requestId: "r3",
          digest: "digest",
          result: { sessionId: "semantic", revision: 2, thread: "t" },
        },
      ],
      pickupReceipts: [
        {
          requestId: "r4",
          digest: "digest",
          result: {
            sessionId: "semantic",
            snapshotId: "snapshot",
            revision: 3,
            progress: { viewed: 1, total: 1 },
            openThreads: 0,
            threads: [
              {
                ...thread,
                code: { kind: "text", lines: ["b"] },
                earlierCode: [],
                unread: ["m1"],
              },
            ],
          },
        },
      ],
    };
    await run(SessionStore.use((s) => s.save(conversing)));
    expect(
      (await run(SessionStore.use((s) => s.loadAll))).find(({ id }) => id === "semantic"),
    ).toEqual(conversing);
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

  it("keeps launch PATHs private and out of the session listing, and reads a lost file as none", async () => {
    expect(await run(SessionStore.use((s) => s.loadLaunchPaths))).toEqual({});
    const launchPaths = { a: "/usr/local/bin:/usr/bin" };
    await run(SessionStore.use((s) => s.saveLaunchPaths(launchPaths)));
    expect((await stat(join(dataDir, "launch-paths"))).mode & 0o777).toBe(0o600);
    expect(await run(SessionStore.use((s) => s.loadLaunchPaths))).toEqual(launchPaths);
    expect((await run(SessionStore.use((s) => s.loadAll))).map(({ id }) => id)).not.toContain(
      "launch-paths",
    );
    await writeFile(join(dataDir, "launch-paths"), "{");
    expect(await run(SessionStore.use((s) => s.loadLaunchPaths))).toEqual({});
    await rm(join(dataDir, "launch-paths"));
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
