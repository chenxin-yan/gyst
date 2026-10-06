import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ContentSide,
  type ManifestFile,
  type SnapshotManifest,
  SnapshotManifestSchema,
} from "@gyst/core";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CapturedContent } from "./content.ts";
import { materializeSide } from "./navigation-inputs.ts";
import { Paths } from "./paths.ts";

let dataDir: string;
const encoder = new TextEncoder();

const run = <A, E>(
  effect: Effect.Effect<A, E, CapturedContent | FileSystem.FileSystem | Path.Path>,
) =>
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

const text = async (content: string | Uint8Array): Promise<ContentSide> => {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const { blob, size } = await run(
    CapturedContent.use((captured) => captured.putBlob(Stream.make(bytes))),
  );
  return { kind: "text", blob, size };
};
const absent: ContentSide = { kind: "absent" };
const unavailable = (reason: "binary" | "unsupported-encoding" | "symlink" | "submodule") =>
  ({ kind: "unavailable", reason }) as const;

const manifestOf = (files: ReadonlyArray<ManifestFile>): SnapshotManifest =>
  // Decoded, so every test manifest is one a capture could produce.
  Schema.decodeUnknownSync(SnapshotManifestSchema)({
    scope: { kind: "uncommitted" },
    provenance: { kind: "uncommitted", head: null },
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    hunks: [],
  });

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gyst-navigation-inputs-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
/** A fresh `root` alone inside its own directory, so anything written beside it shows. */
const freshRoot = async () => {
  const outer = await tempDir();
  const root = join(outer, "root");
  await mkdir(root);
  return { outer, root };
};
const materialize = (manifest: SnapshotManifest, side: "old" | "new", root: string) =>
  run(materializeSide(manifest, side, root));

const tree = async (dir: string): Promise<Record<string, Buffer>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: Record<string, Buffer> = {};
  for (const entry of entries.filter((entry) => entry.isFile())) {
    const file = join(entry.parentPath, entry.name);
    files[relative(dir, file).split("\\").join("/")] = await readFile(file);
  }
  return files;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-navigation-inputs-data-"));
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

// BOM, CRLF, an astral character and no final newline: copied byte for byte.
const crlfOld = "\uFEFFexport const 𐐀 = 1;\r\nexport const b = 2;";
const crlfNew = "\uFEFFexport const 𐐀 = 3;\r\n";

const snapshot = async () =>
  manifestOf([
    { path: "README.md", old: await text("# old\n"), new: await text("# new\n") },
    { path: "assets/icon.ts", old: unavailable("binary"), new: unavailable("binary") },
    { path: "image.png", old: unavailable("binary"), new: unavailable("binary") },
    { path: "linked.ts", old: unavailable("symlink"), new: absent },
    {
      path: "package.json",
      old: await text('{ "name": "app", "dependencies": {} }'),
      new: await text('{ "name": "app", "devDependencies": { "left-pad": "1.3.0" } }'),
    },
    { path: "src/added.tsx", old: absent, new: await text("export const added = <p />;\n") },
    { path: "src/crlf.ts", old: await text(crlfOld), new: await text(crlfNew) },
    { path: "src/data.json", old: await text("[1]\n"), new: await text("[1]\n") },
    { path: "src/deleted.cjs", old: await text("module.exports = 1;\n"), new: absent },
    { path: "src/latin1.js", old: unavailable("unsupported-encoding"), new: await text("x;\n") },
    { path: "tsconfig.json", old: absent, new: await text('{ "compilerOptions": {} }\n') },
    { path: "vendor/lib", old: unavailable("submodule"), new: unavailable("submodule") },
  ]);

