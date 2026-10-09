import {
  BadArgs,
  type CaptureProgress,
  type Commit,
  type ContentSide,
  InternalError,
  LogicalPathSchema,
  type ManifestFile,
  parseFilePatch,
  type Provenance,
  type PullRequestScope,
  pullRequestUrlOf,
  sameSide,
  type Scope,
  type SnapshotManifest,
  SourceUnavailable,
} from "@gyst/core";
import {
  Clock,
  Config,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  PlatformError,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CapturedContent } from "./content.ts";
import * as Worktree from "./worktree.ts";

/** A raw remote URL naming a github.com repository over HTTPS or SSH. */
const githubRemotePattern =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/iu;

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
export const diagnostics = <E>(stderr: Stream.Stream<Uint8Array, E>) => {
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

/** Changed content or mode; two unavailable sides with one reason carry no evidence of a change. */
const changed = (old: CapturedSide, current: CapturedSide) =>
  !sameSide(old.side, current.side) ||
  (old.mode !== undefined && current.mode !== undefined && old.mode !== current.mode);

/** The attributes GitHub Linguist reads as a generated or vendored file. */
const generatedAttributes = ["linguist-generated", "linguist-vendored"];
// As Linguist reads them: set, or any value but `false`. `unset` (`-attr`) and `unspecified` are not.
const marks = (info: string) => info !== "unspecified" && info !== "unset" && info !== "false";
/** Splits per-item arguments into runs of about 64 KiB each, well under the platform's argument limit. */
const argvChunks = <T>(items: readonly T[], bytesOf: (item: T) => number): T[][] => {
  const chunks: T[][] = [];
  let bytes = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (bytes >= 64 * 1024) {
      chunks.push([]);
      bytes = 0;
    }
    chunks.at(-1)!.push(item);
    bytes += bytesOf(item);
  }
  return chunks;
};

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

/** The blob id and size `putBlob` would give these eligible bytes, without storing them. */
const measured = (bytes: Stream.Stream<Uint8Array, BadArgs>) =>
  Effect.suspend(() => {
    const hash = createHash("sha256");
    let size = 0;
    return Stream.runForEach(eligibleText(bytes), (chunk) =>
      Effect.sync(() => {
        hash.update(chunk);
        size += chunk.byteLength;
      }),
    ).pipe(Effect.map(() => ({ blob: hash.digest("hex"), size })));
  });

/**
 * The optional per-snapshot quota of captured text, each distinct blob counted once. There is no
 * default. Read when the daemon starts, from its environment; an invalid value fails each capture,
 * which names it.
 */
const snapshotQuota = Config.option(Config.ByteSize("GYST_SNAPSHOT_QUOTA")).pipe(
  Effect.mapError(
    (error) =>
      new BadArgs({
        message: "GYST_SNAPSHOT_QUOTA must be a size with a unit, such as 500 MiB",
        detail: error.message,
      }),
  ),
);

/**
 * `files` within a snapshot quota of `limit` bytes, each distinct blob counted once. The `reviewed`
 * files are required whole, else the capture fails; every other file's text is then kept in path
 * order while it fits, and each of its text sides that does not is marked `quota`. A rename's two
 * paths share their one blob, so the first one's turn decides both, as its record requires: the
 * second then costs nothing, or no less than the first did with no less used.
 */
const withinQuota = (
  files: ReadonlyArray<ManifestFile>,
  reviewed: ReadonlySet<string>,
  limit: number,
) => {
  const counted = new Set<string>();
  let used = 0;
  /** The bytes of the file's blobs not counted yet. */
  const costOf = (file: ManifestFile) => {
    const blobs = new Map<string, number>();
    for (const side of [file.old, file.new])
      if (side.kind === "text" && !counted.has(side.blob)) blobs.set(side.blob, side.size);
    return blobs;
  };
  const count = (blobs: Map<string, number>) => {
    for (const [blob, size] of blobs) {
      counted.add(blob);
      used += size;
    }
  };
  for (const file of files) if (reviewed.has(file.path)) count(costOf(file));
  if (used > limit)
    return Effect.fail(
      new SourceUnavailable({
        message: `the reviewed files need ${used} bytes of captured text, more than GYST_SNAPSHOT_QUOTA (${limit} bytes) allows; raise or unset it and start gyst again, or review a smaller scope`,
        detail: { reason: "quota_exceeded" },
      }),
    );
  const omitted: ContentSide = { kind: "unavailable", reason: "quota" };
  const left = (side: ContentSide) => (side.kind === "text" ? omitted : side);
  return Effect.succeed(
    files.map((file): ManifestFile => {
      if (reviewed.has(file.path)) return file;
      const cost = costOf(file);
      if (used + [...cost.values()].reduce((sum, size) => sum + size, 0) > limit)
        return { ...file, old: left(file.old), new: left(file.new) };
      count(cost);
      return file;
    }),
  );
};

