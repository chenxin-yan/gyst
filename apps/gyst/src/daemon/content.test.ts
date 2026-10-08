import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type SnapshotManifest, snapshotIdOf } from "@gyst/core";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Sink,
  Stream,
} from "effect";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapturedContent } from "./content.ts";
import { Paths } from "./paths.ts";

let dataDir: string;
const contentDir = () => join(dataDir, "content");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

// Creating a staged file fails as it would on EMFILE/ENOSPC, without exhausting host resources.
const failingFileCreation = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => {
    const injected = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "open",
      description: "injected file creation failure",
    });
    return { ...fs, sink: () => Sink.fail(injected), writeFile: () => Effect.fail(injected) };
  }),
).pipe(Layer.provide(NodeServices.layer));

const runWith =
  (fileSystem: Layer.Layer<FileSystem.FileSystem>) =>
  <A, E>(effect: Effect.Effect<A, E, CapturedContent | FileSystem.FileSystem>) =>
    Effect.runPromise(
      Effect.provide(
        effect,
        CapturedContent.layer.pipe(
          Layer.provideMerge(fileSystem),
          Layer.provide(Paths.layer),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir })),
          ),
        ),
      ),
    );
const run = runWith(NodeServices.layer);
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

  it("syncs a new blob before linking it, and an existing one never again", async () => {
    const calls: string[] = [];
    const observed = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
        ...fs,
        open: (path, options) =>
          Effect.map(fs.open(path, options), (handle) =>
            Object.create(handle, {
              sync: {
                value: Effect.andThen(
                  Effect.sync(() => calls.push("sync")),
                  handle.sync,
                ),
              },
            }),
          ),
        link: (from, to) =>
          Effect.andThen(
            Effect.sync(() => calls.push("link")),
            fs.link(from, to),
          ),
      })),
    ).pipe(Layer.provide(NodeServices.layer));
    const bytes = encoder.encode("synced once\n");
    const putObserved = runWith(observed);
    await putObserved(CapturedContent.use((content) => content.putBlob(Stream.make(bytes))));
    expect(calls).toEqual(["sync", "link"]);
    calls.length = 0;
    await putObserved(CapturedContent.use((content) => content.putBlob(Stream.make(bytes))));
    expect(calls).toEqual(["link"]);
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
        // Wait until the first chunk is fully written to the private staged file while the sink
        // still holds it open awaiting more input. This interrupts between writes, not mid-syscall.
        let stagedFile: string | undefined;
        for (let attempt = 0; attempt < 400 && stagedFile === undefined; attempt++) {
          const [directory] = yield* Effect.promise(staged);
          const [name] =
            directory === undefined
              ? []
              : yield* Effect.promise(() => readdir(join(contentDir(), "staging", directory)));
          const file =
            name === undefined ? undefined : join(contentDir(), "staging", directory!, name);
          if (file && (yield* Effect.promise(() => stat(file))).size === unicode.byteLength)
            stagedFile = file;
          else yield* Effect.sleep("5 millis");
        }
        expect(stagedFile).toBeDefined();
        expect(yield* Effect.promise(() => readFile(stagedFile!))).toEqual(Buffer.from(unicode));
        const modes = yield* Effect.promise(() =>
          Promise.all([stat(join(stagedFile!, "..")), stat(stagedFile!)]),
        );
        expect(modes.map(({ mode }) => mode & 0o777)).toEqual([0o700, 0o600]);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(await staged()).toEqual([]);
    expect(await blobs()).toEqual(before);
    expect(await read(committed.blob, { offset: 0, length: committed.size })).toEqual(unicode);
  });

  it("removes its staging directory when creating the staged file fails", async () => {
    const committed = await put(unicode);
    const manifest = manifestWith([
      { path: "a.ts", old: { kind: "absent" }, new: { kind: "text", ...committed } },
    ]);
    const before = await Promise.all([blobs(), readdir(join(contentDir(), "snapshots"))]);
    const failing = runWith(failingFileCreation);
    const errors = [
      await failing(
        Effect.flip(CapturedContent.use((content) => content.putBlob(Stream.make(unicode)))),
      ),
      await failing(Effect.flip(CapturedContent.use((content) => content.putManifest(manifest)))),
    ];
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/injected file creation failure/),
      expect.stringMatching(/injected file creation failure/),
    ]);
    expect(await staged()).toEqual([]);
    expect(await Promise.all([blobs(), readdir(join(contentDir(), "snapshots"))])).toEqual(before);
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
  commits: [{ id: "b".repeat(40), message: "Add the app ✓\n\nWith its helper." }],
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

