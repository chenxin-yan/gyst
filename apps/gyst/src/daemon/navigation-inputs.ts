import {
  InternalError,
  type ManifestFile,
  type NavigationGap,
  type SnapshotManifest,
} from "@gyst/core";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { posix } from "node:path";
import { CapturedContent } from "./content.ts";
import { lspLanguageId } from "./lsp.ts";

const copyConcurrency = 16;

/** TS/JS sources, and JSON for `package.json`, `tsconfig*.json`, `jsconfig.json` and imported data. */
const navigationInput = (path: string) =>
  lspLanguageId(path) !== undefined || path.endsWith(".json");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const projectConfig = (path: string) => /^[jt]sconfig(?:\..+)?\.json$/.test(basename(path));

/** The `extends` targets of a project config, which is JSON with comments, as written. */
const extendsOf = (text: string) =>
  [...text.matchAll(/"extends"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/g)].flatMap(({ 1: value }) =>
    [...value!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(({ 1: target }) => target!),
  );

const DependencyFields = Schema.Record(Schema.String, Schema.Unknown);
const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      dependencies: Schema.optional(DependencyFields),
      devDependencies: Schema.optional(DependencyFields),
      peerDependencies: Schema.optional(DependencyFields),
      optionalDependencies: Schema.optional(DependencyFields),
    }),
  ),
);
const declaresPackages = (text: string) => {
  const manifest = decodePackageJson(text);
  return (
    manifest._tag === "Some" &&
    Object.values(manifest.value).some((packages) => Object.keys(packages ?? {}).length > 0)
  );
};

/**
 * Lays out one side of a snapshot as a project the engine can analyse, under `root/project`, and
 * names the inputs it knows are missing. Only that side's captured TS/JS/JSON text is written, as
 * private copies streamed from captured content: never links, so an engine write cannot reach a
 * durable blob, and never the checkout, installed packages or anything a script would produce.
 * `root` must exist and `root/project` must not. `files` and `bytes` are the cost of the layout.
 */
export const materializeSide = Effect.fn("materializeSide")(function* (
  manifest: SnapshotManifest,
  side: "old" | "new",
  root: string,
) {
  const content = yield* CapturedContent;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = path.join(root, "project");
  yield* fs.makeDirectory(project, { mode: 0o700 });

  const copy = Effect.fnUntraced(function* (file: ManifestFile, blob: string, size: number) {
    const target = path.join(project, ...file.path.split("/"));
    // Manifest paths are already validated relative paths; this keeps every write inside anyway.
    if (!target.startsWith(project + path.sep))
      return yield* new InternalError({
        message: "a captured path leaves the navigation project",
        detail: file.path,
      });
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    let bytes = 0;
    yield* content.readBlob(blob, { offset: 0, length: size }).pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          bytes += chunk.byteLength;
        }),
      ),
      Stream.run(fs.sink(target, { flag: "wx", mode: 0o600 })),
    );
    const dependencies =
      basename(file.path) === "package.json" && declaresPackages(yield* fs.readFileString(target));
    return { path: file.path, bytes, dependencies };
  });

  const results = yield* Effect.forEach(
    manifest.files,
    Effect.fnUntraced(function* (file) {
      const captured = file[side];
      if (captured.kind === "unavailable") {
        const uncaptured =
          captured.reason === "symlink" ||
          captured.reason === "submodule" ||
          navigationInput(file.path);
        return uncaptured
          ? { gap: { kind: "uncaptured", file: file.path, reason: captured.reason } as const }
          : {};
      }
      if (captured.kind === "absent" || !navigationInput(file.path)) return {};
      const copied = yield* copy(file, captured.blob, captured.size);
      return {
        copied,
        gap: copied.dependencies ? ({ kind: "dependencies", file: file.path } as const) : undefined,
      };
    }),
    { concurrency: copyConcurrency },
  );

  const gaps: Array<NavigationGap> = results.flatMap(({ gap }) => (gap ? [gap] : []));
  const configured = manifest.files.some(
    (file) =>
      file[side].kind === "text" &&
      (basename(file.path) === "tsconfig.json" || basename(file.path) === "jsconfig.json"),
  );
  if (!configured) gaps.push({ kind: "no-project-config" });
  const written = results.flatMap(({ copied }) => (copied ? [copied] : []));
  // The engine reports an unreadable `extends` only for the config, never for a queried file, and
  // reads a config an `extends` names whatever its file name. A relative target resolves within
  // the layout, `.json` added when missing; a package's never.
  const laidOut = new Set(written.map((copied) => copied.path));
  const extendedBy = (config: string, target: string) => {
    if (!/^\.\.?\//.test(target)) return undefined;
    const relative = posix.normalize(posix.join(posix.dirname(config), target));
    if (laidOut.has(relative)) return relative;
    return !relative.endsWith(".json") && laidOut.has(`${relative}.json`)
      ? `${relative}.json`
      : undefined;
  };
  const extendsTargets = new Map<string, ReadonlyArray<string>>();
  const configs = [...laidOut].filter(projectConfig);
  // Each config is read once, so an `extends` cycle ends.
  for (let config = configs.pop(); config !== undefined; config = configs.pop()) {
    if (extendsTargets.has(config)) continue;
    const targets = extendsOf(yield* fs.readFileString(path.join(project, ...config.split("/"))));
    extendsTargets.set(config, targets);
    for (const target of targets) {
      const base = extendedBy(config, target);
      if (base !== undefined) configs.push(base);
    }
  }
  for (const file of manifest.files)
    for (const target of extendsTargets.get(file.path) ?? [])
      if (extendedBy(file.path, target) === undefined)
        gaps.push({
          kind: "unresolved-import",
          file: file.path,
          message: `cannot resolve extends ${JSON.stringify(target).slice(0, 200)}`,
        });
  return {
    project,
    files: written.length,
    bytes: written.reduce((total, { bytes }) => total + bytes, 0),
    gaps,
  };
});
