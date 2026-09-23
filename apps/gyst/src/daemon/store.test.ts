import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { type Session, statusOf } from "@gyst/core";
import { ConfigProvider, Effect, Layer } from "effect";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Paths } from "./paths.ts";
import { SessionStore } from "./store.ts";

let dataDir: string;

const session = (id: string): Session => ({
  id,
  repoRoot: "/repo",
  source: { kind: "stdin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
  seq: 0,
  cursor: { itemId: null, expanded: false },
  hunks: [],
  groups: [],
  queue: [],
  queueSet: false,
  acceptHistory: [],
  receiptOverviews: [],
  applyReceipts: [],
});

const run = <A, E>(effect: Effect.Effect<A, E, SessionStore>) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      SessionStore.layer.pipe(
        Layer.provide(Paths.layer),
        Layer.provide(BunServices.layer),
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
    // The schema is the contract: a file missing a review field is not migrated, it is skipped.
    const older = JSON.stringify({ ...session("older"), queue: undefined });
    await writeFile(join(dataDir, "older.json"), older);
    const loaded = await run(SessionStore.use((s) => s.loadAll));
    expect(loaded.map((loadedSession) => loadedSession.id)).toEqual(["a"]);
    expect(await readFile(join(dataDir, "older.json"), "utf8")).toBe(older);
  });

  it("round-trips semantic metadata inside persisted historical receipt snapshots", async () => {
    const prepared: Session = {
      ...session("semantic"),
      groups: [
        {
          id: "g",
          title: "API and tests",
          overview: "## Intent\nDifferent operations, one behavior.",
          hunkIds: ["h"],
          accepted: false,
        },
      ],
    };
    const status = statusOf(prepared);
    const saved: Session = {
      ...prepared,
      receiptOverviews: [prepared.groups[0]!.overview],
      applyReceipts: [
        {
          key: "publish",
          digest: "digest",
          status: { ...status, groups: [{ ...status.groups[0]!, overview: 0 }], spotlight: [] },
        },
      ],
    };
    await run(SessionStore.use((s) => s.save(saved)));
    const loaded = await run(SessionStore.use((s) => s.loadAll));
    expect(loaded.find(({ id }) => id === "semantic")).toEqual(saved);
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