describe("CapturedContent reclaim", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "gyst-reclaim-"));
  });
  afterAll(() => rm(dataDir, { recursive: true, force: true }));
  const snapshots = () => readdir(join(contentDir(), "snapshots"));

  it("removes every manifest, blob and staging leftover outside what is retained", async () => {
    const kept = await put(encoder.encode("kept\n"));
    const shared = await put(encoder.encode("shared\n"));
    const dropped = await put(encoder.encode("dropped\n"));
    const publish = (files: SnapshotManifest["files"]) =>
      run(CapturedContent.use((content) => content.putManifest(manifestWith(files))));
    const keptSnapshot = await publish([
      { path: "a.ts", old: { kind: "text", ...shared }, new: { kind: "text", ...kept } },
    ]);
    await publish([
      { path: "a.ts", old: { kind: "text", ...shared }, new: { kind: "text", ...dropped } },
    ]);
    // What a daemon that died mid-write leaves behind.
    await mkdir(join(contentDir(), "staging", "left-over"), { recursive: true });
    await writeFile(join(contentDir(), "staging", "left-over", "object"), "partial");

    const reclaimed = await run(
      CapturedContent.use((content) =>
        content.reclaim(
          Effect.succeed({
            snapshots: new Set([keptSnapshot]),
            blobs: new Set([kept.blob, shared.blob]),
          }),
        ),
      ),
    );
    expect(reclaimed).toEqual({ snapshots: 1, blobs: 1 });
    expect(await snapshots()).toEqual([`${keptSnapshot}.json`]);
    expect((await blobs()).toSorted()).toEqual([kept.blob, shared.blob].toSorted());
    expect(await staged()).toEqual([]);
    expect(await read(shared.blob, { offset: 0, length: shared.size })).toEqual(
      encoder.encode("shared\n"),
    );
  });

  it("waits until nothing holds content, and evaluates what is retained only then", async () => {
    const early = await put(encoder.encode("held\n"));
    await run(
      Effect.gen(function* () {
        const content = yield* CapturedContent;
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reader = yield* Effect.forkChild(
          content.hold(
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Stream.mkUint8Array(
                  content.readBlob(early.blob, { offset: 0, length: early.size }),
                ).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes))),
              ),
            ),
          ),
        );
        yield* Deferred.await(reading);
        let evaluated = false;
        const reclaim = yield* Effect.forkChild(
          content.reclaim(
            Effect.sync(() => {
              evaluated = true;
              return { snapshots: new Set<string>(), blobs: new Set<string>() };
            }),
          ),
        );
        // A waiting reclaim never holds up another hold, nested or new.
        const late = yield* content.putBlob(Stream.make(encoder.encode("late\n")));
        expect(evaluated).toBe(false);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(reader)).toBe("held\n");
        expect(yield* Fiber.join(reclaim)).toMatchObject({ blobs: expect.any(Number) });
        expect(evaluated).toBe(true);
        expect(yield* Effect.promise(blobs)).not.toContain(late.blob);
      }),
    );
  });

  it("reports running out of space as storage_full and leaves no staging", async () => {
    const outOfSpace = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => {
        const full = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "write",
          description: "no space left on device",
          cause: Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
        });
        return { ...fs, sink: () => Sink.fail(full), writeFile: () => Effect.fail(full) };
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const before = await blobs();
    const error = await runWith(outOfSpace)(
      Effect.flip(
        CapturedContent.use((content) => content.putBlob(Stream.make(encoder.encode("big\n")))),
      ),
    );
    expect(error).toMatchObject({
      _tag: "source_unavailable",
      message: expect.stringContaining("out of space"),
      detail: { reason: "storage_full" },
    });
    expect(await blobs()).toEqual(before);
    expect(await staged()).toEqual([]);
  });
});
