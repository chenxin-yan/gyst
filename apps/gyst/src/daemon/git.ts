import {
  BadArgs,
  type CaptureProgress,
  type ContentSide,
  InternalError,
  LogicalPathSchema,
  type ManifestFile,
  parseFilePatch,
  type Provenance,
  type Scope,
  type SnapshotManifest,
} from "@gyst/core";
import {
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  PlatformError,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname } from "node:path";
import { CapturedContent } from "./content.ts";
import * as Worktree from "./worktree.ts";

/** `base..head` or `base...head`, either side defaulting to HEAD as in Git. */
const rangePattern = /^(?<base>[^\s]*?)(?<dots>\.\.\.?)(?<head>[^\s.][^\s]*|)$/u;

// Every invocation: no pager, replacement objects, promisor fetches or optional index locks, and
// no configured fsmonitor program. Verified with Git 2.55 only. A Git without `--no-lazy-fetch`
// rejects the unknown option, so it fails loudly rather than fetching.
const globalFlags = [
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
];

// An inherited GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS… (a hook or wrapper that started the
// daemon) must not redirect or reconfigure capture. The user's own config files still apply.
const keptGitVariables = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
const environment = (): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (!entry[0].startsWith("GIT_") || keptGitVariables.has(entry[0])),
    ),
  ),
  GIT_TERMINAL_PROMPT: "0",
});

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);
const concat = (a: Uint8Array, b: Uint8Array) => {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a);
  joined.set(b, a.byteLength);
  return joined;
};

/**
 * Incremental NUL framing: `push` returns the records a chunk completes; only the one record
 * still being read is held back (`pending` bytes).
 */
export const nulFraming = () => {
  let pending = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): Uint8Array[] {
      const records: Uint8Array[] = [];
      let start = 0;
      for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
        const piece = chunk.subarray(start, end);
        records.push(pending.byteLength === 0 ? piece : concat(pending, piece));
        pending = new Uint8Array(0);
        start = end + 1;
      }
      if (start < chunk.byteLength) pending = concat(pending, chunk.subarray(start));
      return records;
    },
    get pending() {
      return pending.byteLength;
    },
  };
};

const diagnosticLimit = 8 * 1024;
/** Drains a child's stderr completely, keeping only its first few KiB for error messages. */
const diagnostics = <E>(stderr: Stream.Stream<Uint8Array, E>) => {
  const utf8 = new TextDecoder();
  return Stream.runFold(
    stderr,
    () => "",
    (kept: string, chunk: Uint8Array) =>
      kept.length >= diagnosticLimit
        ? kept
        : (kept + utf8.decode(chunk, { stream: true })).slice(0, diagnosticLimit),
  );
};

const isLogicalPath = Schema.is(LogicalPathSchema);
/** Git's raw pathname bytes as a manifest path; undecodable names fail rather than alias. */
const logicalPath = (bytes: Uint8Array) =>
  Effect.try({
    // `ignoreBOM` keeps a leading U+FEFF: `\uFEFFa` and `a` are different files.
    try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    catch: () =>
      new BadArgs({
        message: "a repository path is not valid UTF-8 and cannot be captured",
        detail: { path: decoder.decode(bytes) },
      }),
  }).pipe(
    Effect.filterOrFail(
      isLogicalPath,
      (path) =>
        new BadArgs({ message: "a repository path is not a safe relative path", detail: { path } }),
    ),
  );
const excluded = (path: string) => path.split("/").includes("node_modules");

type FileMode = "100644" | "100755";
type TreeEntry = { readonly mode: string; readonly oid: string };
type CapturedSide = { readonly side: ContentSide; readonly mode?: FileMode };

/** Why bytes that were read are not eligible text; the staged copy is discarded, never committed. */
class Ineligible extends Data.TaggedError("Ineligible")<{
  readonly reason: "binary" | "unsupported-encoding";
}> {}