describe("materializeSide", () => {
  it("writes each side's captured TS/JS/JSON text as its own exact, private tree", async () => {
    const manifest = await snapshot();
    const old = await freshRoot();
    const current = await freshRoot();
    const oldLayout = await materialize(manifest, "old", old.root);
    const newLayout = await materialize(manifest, "new", current.root);

    expect(oldLayout.project).toBe(join(old.root, "project"));
    expect(await tree(oldLayout.project)).toEqual({
      "package.json": Buffer.from('{ "name": "app", "dependencies": {} }'),
      "src/crlf.ts": Buffer.from(crlfOld),
      "src/data.json": Buffer.from("[1]\n"),
      "src/deleted.cjs": Buffer.from("module.exports = 1;\n"),
    });
    expect(await tree(newLayout.project)).toEqual({
      "package.json": Buffer.from('{ "name": "app", "devDependencies": { "left-pad": "1.3.0" } }'),
      "src/added.tsx": Buffer.from("export const added = <p />;\n"),
      "src/crlf.ts": Buffer.from(crlfNew),
      "src/data.json": Buffer.from("[1]\n"),
      "src/latin1.js": Buffer.from("x;\n"),
      "tsconfig.json": Buffer.from('{ "compilerOptions": {} }\n'),
    });
    const size = (files: Record<string, Buffer>) =>
      Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0);
    expect(oldLayout).toMatchObject({ files: 4, bytes: size(await tree(oldLayout.project)) });
    expect(newLayout).toMatchObject({ files: 6, bytes: size(await tree(newLayout.project)) });

    for (const dir of ["", "src"])
      expect((await stat(join(newLayout.project, dir))).mode & 0o777).toBe(0o700);
    for (const file of Object.keys(await tree(newLayout.project)))
      expect((await stat(join(newLayout.project, file))).mode & 0o777, file).toBe(0o600);
  });

  it("names each known missing input on its own side", async () => {
    const manifest = await snapshot();
    const old = await materialize(manifest, "old", (await freshRoot()).root);
    const current = await materialize(manifest, "new", (await freshRoot()).root);
    expect(old.gaps).toEqual([
      { kind: "uncaptured", file: "assets/icon.ts", reason: "binary" },
      { kind: "uncaptured", file: "linked.ts", reason: "symlink" },
      { kind: "uncaptured", file: "src/latin1.js", reason: "unsupported-encoding" },
      { kind: "uncaptured", file: "vendor/lib", reason: "submodule" },
      { kind: "no-project-config" },
    ]);
    expect(current.gaps).toEqual([
      { kind: "uncaptured", file: "assets/icon.ts", reason: "binary" },
      { kind: "dependencies", file: "package.json" },
      { kind: "uncaptured", file: "vendor/lib", reason: "submodule" },
    ]);
  });

  it("finds declared packages and project configs anywhere, and ignores what declares nothing", async () => {
    const manifest = manifestOf([
      {
        path: "a/package.json",
        old: await text('{ "peerDependencies": { "react": "*" } }'),
        new: absent,
      },
      { path: "b/package.json", old: await text("{ not json"), new: absent },
      { path: "c/package.json", old: await text('{ "dependencies": "none" }'), new: absent },
      {
        path: "d/package.json",
        old: await text('{ "optionalDependencies": { "x": "1" } }'),
        new: absent,
      },
      { path: "web/jsconfig.json", old: await text("{}"), new: absent },
      { path: "web/tsconfig.json", old: absent, new: unavailable("symlink") },
    ]);
    expect((await materialize(manifest, "old", (await freshRoot()).root)).gaps).toEqual([
      { kind: "dependencies", file: "a/package.json" },
      { kind: "dependencies", file: "d/package.json" },
    ]);
    expect((await materialize(manifest, "new", (await freshRoot()).root)).gaps).toEqual([
      { kind: "uncaptured", file: "web/tsconfig.json", reason: "symlink" },
      { kind: "no-project-config" },
    ]);
  });

  it("names each project config extends target the side did not capture", async () => {
    const manifest = manifestOf([
      {
        path: "app/tsconfig.json",
        old: await text('{ "extends": "./tsconfig.base.json" }'),
        new: await text(
          '{\n  // Shared settings.\n  "extends": ["../config/base", "@tsconfig/strictest", "./tsconfig.base"],\n}\n',
        ),
      },
      { path: "app/tsconfig.base.json", old: absent, new: await text("{}") },
      { path: "app/jsconfig.web.json", old: absent, new: await text('{ "extends": "/etc/x" }') },
      // Not a project config: its `extends` is something else's.
      { path: ".eslintrc.json", old: absent, new: await text('{ "extends": "airbnb" }') },
      { path: "config/base.json", old: unavailable("symlink"), new: absent },
    ]);
    const unresolved = (file: string, target: string) => ({
      kind: "unresolved-import",
      file,
      message: `cannot resolve extends ${JSON.stringify(target)}`,
    });
    expect((await materialize(manifest, "old", (await freshRoot()).root)).gaps).toEqual([
      { kind: "uncaptured", file: "config/base.json", reason: "symlink" },
      unresolved("app/tsconfig.json", "./tsconfig.base.json"),
    ]);
    expect((await materialize(manifest, "new", (await freshRoot()).root)).gaps).toEqual([
      unresolved("app/jsconfig.web.json", "/etc/x"),
      unresolved("app/tsconfig.json", "@tsconfig/strictest"),
      unresolved("app/tsconfig.json", "../config/base"),
    ]);
  });

  it("follows extends through configs of any name, naming a missing grandparent and ending cycles", async () => {
    const manifest = manifestOf([
      {
        path: "tsconfig.json",
        old: absent,
        new: await text('{ "extends": "./config/base.json" }'),
      },
      {
        path: "config/base.json",
        old: absent,
        new: await text('{ "extends": ["./missing.json", "./cycle"] }'),
      },
      { path: "config/cycle.json", old: absent, new: await text('{ "extends": "./base.json" }') },
      // Reached by no project config, so never read for its `extends`.
      { path: "config/unused.json", old: absent, new: await text('{ "extends": "./gone.json" }') },
    ]);
    expect((await materialize(manifest, "new", (await freshRoot()).root)).gaps).toEqual([
      {
        kind: "unresolved-import",
        file: "config/base.json",
        message: 'cannot resolve extends "./missing.json"',
      },
    ]);
  });

  it("drops every config value naming an input outside the layout, and leaves out an unreadable config", async () => {
    const config = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
    const appConfig = {
      extends: ["./base.json", "../../outside.json", "pkg/tsconfig.json"],
      files: ["main.ts", "../../escape.ts"],
      include: ["src/**/*", "../../shared/**/*", "/abs/**/*"],
      references: [{ path: "../lib" }, { path: "../../other" }, "bad"],
      compilerOptions: {
        strict: true,
        baseUrl: "/ignored/by/the/engine",
        paths: {
          dep: ["/tmp/live-dep.ts", "./dep.ts"],
          "host/*": ["../../host/*"],
          "self/*": ["${configDir}/src/*", "${configDir}/../../*"],
        },
        rootDirs: ["src", "C:\\gen"],
        typeRoots: ["../../types"],
        types: ["node", "./local-types", "../../global-types"],
      },
    };
    const manifest = manifestOf([
      {
        path: "app/tsconfig.json",
        old: absent,
        // Comments and trailing commas, as the engine accepts them.
        new: await text(`// app\n${JSON.stringify(appConfig).replace(/}$/, ",}")}\n`),
      },
      { path: "app/base.json", old: absent, new: await text('{ /* fine */ "include": [], }\n') },
      { path: "web/jsconfig.json", old: absent, new: await text("{ include: ['src'] }\n") },
      { path: "web/src/a.js", old: absent, new: await text("export {};\n") },
    ]);
    const layout = await materialize(manifest, "new", (await freshRoot()).root);
    const drop = (value: string) => ({
      kind: "unresolved-import",
      file: "app/tsconfig.json",
      message: `cannot resolve ${value}`,
    });
    expect(layout.gaps).toEqual([
      drop('extends "../../outside.json"'),
      drop('extends "pkg/tsconfig.json"'),
      drop('files "../../escape.ts"'),
      drop('include "../../shared/**/*"'),
      drop('include "/abs/**/*"'),
      drop('references {"path":"../../other"}'),
      drop('references "bad"'),
      drop('paths "dep" "/tmp/live-dep.ts"'),
      drop('paths "host/*" "../../host/*"'),
      drop('paths "self/*" "${configDir}/../../*"'),
      drop('rootDirs "C:\\\\gen"'),
      drop('typeRoots "../../types"'),
      drop('types "../../global-types"'),
      {
        kind: "unresolved-import",
        file: "web/jsconfig.json",
        message: "this config is not JSON with comments, so the engine reads none of it",
      },
    ]);
    const files = await tree(layout.project);
    expect(files["app/tsconfig.json"]!.toString()).toBe(
      config({
        extends: ["./base.json"],
        files: ["main.ts"],
        include: ["src/**/*"],
        references: [{ path: "../lib" }],
        compilerOptions: {
          strict: true,
          baseUrl: "/ignored/by/the/engine",
          paths: { dep: ["./dep.ts"], "self/*": ["${configDir}/src/*"] },
          rootDirs: ["src"],
          typeRoots: [],
          types: ["node", "./local-types"],
        },
      }),
    );
    // Nothing to drop: left byte for byte.
    expect(files["app/base.json"]!.toString()).toBe('{ /* fine */ "include": [], }\n');
    expect(files["web/jsconfig.json"]).toBeUndefined();
    expect(layout.files).toBe(3);
  });

  it("copies rather than links durable blobs, and writes nothing outside root", async () => {
    const manifest = await snapshot();
    const { outer, root } = await freshRoot();
    const { project } = await materialize(manifest, "old", root);
    const file = manifest.files.find(({ path }) => path === "src/crlf.ts")!;
    if (file.old.kind !== "text") throw new Error("expected text");
    const blob = await stat(join(dataDir, "content", "blobs", file.old.blob));
    const copy = await stat(join(project, "src", "crlf.ts"));
    expect(copy.ino).not.toBe(blob.ino);
    expect(copy.nlink).toBe(1);
    expect(blob.nlink).toBe(1);
    expect(await readdir(outer)).toEqual(["root"]);
    expect((await readdir(root)).sort()).toEqual(["package.json", "project"]);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n");
    expect(await readdir(join(dataDir, "content", "staging"))).toEqual([]);
  });

  it("refuses a path that would leave the project, even past manifest validation", async () => {
    const { outer, root } = await freshRoot();
    const escaping = {
      ...manifestOf([]),
      files: [{ path: "../escape.ts", old: await text("x"), new: absent }],
    } as SnapshotManifest;
    const error = await run(Effect.flip(materializeSide(escaping, "old", root)));
    expect(error).toMatchObject({ _tag: "internal_error", detail: "../escape.ts" });
    expect(await readdir(outer)).toEqual(["root"]);
    expect((await readdir(root)).sort()).toEqual(["package.json", "project"]);
    expect(await readdir(join(root, "project"))).toEqual([]);
  });

  it("lays out a fresh project only", async () => {
    const { root } = await freshRoot();
    await mkdir(join(root, "project"));
    const error = await run(Effect.flip(materializeSide(manifestOf([]), "new", root)));
    expect(error._tag).toBe("PlatformError");
  });
});
