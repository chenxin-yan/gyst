import {
  BadArgs,
  type ContentSide,
  InternalError,
  LogicalPathSchema,
  type ManifestFile,
  parseFilePatch,
  type Provenance,
  type Scope,
  type SnapshotManifest,
} from "@gyst/core";
import { Context, Data, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname } from "node:path";
import { CapturedContent } from "./content.ts";
import * as Worktree from "./worktree.ts";

/** `base..head` or `base...head`, either side defaulting to HEAD as in Git. */
const rangePattern = /^(?<base>[^\s]*?)(?<dots>\.\.\.?)(?<head>[^\s.][^\s]*|)$/u;

// Every invocation: no pager, replacement objects, promisor fetches or optional index locks, and
// no configured fsmonitor program. Needs Git 2.44+ for `--no-lazy-fetch`; older Git fails loudly.
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
const nulRecords = (bytes: Uint8Array) => {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0); end !== -1; end = bytes.indexOf(0, start)) {
    records.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return records;
};

const isLogicalPath = Schema.is(LogicalPathSchema);
/** Git's raw pathname bytes as a manifest path; undecodable names fail rather than alias. */
const logicalPath = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
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
     */
    capture(root: string, scope: Scope): Effect.Effect<SnapshotManifest, BadArgs | InternalError>;
  }