/** Stops the stream at the first NUL or invalid UTF-8 sequence, including one split by chunks. */
const eligibleText = <E>(bytes: Stream.Stream<Uint8Array, E>) => {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const validate = (decode: () => void) =>
    Effect.try({ try: decode, catch: () => new Ineligible({ reason: "unsupported-encoding" }) });
  return bytes.pipe(
    Stream.mapEffect((chunk) =>
      chunk.includes(0)
        ? Effect.fail(new Ineligible({ reason: "binary" }))
        : Effect.as(
            validate(() => utf8.decode(chunk, { stream: true })),
            chunk,
          ),
    ),
    Stream.concat(Stream.fromEffectDrain(validate(() => utf8.decode()))),
  );
};

export class Git extends Context.Service<
  Git,
  {
    /** The real path of the repository containing a trusted caller's directory. */
    repoRoot(cwd: string): Effect.Effect<string, BadArgs>;
    /**
     * The whole recorded scope as an unpublished manifest: endpoints resolved once, every eligible
     * old/new project file's exact bytes committed to `CapturedContent`, and text hunks diffed from
     * those committed bytes. Refuses (retryably) when the working tree changes during capture.
     * `onProgress` hears real counts (see `CaptureProgressSchema`): each phase's first and last,
     * and at most one every 100 ms between.
     */
    capture(
      root: string,
      scope: Scope,
      onProgress?: (progress: CaptureProgress) => Effect.Effect<void>,
    ): Effect.Effect<SnapshotManifest, BadArgs | InternalError>;
  }