/** Scopes captured from this checkout alone; a PR scope also needs what GitHub reports. */
export type LocalScope = Exclude<Scope, { readonly kind: "pr" }>;
/** What GitHub reports a PR's range must be captured at. */
export type PullRequestTarget = { readonly baseRefName: string; readonly headRefOid: string };
type CommitProvenance = Exclude<Provenance, { readonly kind: "uncommitted" }>;
/**
 * Which changed files a capture marks Generated. By default Git's attributes for the captured
 * sides decide; a set names them instead, so a source check never asks Git's attributes again.
 */
export type Generated = ReadonlySet<string> | undefined;

export class Git extends Context.Service<
  Git,
  {
    /** The real path of the repository containing a trusted caller's directory. */
    repoRoot(cwd: string): Effect.Effect<string, BadArgs>;
    /**
     * The whole recorded scope as an unpublished manifest: endpoints resolved once, every eligible
     * old/new project file's exact bytes committed to `CapturedContent`, and text hunks diffed from
     * those committed bytes. Refuses (retryably) when the working tree changes during capture.
     * Under `GYST_SNAPSHOT_QUOTA` (see `withinQuota`) the reviewed files must fit or it fails, and
     * other text left out is recorded as `quota`, its bytes never stored.
     * `onProgress` hears real counts (see `CaptureProgressSchema`): each phase's first and last,
     * and at most one every 100 ms between.
     */
    capture(
      root: string,
      scope: LocalScope,
      onProgress?: (progress: CaptureProgress) => Effect.Effect<void>,
      generated?: Generated,
    ): Effect.Effect<SnapshotManifest, SourceUnavailable | BadArgs | InternalError>;
    /**
     * A PR scope captured like a range over `pullRequestRange`'s commits: the PR's own merge base
     * against its head, with every file of both trees, so inherited unchanged source stays readable.
     */
    capturePullRequest(
      root: string,
      scope: PullRequestScope,
      target: PullRequestTarget,
      onProgress?: (progress: CaptureProgress) => Effect.Effect<void>,
      generated?: Generated,
    ): Effect.Effect<SnapshotManifest, SourceUnavailable | BadArgs | InternalError>;
    /**
     * A PR's own range in a matching checkout: merge-base(base branch, PR head)..PR head, the head
     * verified to be `headRefOid`. Fetches only into `refs/gyst/github/<repository>/pull/<n>/`.
     */
    pullRequestRange(
      root: string,
      scope: PullRequestScope,
      target: PullRequestTarget,
    ): Effect.Effect<
      { readonly base: string; readonly head: string; readonly mergeBase: string },
      SourceUnavailable | BadArgs
    >;
  }
