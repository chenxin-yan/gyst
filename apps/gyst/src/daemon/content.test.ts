import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type SnapshotManifest, snapshotIdOf } from "@gyst/core";
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapturedContent } from "./content.ts";
import { Paths } from "./paths.ts";

let dataDir: string;
const contentDir = () => join(dataDir, "content");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

const run = <A, E>(effect: Effect.Effect<A, E, CapturedContent | FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      CapturedContent.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Paths.layer),
        Layer.provide(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir }))),
      ),
    ),
  );
const put = (...chunks: Uint8Array[]) =>
  run(CapturedContent.use((content) => content.putBlob(Stream.fromIterable(chunks))));
const read = (blob: string, range: { offset: number; length: number }) =>
  run(CapturedContent.use((content) => Stream.mkUint8Array(content.readBlob(blob, range))));
const staged = () => readdir(join(contentDir(), "staging"));
const blobs = () => readdir(join(contentDir(), "blobs"));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-content-"));
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

// BOM, CRLF, a non-BMP character and no final newline: stored and read back byte for byte.
const unicode = encoder.encode('\uFEFFconst π = 1;\r\nconst 🦀 = "crab";\r\n// end');

describe("CapturedContent blobs", () => {
  it("stores exact bytes privately under their full SHA-256 and reads them back", async () => {
    const empty = await put();
    expect(empty).toEqual({ blob: sha256(""), size: 0 });
    expect(await read(empty.blob, { offset: 0, length: 10 })).toEqual(new Uint8Array());

    const large = new Uint8Array(200_000).map((_, index) => index % 251);
    const chunks = [
      large.subarray(0, 70_000),
      large.subarray(70_000, 70_001),
      large.subarray(70_001),
    ];
    const multichunk = await put(...chunks);
    expect(multichunk).toEqual({ blob: sha256(large), size: large.byteLength });
    expect(await read(multichunk.blob, { offset: 0, length: large.byteLength })).toEqual(large);

    const text = await put(unicode.subarray(0, 5), unicode.subarray(5));
    expect(text).toEqual({ blob: sha256(unicode), size: unicode.byteLength });
    expect(await readFile(join(contentDir(), "blobs", text.blob))).toEqual(Buffer.from(unicode));
    expect(await read(text.blob, { offset: 0, length: unicode.byteLength })).toEqual(unicode);

    for (const dir of ["", "blobs", "snapshots", "staging"])
      expect((await stat(join(contentDir(), dir))).mode & 0o777).toBe(0o700);
    expect((await stat(join(contentDir(), "blobs", text.blob))).mode & 0o777).toBe(0o600);
    expect(await staged()).toEqual([]);
  });

  it("reads bounded byte ranges with explicit end-of-content semantics", async () => {
    const { blob, size } = await put(unicode);
    expect(await read(blob, { offset: 3, length: 4 })).toEqual(unicode.subarray(3, 7));
    // A range past the end is a short read; a range starting at the end is empty.
    expect(await read(blob, { offset: size - 2, length: 100 })).toEqual(unicode.subarray(size - 2));
    expect(await read(blob, { offset: size, length: 1 })).toEqual(new Uint8Array());
    expect(await read(blob, { offset: 0, length: 0 })).toEqual(new Uint8Array());
    const pastEnd = await run(
      Effect.flip(
        CapturedContent.use((content) =>
          Stream.runDrain(content.readBlob(blob, { offset: size + 1, length: 1 })),
        ),
      ),
    );
    expect(pastEnd._tag).toBe("bad_args");
  });

  it("rejects malformed or unknown blob IDs and ranges before touching the filesystem", async () => {
    const { blob } = await put(unicode);
    const cases: Array<[string, { offset: number; length: number }]> = [
      ["../../session", { offset: 0, length: 1 }],
      [blob.toUpperCase(), { offset: 0, length: 1 }],
      [blob.slice(0, 40), { offset: 0, length: 1 }],
      [sha256("never stored"), { offset: 0, length: 1 }],
      [blob, { offset: -1, length: 1 }],
      [blob, { offset: 0, length: 1.5 }],
      [blob, { offset: 0, length: Number.POSITIVE_INFINITY }],
    ];
    for (const [id, range] of cases) {
      const error = await run(
        Effect.flip(CapturedContent.use((content) => Stream.runDrain(content.readBlob(id, range)))),
      );
      expect(error._tag).toBe("bad_args");
    }
  });

  it("deduplicates concurrent identical writes into one committed object", async () => {
    const bytes = encoder.encode("shared helper\n");
    const before = await blobs();
    const results = await run(
      CapturedContent.use((content) =>
        Effect.all(
          Array.from({ length: 8 }, () => content.putBlob(Stream.make(bytes))),
          { concurrency: "unbounded" },
        ),
      ),
    );
    expect(new Set(results.map(({ blob }) => blob))).toEqual(new Set([sha256(bytes)]));
    expect((await blobs()).filter((name) => !before.includes(name))).toEqual([sha256(bytes)]);
    expect(await staged()).toEqual([]);
  });

  it("removes only its own staging when the input fails or is interrupted", async () => {
    const committed = await put(unicode);
    const before = await blobs();
    const failed = await run(
      Effect.flip(
        CapturedContent.use((content) =>
          content.putBlob(
            Stream.concat(Stream.make(unicode), Stream.fail("source vanished" as const)),
          ),
        ),
      ),
    );
    expect(failed).toBe("source vanished");
    expect(await staged()).toEqual([]);

    await run(
      Effect.gen(function* () {
        const content = yield* CapturedContent;
        const fiber = yield* Effect.forkChild(
          content.putBlob(Stream.concat(Stream.make(unicode), Stream.never)),
        );
        // The first chunk is on disk in staging while the stream waits.
        while ((yield* Effect.promise(staged)).length === 0) yield* Effect.sleep("5 millis");
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(await staged()).toEqual([]);
    expect(await blobs()).toEqual(before);
    expect(await read(committed.blob, { offset: 0, length: committed.size })).toEqual(unicode);
  });

  it("serves captured bytes after the source file is gone", async () => {
    const source = join(dataDir, "source.txt");
    await writeFile(source, unicode);
    const { blob, size } = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* CapturedContent.use((content) => content.putBlob(fs.stream(source)));
      }),
    );
    await rm(source);
    expect(await read(blob, { offset: 0, length: size })).toEqual(unicode);
  });
});