>()("gyst/daemon/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const content = yield* CapturedContent;
      const env = environment();
      const command = (
        cwd: string,
        args: ReadonlyArray<string>,
        options: { readonly extra?: Record<string, string>; readonly stderr?: "ignore" } = {},
      ) =>
        ChildProcess.make("git", [...globalFlags, ...args], {
          cwd,
          env: options.extra ? { ...env, ...options.extra } : env,
          stdin: "ignore",
          ...(options.stderr && { stderr: options.stderr }),
          // Timeout interruption must also terminate Git wrappers that ignore SIGTERM.
          forceKillAfter: "500 millis",
        });
      const couldNotRun = <A, E, R>(
        effect: Effect.Effect<A, E | PlatformError.PlatformError, R>,
      ): Effect.Effect<A, Exclude<E, PlatformError.PlatformError> | BadArgs, R> =>
        Effect.mapError(effect, (error) =>
          error instanceof PlatformError.PlatformError
            ? new BadArgs({ message: "git could not be run", detail: error.message })
            : (error as Exclude<E, PlatformError.PlatformError>),
        );

      /** A small command's whole stdout (endpoints, one file's patch); stderr drained, bounded. */
      const run = Effect.fn("Git.run")(
        function* (cwd: string, args: ReadonlyArray<string>, extra?: Record<string, string>) {
          const handle = yield* spawner.spawn(command(cwd, args, extra && { extra }));
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [Stream.mkUint8Array(handle.stdout), diagnostics(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return { exitCode, stdout, stderr };
        },
        Effect.scoped,
        couldNotRun,
      );
      /** Streams a NUL-separated inventory into `onRecord`, never holding the whole listing. */
      const records = Effect.fn("Git.records")(
        function* (
          root: string,
          args: ReadonlyArray<string>,
          onRecord: (record: Uint8Array) => Effect.Effect<void, BadArgs>,
        ) {
          const handle = yield* spawner.spawn(command(root, args));
          const framing = nulFraming();
          const [, stderr, exitCode] = yield* Effect.all(
            [
              Stream.runForEach(handle.stdout, (chunk) =>
                Effect.forEach(framing.push(chunk), onRecord, { discard: true }),
              ),
              diagnostics(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0)
            return yield* new BadArgs({ message: stderr.trim() || `git ${args[0]} failed` });
          if (framing.pending !== 0)
            return yield* new BadArgs({ message: `git ${args[0]} ended inside a record` });
        },
        Effect.scoped,
        couldNotRun,
      );

      const repoRoot = Effect.fn("Git.repoRoot")(function* (cwd: string) {
        const result = yield* run(cwd, ["rev-parse", "--show-toplevel"]);
        if (result.exitCode !== 0)
          return yield* new BadArgs({
            message: "current directory is not inside a git repository",
          });
        return yield* fs.realPath(text(result.stdout).replace(/\n$/, "")).pipe(
          Effect.mapError(
            (error) =>
              new BadArgs({
                message: "could not resolve the repository root",
                detail: error.message,
              }),
          ),
        );
      });

      // `--end-of-options` keeps a caller's revision from ever being read as an option.
      const commit = Effect.fn("Git.commit")(function* (root: string, revision: string) {
        const resolved = yield* run(root, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${revision}^{commit}`,
        ]);
        if (resolved.exitCode !== 0)
          return yield* new BadArgs({ message: `unknown revision in range: ${revision}` });
        return text(resolved.stdout).trim();
      });

      /** HEAD's commit, or null for an unborn repository (an empty baseline). */
      const head = Effect.fn("Git.head")(function* (root: string) {
        const resolved = yield* run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        return resolved.exitCode === 0 ? text(resolved.stdout).trim() : null;
      });

      const range = Effect.fn("Git.range")(function* (root: string, recorded: string) {
        const parsed = rangePattern.exec(recorded)?.groups;
        if (!parsed || parsed.base!.startsWith("-") || parsed.head!.startsWith("-"))
          return yield* new BadArgs({
            message: "expected a Git range such as main...feature or main..feature",
            detail: recorded,
          });
        const base = yield* commit(root, parsed.base || "HEAD");
        const tip = yield* commit(root, parsed.head || "HEAD");
        if (parsed.dots === "..")
          return { kind: "range", base, head: tip, mergeBase: null } satisfies Provenance;
        // A three-dot range diffs from the merge base, as `git diff A...B` does.
        const mergeBase = yield* run(root, ["merge-base", base, tip]);
        if (mergeBase.exitCode !== 0)
          return yield* new BadArgs({ message: `range has no merge base: ${recorded}` });
        return {
          kind: "range",
          base,
          head: tip,
          mergeBase: text(mergeBase.stdout).trim(),
        } satisfies Provenance;
      });

      /** Every entry of a commit's tree by path, `node_modules` excluded; links are not entered. */
      const tree = Effect.fn("Git.tree")(function* (root: string, commitId: string | null) {
        const entries = new Map<string, TreeEntry>();
        if (commitId === null) return entries;
        yield* records(root, ["ls-tree", "-r", "-z", "--full-tree", commitId], (record) => {
          const tab = record.indexOf(9);
          const [mode, , oid] = text(record.subarray(0, tab)).split(" ");
          return Effect.map(logicalPath(record.subarray(tab + 1)), (path) => {
            if (!excluded(path)) entries.set(path, { mode: mode!, oid: oid! });
          });
        });
        return entries;
      });

      /**
       * Index paths (staged additions included) plus nonignored untracked files. `skipped` holds
       * skip-worktree (sparse) entries: Git compares their index entry, never the checkout.
       */
      const worktreeInventory = Effect.fn("Git.worktreeInventory")(function* (root: string) {
        const paths = new Set<string>();
        const submodules = new Set<string>();
        const skipped = new Map<string, TreeEntry>();
        // `-t` prefixes each record with a status tag: `S` marks a skip-worktree entry.
        yield* records(root, ["ls-files", "-z", "-t", "--stage"], (record) => {
          const tab = record.indexOf(9);
          const [tag, mode, oid] = text(record.subarray(0, tab)).split(" ");
          return Effect.map(logicalPath(record.subarray(tab + 1)), (path) => {
            if (excluded(path)) return;
            paths.add(path);
            if (mode === "160000") submodules.add(path);
            else if (tag === "S") skipped.set(path, { mode: mode!, oid: oid! });
          });
        });
        yield* records(root, ["ls-files", "-z", "--others", "--exclude-standard"], (record) =>
          // A trailing slash is an untracked nested repository: its contents are not the project's.
          record.at(-1) === 47
            ? Effect.void
            : Effect.map(logicalPath(record), (path) => {
                if (!excluded(path)) paths.add(path);
              }),
        );
        return { paths, submodules, skipped };
      });

      /** `read.bytes` counts the text bytes each capture read into content. */
      const stored = (bytes: Stream.Stream<Uint8Array, BadArgs>, read: { bytes: number }) =>
        content.putBlob(eligibleText(bytes)).pipe(
          Effect.map(({ blob, size }): ContentSide => {
            read.bytes += size;
            return { kind: "text", blob, size };
          }),
          Effect.catchTag("Ineligible", ({ reason }) =>
            Effect.succeed<ContentSide>({ kind: "unavailable", reason }),
          ),
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              new InternalError({
                message: "could not store captured content",
                detail: error.message,
              }),
            ),
          ),
        );

      /** Raw object bytes: `cat-file blob` applies no filters, textconv or attributes. */
      const objectBytes = (root: string, oid: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Its diagnostics are unused, so they go nowhere: an unread stderr pipe that fills up
            // would block Git before it finishes stdout.
            const handle = yield* spawner.spawn(
              command(root, ["cat-file", "blob", oid], { stderr: "ignore" }),
            );
            const exited = handle.exitCode.pipe(
              Effect.flatMap((code) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new BadArgs({
                        message: "a Git object is missing or unreadable; capture never fetches it",
                        detail: { oid },
                      }),
                    ),
              ),
            );
            return Stream.concat(handle.stdout, Stream.fromEffectDrain(exited));
          }),
        ).pipe(
          Stream.mapError((error) =>
            error._tag === "PlatformError"
              ? new BadArgs({ message: "git could not be run", detail: error.message })
              : error,
          ),
        );

      const treeSide = (root: string, objects: Map<string, ContentSide>, read: { bytes: number }) =>
        Effect.fn("Git.treeSide")(function* (entry: TreeEntry | undefined) {
          if (entry === undefined) return { side: { kind: "absent" } } satisfies CapturedSide;
          if (entry.mode === "160000")
            return { side: { kind: "unavailable", reason: "submodule" } } satisfies CapturedSide;
          if (entry.mode === "120000")
            return { side: { kind: "unavailable", reason: "symlink" } } satisfies CapturedSide;
          let side = objects.get(entry.oid);
          if (side === undefined) {
            side = yield* stored(objectBytes(root, entry.oid), read);
            objects.set(entry.oid, side);
          }
          return {
            side,
            mode: entry.mode === "100755" ? "100755" : "100644",
          } satisfies CapturedSide;
        });

      // Git is the diff engine over private copies of the committed bytes, never the live paths.
      // Outside any repository (the ceiling stops discovery) with no attributes file, no project
      // or global attribute can select a filter, textconv or binary treatment for these copies.
      // `--text`: both sides are already eligible text, so `core.bigFileThreshold` must not turn
      // them binary.
      const hunksOf = Effect.fn("Git.hunksOf")(
        function* (path: string, old: ContentSide, current: ContentSide) {
          const copy = (side: ContentSide) =>
            side.kind === "text" ? content.materialize(side.blob) : Effect.succeed("/dev/null");
          const oldFile = yield* copy(old);
          const newFile = yield* copy(current);
          const scratch = dirname(old.kind === "text" ? oldFile : newFile);
          const result = yield* run(
            scratch,
            [
              "-c",
              "core.attributesFile=/dev/null",
              "-c",
              "diff.suppressBlankEmpty=false",
              "diff",
              "--no-index",
              "--text",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--",
              oldFile,
              newFile,
            ],
            { GIT_CEILING_DIRECTORIES: dirname(scratch) },
          );
          if (result.exitCode !== 0 && result.exitCode !== 1)
            return yield* new BadArgs({
              message: result.stderr.trim() || "git diff failed",
              detail: { path },
            });
          const hunks = yield* Effect.fromResult(parseFilePatch(text(result.stdout), path));
          const emptyAddOrDelete =
            (old.kind === "absent" && current.kind === "text" && current.size === 0) ||
            (current.kind === "absent" && old.kind === "text" && old.size === 0);
          if (hunks.length === 0 && !emptyAddOrDelete)
            return yield* new InternalError({
              message: "git reported no text hunks for changed text",
              detail: { path },
            });
          return hunks;
        },
        Effect.scoped,
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new InternalError({
              message: "could not diff captured content",
              detail: error.message,
            }),
          ),
        ),
      );

      const capture = Effect.fn("Git.capture")(function* (
        root: string,
        scope: Scope,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void> = () => Effect.void,
      ) {
        const objects = new Map<string, ContentSide>();
        const read = { bytes: 0 };
        const fromTree = treeSide(root, objects, read);
        let reported = Number.NEGATIVE_INFINITY;
        const report = Effect.fnUntraced(function* (
          phase: CaptureProgress["phase"],
          done: number,
          total: number,
        ) {
          const now = yield* Clock.currentTimeMillis;
          if (done !== 0 && done !== total && now - reported < 100) return;
          reported = now;
          yield* onProgress({ phase, done, total, bytes: read.bytes });
        });
        const sides: Array<{ path: string; old: CapturedSide; new: CapturedSide }> = [];
        let provenance: Provenance;
        if (scope.kind === "range") {
          provenance = yield* range(root, scope.range);
          const oldTree = yield* tree(root, provenance.mergeBase ?? provenance.base);
          const newTree = yield* tree(root, provenance.head);
          const paths = [...new Set([...oldTree.keys(), ...newTree.keys()])].sort();
          yield* report("capture", 0, paths.length);
          for (const path of paths) {
            sides.push({
              path,
              old: yield* fromTree(oldTree.get(path)),
              new: yield* fromTree(newTree.get(path)),
            });
            yield* report("capture", sides.length, paths.length);
          }
        } else {
          const baseline = yield* head(root);
          provenance = { kind: "uncommitted", head: baseline };
          const oldTree = yield* tree(root, baseline);
          const inventory = yield* worktreeInventory(root);
          const paths = [...new Set([...oldTree.keys(), ...inventory.paths])].sort();
          const seen = new Map<string, Worktree.WorktreeEntry>();
          // A path under a gitlink (a directory the index now records as a submodule) belongs to
          // that other repository: checked before any working-tree access, so none is read.
          const insideSubmodule = (path: string) => {
            for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1))
              if (inventory.submodules.has(path.slice(0, slash))) return true;
            return false;
          };
          yield* report("capture", 0, paths.length);
          for (const [index, path] of paths.entries()) {
            // Before this path's work: every `continue` below still counts it.
            if (index > 0) yield* report("capture", index, paths.length);
            const old = yield* fromTree(oldTree.get(path));
            if (inventory.submodules.has(path)) {
              sides.push({
                path,
                old,
                new: { side: { kind: "unavailable", reason: "submodule" } },
              });
              continue;
            }
            if (insideSubmodule(path)) {
              if (old.side.kind !== "absent")
                sides.push({ path, old, new: { side: { kind: "absent" } } });
              continue;
            }
            const skippedEntry = inventory.skipped.get(path);
            if (skippedEntry !== undefined) {
              sides.push({ path, old, new: yield* fromTree(skippedEntry) });
              continue;
            }
            const entry = yield* Worktree.inspect(root, path);
            seen.set(path, entry);
            const current: CapturedSide =
              entry.kind === "file"
                ? {
                    side: yield* stored(Worktree.read(root, path, entry), read),
                    mode: entry.executable ? "100755" : "100644",
                  }
                : entry.kind === "symlink"
                  ? { side: { kind: "unavailable", reason: "symlink" } }
                  : { side: { kind: "absent" } };
            if (old.side.kind !== "absent" || current.side.kind !== "absent")
              sides.push({ path, old, new: current });
          }
          if (paths.length > 0) yield* report("capture", paths.length, paths.length);
          // Best-effort: the inputs this capture saw are still there, unchanged. Not an atomic
          // filesystem snapshot; an edit that restores identical metadata can go unnoticed.
          if ((yield* head(root)) !== baseline) return yield* Worktree.changedDuringCapture("HEAD");
          const after = yield* worktreeInventory(root);
          const added = [...after.paths].find((path) => !inventory.paths.has(path));
          const removed = [...inventory.paths].find((path) => !after.paths.has(path));
          const relinked = [...inventory.submodules, ...after.submodules].find(
            (path) => inventory.submodules.has(path) !== after.submodules.has(path),
          );
          const reskipped = [...inventory.skipped.keys(), ...after.skipped.keys()].find(
            (path) =>
              JSON.stringify(inventory.skipped.get(path)) !==
              JSON.stringify(after.skipped.get(path)),
          );
          const moved = added ?? removed ?? relinked ?? reskipped;
          if (moved !== undefined) return yield* Worktree.changedDuringCapture(moved);
          for (const [path, entry] of seen) {
            const again = yield* Worktree.inspect(root, path);
            if (JSON.stringify(again) !== JSON.stringify(entry))
              return yield* Worktree.changedDuringCapture(path);
          }
        }

        // A deleted and an added file with the same bytes are a rename: recorded, not reviewed,
        // with any mode change between them. Several with equal bytes pair in path order (the
        // bytes are identical anyway); `sides` is already sorted by path.
        const deleted = new Map<
          string,
          { paths: Array<{ path: string; mode: FileMode }>; next: number }
        >();
        const renamedFrom = new Map<string, { path: string; mode: FileMode }>();
        for (const { path, old, new: current } of sides)
          if (current.side.kind === "absent" && old.side.kind === "text" && old.mode) {
            const pending = deleted.get(old.side.blob);
            if (pending) pending.paths.push({ path, mode: old.mode });
            else deleted.set(old.side.blob, { paths: [{ path, mode: old.mode }], next: 0 });
          }
        for (const { path, old, new: current } of sides) {
          if (old.side.kind !== "absent" || current.side.kind !== "text") continue;
          const pending = deleted.get(current.side.blob);
          const source = pending?.paths[pending.next];
          if (source === undefined) continue;
          pending!.next++;
          renamedFrom.set(path, source);
        }
        const renamed = new Set([
          ...renamedFrom.keys(),
          ...[...renamedFrom.values()].map(({ path }) => path),
        ]);

        const files: ManifestFile[] = [];
        const diffed: Array<{ path: string; old: ContentSide; new: ContentSide }> = [];
        for (const { path, old, new: current } of sides) {
          const source = renamedFrom.get(path);
          const oldMode = source?.mode ?? old.mode;
          const modeChange =
            oldMode !== undefined && current.mode !== undefined && oldMode !== current.mode
              ? { old: oldMode, new: current.mode }
              : undefined;
          files.push({
            path,
            old: old.side,
            new: current.side,
            ...(modeChange && { modeChange }),
            ...(source && { renamedFrom: source.path }),
          });
          const textual =
            (old.side.kind === "text" || old.side.kind === "absent") &&
            (current.side.kind === "text" || current.side.kind === "absent");
          const same =
            old.side.kind === "text" &&
            current.side.kind === "text" &&
            old.side.blob === current.side.blob;
          if (textual && !same && !renamed.has(path))
            diffed.push({ path, old: old.side, new: current.side });
        }
        const hunks = [];
        yield* report("diff", 0, diffed.length);
        for (const [index, { path, old, new: current }] of diffed.entries()) {
          hunks.push(...(yield* hunksOf(path, old, current)));
          yield* report("diff", index + 1, diffed.length);
        }
        return { scope, provenance, files, hunks } satisfies SnapshotManifest;
      });

      return Git.of({ repoRoot, capture });
    }),
  );
}