>()("gyst/daemon/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const content = yield* CapturedContent;
      const quota = yield* Effect.result(snapshotQuota);
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

      const pullRequestRefs = yield* Semaphore.make(1);
      /** The remote whose raw configured URL (before any insteadOf) names the PR's repository. */
      const remoteFor = Effect.fn("Git.remoteFor")(function* (root: string, repository: string) {
        const listed = yield* run(root, ["config", "-z", "--get-regexp", "^remote\\..*\\.url$"]);
        // Exit 1: no remote is configured at all.
        if (listed.exitCode !== 0 && listed.exitCode !== 1)
          return yield* new BadArgs({ message: listed.stderr.trim() || "git config failed" });
        const matching = text(listed.stdout)
          .split("\0")
          .flatMap((record) => {
            const newline = record.indexOf("\n");
            const parts = githubRemotePattern.exec(record.slice(newline + 1))?.groups;
            return newline !== -1 &&
              parts !== undefined &&
              `${parts.owner}/${parts.name}`.toLowerCase() === repository
              ? [record.slice("remote.".length, newline - ".url".length)]
              : [];
          });
        const remote = matching.includes("origin") ? "origin" : matching[0];
        if (remote === undefined)
          return yield* new SourceUnavailable({
            message: `this checkout has no remote for github.com/${repository}: run gyst from a clone of it`,
            detail: { reason: "checkout_mismatch" },
          });
        return remote;
      });

      /**
       * Fetches the PR head and its base branch into private refs, never touching HEAD, the index,
       * branches, remote-tracking refs, tags or FETCH_HEAD, and returns the PR's own merge base.
       */
      const pullRequestRange = Effect.fn("Git.pullRequestRange")(function* (
        root: string,
        scope: PullRequestScope,
        target: PullRequestTarget,
      ) {
        const url = pullRequestUrlOf(scope);
        const remote = yield* remoteFor(root, scope.repository);
        const baseRef = `refs/heads/${target.baseRefName}`;
        if (
          target.baseRefName.startsWith("-") ||
          (yield* run(root, ["check-ref-format", baseRef])).exitCode !== 0
        )
          return yield* new SourceUnavailable({
            message: `GitHub reported a base branch for ${url} that is not a valid branch name`,
            detail: { reason: "github_failed", diagnostic: target.baseRefName },
          });
        // `%` never appears in a repository name, so escaping every `.` is injective and leaves no
        // leading dot, `..` or `.lock` that Git would refuse in a ref.
        const namespace = `refs/gyst/github/${scope.repository.replaceAll(".", "%2e")}/pull/${scope.number}`;
        const objectsMissing = (message: string, diagnostic?: string) =>
          new SourceUnavailable({
            message,
            detail: { reason: "objects_missing", ...(diagnostic && { diagnostic }) },
          });
        const fetchAndResolve = Effect.gen(function* () {
          const fetched = yield* run(root, [
            // The reference-transaction hook would otherwise run a project program.
            "-c",
            "core.hooksPath=/dev/null",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-prune",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            // Empty: no configured refspec opportunistically updates remote-tracking refs.
            "--refmap=",
            "--end-of-options",
            remote,
            `+refs/pull/${scope.number}/head:${namespace}/head`,
            `+${baseRef}:${namespace}/base`,
          ]).pipe(
            Effect.timeoutOrElse({
              duration: "2 minutes",
              orElse: () =>
                Effect.fail(objectsMissing(`fetching ${url} from remote ${remote} timed out`)),
            }),
          );
          if (fetched.exitCode !== 0)
            return yield* objectsMissing(
              `could not fetch ${url} and its base branch ${target.baseRefName} from remote ${remote}`,
              fetched.stderr.trim(),
            );
          const resolve = (ref: string) =>
            Effect.map(
              run(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
              (resolved) => (resolved.exitCode === 0 ? text(resolved.stdout).trim() : undefined),
            );
          const tip = yield* resolve(`${namespace}/head`);
          const base = yield* resolve(`${namespace}/base`);
          if (tip === undefined || base === undefined)
            return yield* objectsMissing(`the fetched commits of ${url} are not readable`);
          return { tip, base };
        });
        // Acquisitions of one PR share its private refs; one permit keeps another fetch from
        // landing between this fetch and its two resolutions, which would mix two pairs.
        const { tip, base } = yield* fetchAndResolve.pipe(Semaphore.withPermit(pullRequestRefs));
        if (tip !== target.headRefOid)
          return yield* new SourceUnavailable({
            message: `${url} moved while gyst read it: open it again`,
            detail: {
              reason: "head_moved",
              diagnostic: `expected ${target.headRefOid}, fetched ${tip}`,
            },
          });
        const mergeBase = yield* run(root, ["merge-base", base, tip]);
        if (mergeBase.exitCode !== 0)
          return yield* objectsMissing(
            `${url} has no merge base with ${target.baseRefName} in this checkout; if it is shallow, run git fetch --unshallow`,
            mergeBase.stderr.trim(),
          );
        return { base, head: tip, mergeBase: text(mergeBase.stdout).trim() };
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

      /**
       * `read.bytes` counts the text bytes each capture read. With `unstored` the bytes are only
       * measured, and kept there by blob to be read again and stored once a quota admits them.
       */
      const stored = (
        bytes: Stream.Stream<Uint8Array, BadArgs>,
        read: { bytes: number },
        unstored?: Map<string, Stream.Stream<Uint8Array, BadArgs>>,
      ) =>
        (unstored === undefined
          ? content.putBlob(eligibleText(bytes))
          : measured(bytes).pipe(
              Effect.tap(({ blob }) => Effect.sync(() => void unstored.set(blob, bytes))),
            )
        ).pipe(
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

      const treeSide = (
        root: string,
        objects: Map<string, ContentSide>,
        read: { bytes: number },
        unstored: Map<string, Stream.Stream<Uint8Array, BadArgs>> | undefined,
      ) =>
        Effect.fn("Git.treeSide")(function* (entry: TreeEntry | undefined) {
          if (entry === undefined) return { side: { kind: "absent" } } satisfies CapturedSide;
          if (entry.mode === "160000")
            return { side: { kind: "unavailable", reason: "submodule" } } satisfies CapturedSide;
          if (entry.mode === "120000")
            return { side: { kind: "unavailable", reason: "symlink" } } satisfies CapturedSide;
          let side = objects.get(entry.oid);
          if (side === undefined) {
            side = yield* stored(objectBytes(root, entry.oid), read, unstored);
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

      /**
       * The paths Git's attributes mark generated or vendored, read from `source`'s tree (in the
       * object directory `extra` names, if any). Paths are literal, never pathspecs. Reading
       * attributes runs no configured program.
       */
      const generatedIn = Effect.fn("Git.generatedIn")(function* (
        root: string,
        source: string,
        paths: readonly string[],
        extra?: Record<string, string>,
      ) {
        const marked = new Set<string>();
        for (const chunk of argvChunks(paths, (path) => Buffer.byteLength(path) + 1)) {
          const result = yield* run(
            root,
            ["check-attr", "-z", "--source", source, ...generatedAttributes, "--", ...chunk],
            extra,
          );
          if (result.exitCode !== 0)
            return yield* new BadArgs({ message: result.stderr.trim() || "git check-attr failed" });
          // One `path NUL attribute NUL info NUL` record per path and attribute. A leading U+FEFF
          // belongs to the first path.
          const fields = new TextDecoder("utf-8", { ignoreBOM: true })
            .decode(result.stdout)
            .split("\0");
          const requested = new Set(chunk);
          for (let at = 0; at + 2 < fields.length; at += 3) {
            const path = fields[at]!;
            if (!requested.has(path))
              return yield* new InternalError({
                message: "git check-attr reported a path it was not asked about",
                detail: { path },
              });
            if (marks(fields[at + 2]!)) marked.add(path);
          }
        }
        return marked;
      });

      /**
       * A tree of exactly these captured `.gitattributes` files, written to a private object
       * directory, never the repository's: uncommitted attributes then come from the captured
       * bytes, not an index copy of one deleted only from the working tree or a configured
       * `attr.tree`. A file a quota only measured (in `unstored`) is read again, and must be the
       * bytes measured: whether the quota keeps it or not, its attributes apply.
       */
      const attributesTree = Effect.fn("Git.attributesTree")(
        function* (
          root: string,
          files: ReadonlyArray<{ path: string; blob: string }>,
          unstored: Map<string, Stream.Stream<Uint8Array, BadArgs>> | undefined,
        ) {
          const objects = yield* fs.makeTempDirectoryScoped();
          const measuredCopies = yield* fs.makeTempDirectoryScoped();
          const extra = { GIT_OBJECT_DIRECTORY: objects, GIT_INDEX_FILE: join(objects, "index") };
          // Writing the index would run the post-index-change hook, a project program, and a
          // split index would put its shared part in the repository.
          const privateIndex = ["-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false"];
          const failed = (result: { stderr: string }, step: string) =>
            new BadArgs({ message: result.stderr.trim() || `git ${step} failed` });
          const staged: Array<{ path: string; copy: string }> = [];
          for (const [at, { path, blob }] of files.entries()) {
            const bytes = unstored?.get(blob);
            if (bytes === undefined) {
              staged.push({ path, copy: yield* content.materialize(blob) });
              continue;
            }
            const copy = join(measuredCopies, `${at}`);
            const hash = createHash("sha256");
            yield* bytes.pipe(
              Stream.tap((chunk) => Effect.sync(() => void hash.update(chunk))),
              Stream.run(fs.sink(copy)),
            );
            if (hash.digest("hex") !== blob) return yield* Worktree.changedDuringCapture(path);
            staged.push({ path, copy });
          }
          // Each file adds its copy to `hash-object` and `--cacheinfo 100644,<object id>,<path>` to
          // `update-index`; 96 bytes bound the fixed words and the longest (SHA-256) object id.
          const argBytes = ({ path, copy }: { path: string; copy: string }) =>
            Buffer.byteLength(path) + Buffer.byteLength(copy) + 96;
          for (const chunk of argvChunks(staged, argBytes)) {
            const hashed = yield* run(
              root,
              ["hash-object", "-w", "--no-filters", "--", ...chunk.map(({ copy }) => copy)],
              extra,
            );
            if (hashed.exitCode !== 0) return yield* failed(hashed, "hash-object");
            const oids = text(hashed.stdout).trim().split("\n");
            const indexed = yield* run(
              root,
              [
                ...privateIndex,
                "update-index",
                "--add",
                ...chunk.flatMap(({ path }, at) => ["--cacheinfo", `100644,${oids[at]},${path}`]),
              ],
              extra,
            );
            if (indexed.exitCode !== 0) return yield* failed(indexed, "update-index");
          }
          const written = yield* run(root, [...privateIndex, "write-tree"], extra);
          if (written.exitCode !== 0) return yield* failed(written, "write-tree");
          return { tree: text(written.stdout).trim(), extra };
        },
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new InternalError({
              message: "could not stage captured attributes",
              detail: error.message,
            }),
          ),
        ),
      );

      // A range and a PR share the commit-pair capture; only uncommitted work reads the checkout.
      const snapshot = Effect.fn("Git.snapshot")(function* (
        root: string,
        scope: Scope,
        commits: CommitProvenance | undefined,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void>,
        given: Generated,
      ) {
        const limit = yield* Effect.fromResult(quota);
        // Under a quota each side is only measured until the quota admits it, so text it leaves
        // out never occupies the content store.
        const unstored =
          limit._tag === "Some" ? new Map<string, Stream.Stream<Uint8Array, BadArgs>>() : undefined;
        const objects = new Map<string, ContentSide>();
        const read = { bytes: 0 };
        const fromTree = treeSide(root, objects, read, unstored);
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
        /**
         * A changed file's attributes come from its new side, or its old side once deleted. An
         * uncommitted new side (`newCommit` null) reads the captured `.gitattributes` files.
         */
        const generatedOf = Effect.fnUntraced(function* (
          oldCommit: string | null,
          newCommit: string | null,
        ) {
          const changes = sides.filter(({ old, new: current }) => changed(old, current));
          if (given) return new Set(changes.flatMap(({ path }) => (given.has(path) ? [path] : [])));
          const deleted = changes.filter(({ new: current }) => current.side.kind === "absent");
          const present = changes.filter(({ new: current }) => current.side.kind !== "absent");
          const paths = (list: typeof changes) => list.map(({ path }) => path);
          const marked = new Set<string>();
          // Absent on both sides is never recorded, so a deletion always has an old commit.
          if (deleted.length > 0)
            for (const path of yield* generatedIn(root, oldCommit!, paths(deleted)))
              marked.add(path);
          if (present.length > 0) {
            const newSide =
              newCommit === null
                ? yield* attributesTree(
                    root,
                    sides.flatMap(({ path, new: { side } }) =>
                      (path === ".gitattributes" || path.endsWith("/.gitattributes")) &&
                      side.kind === "text"
                        ? [{ path, blob: side.blob }]
                        : [],
                    ),
                    unstored,
                  )
                : { tree: newCommit, extra: undefined };
            for (const path of yield* generatedIn(
              root,
              newSide.tree,
              paths(present),
              newSide.extra,
            ))
              marked.add(path);
          }
          return marked;
        }, Effect.scoped);
        let generated: ReadonlySet<string>;
        let provenance: Provenance;
        if (commits) {
          provenance = commits;
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
          generated = yield* generatedOf(provenance.mergeBase ?? provenance.base, provenance.head);
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
                    side: yield* stored(Worktree.read(root, path, entry), read, unstored),
                    mode: entry.executable ? "100755" : "100644",
                  }
                : entry.kind === "symlink"
                  ? { side: { kind: "unavailable", reason: "symlink" } }
                  : { side: { kind: "absent" } };
            if (old.side.kind !== "absent" || current.side.kind !== "absent")
              sides.push({ path, old, new: current });
          }
          if (paths.length > 0) yield* report("capture", paths.length, paths.length);
          generated = yield* generatedOf(baseline, null);
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
            ...(generated.has(path) && { generated: true as const }),
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
        const captured =
          limit._tag === "Some"
            ? yield* withinQuota(
                files,
                new Set(diffed.map(({ path }) => path)),
                Number(limit.value),
              )
            : files;
        if (unstored)
          for (const file of captured)
            for (const side of [file.old, file.new]) {
              if (side.kind !== "text" || !unstored.has(side.blob)) continue;
              const bytes = unstored.get(side.blob)!;
              unstored.delete(side.blob);
              // Read again: a working-tree file edited since it was measured fails the capture.
              const again = yield* stored(bytes, { bytes: 0 });
              if (again.kind !== "text" || again.blob !== side.blob)
                return yield* Worktree.changedDuringCapture(file.path);
            }
        const hunks = [];
        yield* report("diff", 0, diffed.length);
        for (const [index, { path, old, new: current }] of diffed.entries()) {
          hunks.push(...(yield* hunksOf(path, old, current)));
          yield* report("diff", index + 1, diffed.length);
        }
        return { scope, provenance, files: captured, hunks } satisfies SnapshotManifest;
      });

      /**
       * The commits a resolved range contains, oldest first: those reachable from its head and not
       * from its base, for `..` and `...` alike. `base...head` would add the base's own commits.
       */
      const rangeCommits = Effect.fn("Git.rangeCommits")(function* (
        root: string,
        { base, head: tip }: CommitProvenance,
      ) {
        const commits: Commit[] = [];
        yield* records(
          root,
          [
            "log",
            "-z",
            "--reverse",
            "--topo-order",
            "--no-show-signature",
            "--encoding=UTF-8",
            "--format=%H%n%B",
            "--end-of-options",
            tip,
            `^${base}`,
          ],
          (record) => {
            const [, id, message] =
              /^([0-9a-f]{40}|[0-9a-f]{64})\n([\s\S]*)$/u.exec(text(record)) ?? [];
            if (id === undefined)
              return Effect.fail(
                new BadArgs({ message: "git log printed a commit it could not frame" }),
              );
            commits.push({ id, message: message!.replace(/\n+$/u, "") });
            return Effect.void;
          },
        );
        return commits;
      });

      const capture = Effect.fn("Git.capture")(function* (
        root: string,
        scope: LocalScope,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void> = () => Effect.void,
        generated?: Generated,
      ) {
        if (scope.kind !== "range")
          return yield* snapshot(root, scope, undefined, onProgress, generated);
        const commits = yield* range(root, scope.range);
        const messages = yield* rangeCommits(root, commits);
        return {
          ...(yield* snapshot(root, scope, commits, onProgress, generated)),
          commits: messages,
        };
      });

      const capturePullRequest = Effect.fn("Git.capturePullRequest")(function* (
        root: string,
        scope: PullRequestScope,
        target: PullRequestTarget,
        onProgress: (progress: CaptureProgress) => Effect.Effect<void> = () => Effect.void,
        generated?: Generated,
      ) {
        const commits = yield* pullRequestRange(root, scope, target);
        return yield* snapshot(root, scope, { kind: "pr", ...commits }, onProgress, generated);
      });

      return Git.of({ repoRoot, capture, capturePullRequest, pullRequestRange });
    }),
  );
}
