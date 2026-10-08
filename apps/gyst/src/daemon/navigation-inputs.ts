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

/**
 * A config as the engine reads it: JSON with comments and trailing commas. Undefined when it is not
 * an object in that syntax.
 */
const parseConfig = (text: string): Record<string, unknown> | undefined => {
  let json = "";
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      json += text.slice(index, end + 1);
      index = end;
    } else if (char === "/" && text[index + 1] === "/") {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? text.length : lineEnd - 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) return undefined;
      json += " ";
      index = close + 1;
    } else if (char === "}" || char === "]") json = json.replace(/,\s*$/, "") + char;
    else json += char;
  }
  if (json.trim() === "") return {};
  try {
    const config: unknown = JSON.parse(json);
    return isRecord(config) ? config : undefined;
  } catch {
    return undefined;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const configDir = "${configDir}";
/**
 * Whether a path a config option names stays in the layout: relative to the config's directory,
 * or for `${configDir}` to whichever config is built, which is in the layout too and at least as
 * deep as its root.
 */
const staysInLayout = (config: string, value: string) => {
  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return false;
  const from = slashed.startsWith(configDir) ? "" : posix.dirname(config);
  const relative = slashed.startsWith(configDir) ? `.${slashed.slice(configDir.length)}` : slashed;
  const resolved = posix.normalize(posix.join(from, relative));
  return resolved !== ".." && !resolved.startsWith("../");
};
const relativeTarget = (target: string) => /^\.\.?\//.test(target);

/**
 * A config without the option values that could name an input outside the layout, which the engine
 * would read from the host: a `paths` fallback, an `include`d directory, a package's base config.
 * `extended` lists the `extends` targets kept, relative ones in the layout; `dropped` names each
 * removed value. An emptied list stays empty rather than falling back to its default. The engine
 * ignores `baseUrl`, and a `types` name resolves only through `typeRoots` or `node_modules`, so
 * neither is a path here.
 */
const confineConfig = (file: string, config: Record<string, unknown>) => {
  const dropped: Array<string> = [];
  const inLayout = (entry: unknown) => typeof entry === "string" && staysInLayout(file, entry);
  /** Keeps the entries of `owner[key]` that `stays` accepts, a lone value as it is or not at all. */
  const confine = (
    owner: Record<string, unknown>,
    key: string,
    option: string,
    stays: (entry: unknown) => boolean = inLayout,
  ) => {
    if (!Object.hasOwn(owner, key)) return [];
    const value = owner[key];
    const entries = Array.isArray(value) ? value : [value];
    const staying = entries.filter((entry) => {
      if (stays(entry)) return true;
      dropped.push(`${option} ${JSON.stringify(entry).slice(0, 200)}`);
      return false;
    });
    if (staying.length === 0 && (!Array.isArray(value) || key === "extends")) delete owner[key];
    else if (Array.isArray(value)) owner[key] = staying;
    return staying;
  };

  const kept = { ...config };
  const extended = confine(
    kept,
    "extends",
    "extends",
    (target) => typeof target === "string" && relativeTarget(target) && inLayout(target),
  ) as Array<string>;
  confine(kept, "files", "files");
  confine(kept, "include", "include");
  confine(
    kept,
    "references",
    "references",
    (reference) => isRecord(reference) && inLayout(reference.path),
  );
  if (isRecord(kept.compilerOptions)) {
    const options = { ...kept.compilerOptions };
    kept.compilerOptions = options;
    if (isRecord(options.paths)) {
      const paths = { ...options.paths };
      options.paths = paths;
      for (const pattern of Object.keys(paths)) {
        confine(paths, pattern, `paths ${JSON.stringify(pattern).slice(0, 200)}`);
        if (Array.isArray(paths[pattern]) && paths[pattern].length === 0) delete paths[pattern];
      }
    }
    confine(options, "rootDirs", "rootDirs");
    confine(options, "typeRoots", "typeRoots");
    confine(
      options,
      "types",
      "types",
      (name) =>
        typeof name === "string" &&
        (!/^(?:\.|\/|\\|[A-Za-z]:|\$\{configDir\})/.test(name) || inLayout(name)),
    );
  }
  return { config: kept, extended, dropped };
};

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
 * Configs are confined to the layout (see `confineConfig`), and `root/package.json` bounds the
 * package scope. `root` must exist and `root/project` must not. `files` and `bytes` are the cost of
 * the layout; `rewritten` lists the configs confinement rewrote, whose positions no longer match
 * their captured text.
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
  // Above a file no captured package.json covers, the engine takes the nearest host one as its
  // package scope (`type`, `imports`). An empty one stops that search and reads as none at all.
  yield* fs.writeFileString(path.join(root, "package.json"), "{}\n", { flag: "wx", mode: 0o600 });

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
  // A relative `extends` target resolves within the layout, `.json` added when missing.
  const laidOut = new Set(written.map((copied) => copied.path));
  const extendedBy = (config: string, target: string) => {
    const relative = posix.normalize(posix.join(posix.dirname(config), target));
    if (laidOut.has(relative)) return relative;
    return !relative.endsWith(".json") && laidOut.has(`${relative}.json`)
      ? `${relative}.json`
      : undefined;
  };
  // The engine reads each project config and every config an `extends` reaches, whatever its name.
  // Each is read once, so an `extends` cycle ends.
  const confined = new Map<string, ReturnType<typeof confineConfig> | undefined>();
  const rewritten: Array<string> = [];
  const configs = [...laidOut].filter(projectConfig);
  for (let config = configs.pop(); config !== undefined; config = configs.pop()) {
    if (confined.has(config)) continue;
    const target = path.join(project, ...config.split("/"));
    const parsed = parseConfig(yield* fs.readFileString(target));
    if (parsed === undefined) {
      // What the engine would make of it is unknown, so it gets none of it.
      yield* fs.remove(target);
      laidOut.delete(config);
      confined.set(config, undefined);
      continue;
    }
    const kept = confineConfig(config, parsed);
    if (kept.dropped.length > 0) {
      yield* fs.writeFileString(target, `${JSON.stringify(kept.config, null, 2)}\n`);
      rewritten.push(config);
    }
    confined.set(config, kept);
    for (const base of kept.extended) {
      const found = extendedBy(config, base);
      if (found !== undefined) configs.push(found);
    }
  }
  // The engine reports an unreadable `extends` only for the config, never for a queried file.
  for (const file of manifest.files) {
    if (!confined.has(file.path)) continue;
    const kept = confined.get(file.path);
    const messages =
      kept === undefined
        ? ["this config is not JSON with comments, so the engine reads none of it"]
        : [
            ...kept.dropped.map((dropped) => `cannot resolve ${dropped}`),
            ...kept.extended
              .filter((target) => extendedBy(file.path, target) === undefined)
              .map((target) => `cannot resolve extends ${JSON.stringify(target).slice(0, 200)}`),
          ];
    for (const message of messages)
      gaps.push({ kind: "unresolved-import", file: file.path, message });
  }
  const layout = written.filter((copied) => laidOut.has(copied.path));
  return {
    project,
    files: layout.length,
    bytes: layout.reduce((total, { bytes }) => total + bytes, 0),
    gaps,
    rewritten,
  };
});

const hostLookups = ["node_modules", "tsconfig.json", "jsconfig.json"];
/**
 * The first name the engine would look up in a directory above `root`, up to the file system's
 * root, that exists there: `node_modules` for a bare specifier or type package, or a
 * `tsconfig.json` or `jsconfig.json` as the config of a file no captured config includes. No option
 * the engine honours stops either search, so a layout can only be checked for them.
 */
export const lookupAboveLayout = Effect.fn("lookupAboveLayout")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = yield* fs.realPath(root);
  for (let parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir))
    for (const name of hostLookups) if (yield* fs.exists(path.join(parent, name))) return name;
  return undefined;
});