const manifestWith = (files: SnapshotManifest["files"]): SnapshotManifest => ({
  scope: { kind: "range", range: "main...feature" },
  provenance: {
    kind: "range",
    base: "a".repeat(40),
    head: "b".repeat(40),
    mergeBase: "c".repeat(40),
  },
  files,
  hunks: [],
});

describe("CapturedContent manifests", () => {
  it("publishes a manifest under its canonical identity and loads it strictly", async () => {
    const helper = await put(encoder.encode("export const helper = 1;\n"));
    const changed = await put(unicode);
    const manifest = manifestWith([
      { path: "src/app.ts", old: { kind: "absent" }, new: { kind: "text", ...changed } },
      { path: "src/helper.ts", old: { kind: "text", ...helper }, new: { kind: "text", ...helper } },
      {
        path: "src/logo.png",
        old: { kind: "unavailable", reason: "binary" },
        new: { kind: "absent" },
      },
    ]);
    const id = await run(CapturedContent.use((content) => content.putManifest(manifest)));
    expect(id).toBe(snapshotIdOf(manifest));
    const file = join(contentDir(), "snapshots", `${id}.json`);
    expect(sha256(await readFile(file))).toBe(id);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await run(CapturedContent.use((content) => content.loadManifest(id)))).toEqual(manifest);
    // Republishing identical content is idempotent.
    expect(await run(CapturedContent.use((content) => content.putManifest(manifest)))).toBe(id);
    expect(await staged()).toEqual([]);
  });

  it("refuses to publish missing, inconsistent or invalid references", async () => {
    const helper = await put(encoder.encode("helper\n"));
    const before = await readdir(join(contentDir(), "snapshots"));
    const invalid: SnapshotManifest[] = [
      manifestWith([
        {
          path: "a.ts",
          old: { kind: "absent" },
          new: { kind: "text", blob: sha256("x"), size: 1 },
        },
      ]),
      manifestWith([
        {
          path: "a.ts",
          old: { kind: "absent" },
          new: { kind: "text", ...helper, size: helper.size + 1 },
        },
      ]),
      manifestWith([
        { path: "../a.ts", old: { kind: "absent" }, new: { kind: "text", ...helper } },
      ]),
      { ...manifestWith([]), provenance: { kind: "uncommitted", head: null } },
    ];
    for (const manifest of invalid) {
      const error = await run(
        Effect.flip(CapturedContent.use((content) => content.putManifest(manifest))),
      );
      expect(error._tag).toBe("bad_args");
    }
    expect(await readdir(join(contentDir(), "snapshots"))).toEqual(before);
    expect(await staged()).toEqual([]);
  });

  it("distinguishes unknown, malformed and corrupt snapshot IDs", async () => {
    const load = (id: string) =>
      run(Effect.flip(CapturedContent.use((content) => content.loadManifest(id))));
    expect((await load("../../session"))._tag).toBe("bad_args");
    expect((await load(sha256("never published")))._tag).toBe("bad_args");

    const tampered = await run(
      CapturedContent.use((content) => content.putManifest(manifestWith([]))),
    );
    const file = join(contentDir(), "snapshots", `${tampered}.json`);
    await chmod(file, 0o600);
    await writeFile(file, (await readFile(file, "utf8")).replace("main", "mainx"));
    expect((await load(tampered)).message).toMatch(/corrupt/);

    // Content matching its name but not the schema is corrupt too, never loaded leniently.
    const wrongShape = JSON.stringify({ scope: { kind: "uncommitted" } });
    await writeFile(join(contentDir(), "snapshots", `${sha256(wrongShape)}.json`), wrongShape);
    expect((await load(sha256(wrongShape))).message).toMatch(/corrupt/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "failed blob and manifest writes leave committed content untouched and no staging",
    async () => {
      const helper = await put(encoder.encode("kept\n"));
      const blobsBefore = await blobs();
      await chmod(join(contentDir(), "blobs"), 0o500);
      try {
        const error = await run(
          Effect.flip(
            CapturedContent.use((content) => content.putBlob(Stream.make(encoder.encode("new\n")))),
          ),
        );
        expect(error._tag).toBe("PlatformError");
      } finally {
        await chmod(join(contentDir(), "blobs"), 0o700);
      }
      expect(await blobs()).toEqual(blobsBefore);
      expect(await staged()).toEqual([]);

      const kept = await run(
        CapturedContent.use((content) =>
          content.putManifest(
            manifestWith([
              { path: "kept.ts", old: { kind: "absent" }, new: { kind: "text", ...helper } },
            ]),
          ),
        ),
      );
      const snapshots = join(contentDir(), "snapshots");
      await chmod(snapshots, 0o500);
      try {
        const error = await run(
          Effect.flip(
            CapturedContent.use((content) =>
              content.putManifest(
                manifestWith([
                  { path: "new.ts", old: { kind: "absent" }, new: { kind: "text", ...helper } },
                ]),
              ),
            ),
          ),
        );
        expect(error._tag).toBe("PlatformError");
      } finally {
        await chmod(snapshots, 0o700);
      }
      expect(await staged()).toEqual([]);
      expect(await run(CapturedContent.use((content) => content.loadManifest(kept)))).toBeDefined();
      expect(await read(helper.blob, { offset: 0, length: helper.size })).toEqual(
        encoder.encode("kept\n"),
      );
    },
  );
});