>()("gyst/daemon/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const content = yield* CapturedContent;
      const env = environment();
      const command = (cwd: string, args: ReadonlyArray<string>, extra?: Record<string, string>) =>
        ChildProcess.make("git", [...globalFlags, ...args], {
          cwd,
          env: extra ? { ...env, ...extra } : env,
          stdin: "ignore",
          // Timeout interruption must also terminate Git wrappers that ignore SIGTERM.
          forceKillAfter: "500 millis",
        });

      const run = Effect.fn("Git.run")(
        function* (cwd: string, args: ReadonlyArray<string>, extra?: Record<string, string>) {
          const handle = yield* spawner.spawn(command(cwd, args, extra));
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkUint8Array(handle.stdout),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { exitCode, stdout, stderr };
        },
        Effect.scoped,
        Effect.mapError(
          (error) => new BadArgs({ message: "git could not be run", detail: error.message }),
        ),
      );
      const records = Effect.fn("Git.records")(function* (
        root: string,
        args: ReadonlyArray<string>,
      ) {
        const result = yield* run(root, args);
        if (result.exitCode !== 0)
          return yield* new BadArgs({
            message: result.stderr.trim() || `git ${args[0]} failed`,
          });
        return nulRecords(result.stdout);
      });

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
        for (const record of yield* records(root, [
          "ls-tree",
          "-r",
          "-z",
          "--full-tree",
          commitId,
        ])) {
          const tab = record.indexOf(9);
          const [mode, , oid] = text(record.subarray(0, tab)).split(" ");
          const path = yield* logicalPath(record.subarray(tab + 1));
          if (!excluded(path)) entries.set(path, { mode: mode!, oid: oid! });
        }
        return entries;
      });

      /** Index paths (staged additions included) plus nonignored untracked files. */
      const worktreeInventory = Effect.fn("Git.worktreeInventory")(function* (root: string) {
        const paths = new Set<string>();
        const submodules = new Set<string>();
        for (const record of yield* records(root, ["ls-files", "-z", "--stage"])) {
          const tab = record.indexOf(9);
          const path = yield* logicalPath(record.subarray(tab + 1));
          if (excluded(path)) continue;
          paths.add(path);
          if (text(record.subarray(0, tab)).startsWith("160000 ")) submodules.add(path);
        }
        for (const record of yield* records(root, [
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
        ])) {
          // A trailing slash is an untracked nested repository: its contents are not the project's.
          if (record.at(-1) === 47) continue;
          const path = yield* logicalPath(record);
          if (!excluded(path)) paths.add(path);
        }
        return { paths, submodules };
      });

      const stored = (bytes: Stream.Stream<Uint8Array, BadArgs>) =>
        content.putBlob(eligibleText(bytes)).pipe(
          Effect.map(({ blob, size }): ContentSide => ({ kind: "text", blob, size })),
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
            const handle = yield* spawner.spawn(command(root, ["cat-file", "blob", oid]));
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

      const treeSide = (root: string, objects: Map<string, ContentSide>) =>
        Effect.fn("Git.treeSide")(function* (entry: TreeEntry | undefined) {
          if (entry === undefined) return { side: { kind: "absent" } } satisfies CapturedSide;
          if (entry.mode === "160000")
            return { side: { kind: "unavailable", reason: "submodule" } } satisfies CapturedSide;
          if (entry.mode === "120000")
            return { side: { kind: "unavailable", reason: "symlink" } } satisfies CapturedSide;
          let side = objects.get(entry.oid);
          if (side === undefined) {
            side = yield* stored(objectBytes(root, entry.oid));
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

      const capture = Effect.fn("Git.capture")(function* (root: string, scope: Scope) {
        const objects = new Map<string, ContentSide>();
        const fromTree = treeSide(root, objects);
        const sides: Array<{ path: string; old: CapturedSide; new: CapturedSide }> = [];
        let provenance: Provenance;
        if (scope.kind === "range") {
          provenance = yield* range(root, scope.range);
          const oldTree = yield* tree(root, provenance.mergeBase ?? provenance.base);
          const newTree = yield* tree(root, provenance.head);
          for (const path of [...new Set([...oldTree.keys(), ...newTree.keys()])].sort())
            sides.push({
              path,
              old: yield* fromTree(oldTree.get(path)),
              new: yield* fromTree(newTree.get(path)),
            });
        } else {
          const baseline = yield* head(root);
          provenance = { kind: "uncommitted", head: baseline };
          const oldTree = yield* tree(root, baseline);
          const inventory = yield* worktreeInventory(root);
          const paths = [...new Set([...oldTree.keys(), ...inventory.paths])].sort();
          const seen = new Map<string, Worktree.WorktreeEntry>();
          for (const path of paths) {
            const old = yield* fromTree(oldTree.get(path));
            if (inventory.submodules.has(path)) {
              sides.push({
                path,
                old,
                new: { side: { kind: "unavailable", reason: "submodule" } },
              });
              continue;
            }
            const entry = yield* Worktree.inspect(root, path);
            seen.set(path, entry);
            const current: CapturedSide =
              entry.kind === "file"
                ? {
                    side: yield* stored(Worktree.read(root, path, entry)),
                    mode: entry.executable ? "100755" : "100644",
                  }
                : entry.kind === "symlink"
                  ? { side: { kind: "unavailable", reason: "symlink" } }
                  : { side: { kind: "absent" } };
            if (old.side.kind !== "absent" || current.side.kind !== "absent")
              sides.push({ path, old, new: current });
          }
          // Best-effort: the inputs this capture saw are still there, unchanged. Not an atomic
          // filesystem snapshot; an edit that restores identical metadata can go unnoticed.
          if ((yield* head(root)) !== baseline) return yield* Worktree.changedDuringCapture("HEAD");
          const after = yield* worktreeInventory(root);
          const added = [...after.paths].find((path) => !inventory.paths.has(path));
          const removed = [...inventory.paths].find((path) => !after.paths.has(path));
          if (added ?? removed) return yield* Worktree.changedDuringCapture((added ?? removed)!);
          for (const [path, entry] of seen) {
            const again = yield* Worktree.inspect(root, path);
            if (JSON.stringify(again) !== JSON.stringify(entry))
              return yield* Worktree.changedDuringCapture(path);
          }
        }

        const files: ManifestFile[] = [];
        const hunks = [];
        for (const { path, old, new: current } of sides) {
          const modeChange =
            old.mode !== undefined && current.mode !== undefined && old.mode !== current.mode
              ? { old: old.mode, new: current.mode }
              : undefined;
          files.push({
            path,
            old: old.side,
            new: current.side,
            ...(modeChange && { modeChange }),
          });
          const textual =
            (old.side.kind === "text" || old.side.kind === "absent") &&
            (current.side.kind === "text" || current.side.kind === "absent");
          const same =
            old.side.kind === "text" &&
            current.side.kind === "text" &&
            old.side.blob === current.side.blob;
          if (textual && !same) hunks.push(...(yield* hunksOf(path, old.side, current.side)));
        }
        return { scope, provenance, files, hunks } satisfies SnapshotManifest;
      });

      return Git.of({ repoRoot, capture });
    }),
  );
}
