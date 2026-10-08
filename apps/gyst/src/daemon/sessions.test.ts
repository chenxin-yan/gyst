import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApplyEnvelope,
  BadArgs,
  type ByteRange,
  InternalError,
  type Scope,
  type Session,
  type ManifestFile,
  pageBytes,
  type PullRequest,
  type PullRequestScope,
  type BrowserRequest,
  type Request,
  SessionSchema,
  type SnapshotManifest,
  snapshotIdOf,
  SourceUnavailable,
} from "@gyst/core";
import {
  ConfigProvider,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PlatformError,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, publishingContent } from "./capture-doubles.ts";
import { CapturedContent } from "./content.ts";
import { Git, type PullRequestTarget } from "./git.ts";
import { GitHub, type StackDiscovery } from "./github.ts";
import { Paths } from "./paths.ts";
import { Sessions } from "./sessions.ts";
import { type DeleteReceipt, SessionStore } from "./store.ts";

type Operation = Request | BrowserRequest;
type Input<C extends Operation["command"]> = Extract<Operation, { readonly command: C }>;
const root = "/repo";
const otherRoot = "/other";
const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-three
+four
`;

let files: Map<string, Session>;
let deleteReceipts: ReadonlyArray<DeleteReceipt>;
let captureCalls: Array<{ root: string; scope: Scope; target?: PullRequestTarget }>;
/** Every GitHub read, in order; local and range sessions must leave it empty. */
let githubCalls: Array<{ method: "pullRequest" | "stack"; number: number }>;
let headRefOid: string;
let discovery: StackDiscovery;
let pullRequestFailure: SourceUnavailable | undefined;
/** Fields GitHub now reports differently for every PR, such as a new state. */
let pullRequestEdit: Partial<PullRequest>;
let pullRequestCaptureFailure: SourceUnavailable | undefined;
let saveFails: boolean;
let removeFails: boolean;
/** Session files this version cannot read, as `SessionStore.loadUndecodable` returns them. */
let undecodable: string[];
let nextId: number;
let gitPatch: string;
let supporting: Record<string, string>;
let patchEffect:
  | Effect.Effect<SnapshotManifest, SourceUnavailable | BadArgs | InternalError>
  | undefined;
let manifestFails: boolean;
let slowCapture: boolean;
/** Files the capture double adds without content: binary, symlink or submodule sides. */
let uncaptured: ManifestFile[];
/** When set, each capture signals `started` and then waits for `release`. */
let gate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
const withUncaptured = (manifest: SnapshotManifest): SnapshotManifest => ({
  ...manifest,
  files: [...manifest.files, ...uncaptured].sort((a, b) => (a.path < b.path ? -1 : 1)),
});
const holdCaptures = Effect.gen(function* () {
  const held = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
  gate = held;
  return held;
});
/** When set, the next session save signals `started` and waits for `release` before writing. */
let saveGate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
const holdNextSave = Effect.gen(function* () {
  const held = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
  saveGate = held;
  return held;
});
/** When set, each stack discovery signals `started` and then waits for `release`. */
let stackGate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
/** Content publications and session saves, in order. */
let commits: string[];

// Deterministic bytes: the n-th id is `nnnnnnnn-nnnn-4nnn-8nnn-nnnnnnnnnnnn` in hex.
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(++nextId),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const capturing = (scope: Scope) =>
  Effect.suspend(() => {
    const captured =
      patchEffect ?? Effect.sync(() => withUncaptured(manifestOf(gitPatch, scope, supporting)));
    const delayed = slowCapture ? Effect.delay(captured, "20 millis") : captured;
    return gate
      ? Deferred.succeed(gate.started, undefined).pipe(
          Effect.andThen(Deferred.await(gate.release)),
          Effect.andThen(delayed),
        )
      : delayed;
  });
const git = Layer.succeed(Git, {
  repoRoot: (cwd) =>
    cwd.startsWith(root) || cwd.startsWith(otherRoot)
      ? Effect.succeed(cwd.startsWith(root) ? root : otherRoot)
      : Effect.fail(new BadArgs({ message: "current directory is not inside a git repository" })),
  capture: (root, scope) =>
    Effect.suspend(() => {
      captureCalls.push({ root, scope });
      return capturing(scope);
    }),
  capturePullRequest: (root, scope, target) =>
    Effect.suspend(() => {
      captureCalls.push({ root, scope, target });
      const captured: Effect.Effect<SnapshotManifest, SourceUnavailable | BadArgs | InternalError> =
        pullRequestCaptureFailure ? Effect.fail(pullRequestCaptureFailure) : capturing(scope);
      return captured;
    }),
  pullRequestRange: () => Effect.die("Sessions captures PRs through capturePullRequest"),
});

const pullRequestOf = (number: number): PullRequest => ({
  number,
  title: `Layer ${number}`,
  description: `Why layer ${number}`,
  state: "open",
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: number === 1 ? "main" : `layer-${number - 1}`,
  headRefName: `layer-${number}`,
});
const github = Layer.succeed(GitHub, {
  pullRequest: (scope) =>
    Effect.suspend(() => {
      githubCalls.push({ method: "pullRequest", number: scope.number });
      return pullRequestFailure
        ? Effect.fail(pullRequestFailure)
        : Effect.succeed({
            pullRequest: { ...pullRequestOf(scope.number), ...pullRequestEdit },
            headRefOid,
          });
    }),
  stack: (scope) =>
    Effect.suspend(() => {
      githubCalls.push({ method: "stack", number: scope.number });
      const held = stackGate;
      const answer = Effect.sync(() => discovery);
      return held
        ? Deferred.succeed(held.started, undefined).pipe(
            Effect.andThen(Deferred.await(held.release)),
            Effect.andThen(answer),
          )
        : answer;
    }),
});

const content = publishingContent((manifest) =>
  manifestFails
    ? Effect.fail(writeFailure)
    : Effect.sync(() => {
        commits.push(`manifest ${manifest.files.map(({ path }) => path).join(",")}`);
        return snapshotIdOf(manifest);
      }),
);

const writeFailure = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "writeFile",
});

const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  loadUndecodable: Effect.sync(() => undecodable),
  save: (session) =>
    Effect.suspend(() => {
      if (saveFails) return Effect.fail(writeFailure);
      const write = Effect.sync(() => {
        commits.push(`session ${session.id}`);
        files.set(session.id, session);
      });
      const held = saveGate;
      saveGate = undefined;
      return held
        ? Deferred.succeed(held.started, undefined).pipe(
            Effect.andThen(Deferred.await(held.release)),
            Effect.andThen(write),
          )
        : write;
    }),
  remove: (id) =>
    removeFails
      ? Effect.fail(writeFailure)
      : Effect.sync(() => {
          files.delete(id);
        }),
  loadDeleteReceipts: Effect.sync(() => deleteReceipts),
  saveDeleteReceipts: (receipts) =>
    saveFails
      ? Effect.fail(writeFailure)
      : Effect.sync(() => {
          deleteReceipts = receipts;
        }),
  loadLaunchPaths: Effect.succeed({}),
  saveLaunchPaths: () => Effect.void,
});

const sessionsLayer = Sessions.layer.pipe(
  Layer.provide(Layer.mergeAll(git, github, store, crypto, content)),
);
// Like the daemon: persisted sessions are loaded once the service is built, not while building it.
// Each `run` is a fresh daemon over the same persisted files and receipts.
const run = <A, E>(effect: Effect.Effect<A, E, Sessions>) =>
  Effect.runPromise(
    Effect.provide(Sessions.use((s) => s.load).pipe(Effect.andThen(effect)), sessionsLayer),
  );
const failure = <A, E>(effect: Effect.Effect<A, E, Sessions>) => run(Effect.flip(effect));
/** A browser's Viewed request against the session as it is now. */
const viewedNow = (session: string, hunkIds: string[], requestId: string, viewed = true) =>
  Sessions.use((s) =>
    Effect.gen(function* () {
      const { revision, session: summary } = yield* s.status({ command: "status", session });
      const request: Input<"viewed"> = {
        command: "viewed",
        session,
        snapshotId: summary.snapshotId,
        revision,
        requestId,
        hunkIds,
        viewed,
      };
      return { request, result: yield* s.viewed(request) };
    }),
  );

let refreshCount = 0;
/** A refresh of the session's current snapshot, as a caller that just read its status sends it. */
const refreshNow = (session: string, requestId = `refresh-${++refreshCount}`) =>
  Sessions.use((s) =>
    Effect.gen(function* () {
      const { session: summary } = yield* s.status({ command: "status", session });
      return yield* s.refresh({
        command: "refresh",
        session,
        snapshotId: summary.snapshotId,
        requestId,
      });
    }),
  );

const persistedNote = (id: string, path: string) => ({
  id,
  anchor: {
    snapshotId: "persisted-snapshot",
    path,
    side: "new" as const,
    startLine: 1,
    endLine: 1,
  },
  markdown: "intent and behavior",
  references: [],
});
const persisted: Session = {
  id: "persisted",
  repoRoot: otherRoot,
  scope: { kind: "range", range: "main...feature" },
  snapshotId: "persisted-snapshot",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  hunks: [
    {
      id: "h1",
      file: "x.txt",
      header: "@@ -1 +1 @@",
      patch: "@@ -1 +1 @@\n-a\n+b",
      contentHash: "ab",
    },
    {
      id: "h2",
      file: "y.txt",
      header: "@@ -1 +1 @@",
      patch: "@@ -1 +1 @@\n-c\n+d",
      contentHash: "cd",
    },
    {
      id: "h3",
      file: "y.txt",
      header: "@@ -5 +5 @@",
      patch: "@@ -5 +5 @@\n-e\n+f",
      contentHash: "ef",
    },
  ],
  overview: null,
  groups: [
    {
      id: "g1",
      title: "same edit",
      overview: { markdown: "Same edit.", references: [] },
      hunkIds: ["h1"],
      files: ["x.txt"],
      notes: [persistedNote("n1", "x.txt")],
    },
    {
      id: "g2",
      title: "read me",
      overview: null,
      hunkIds: ["h2"],
      files: ["y.txt"],
      notes: [persistedNote("n2", "y.txt")],
    },
  ],
  viewedHunkIds: ["h1"],
  receiptTexts: [],
  applyReceipts: [],
  viewedReceipts: [],
  refreshReceipts: [],
  threads: [],
  drafts: [],
  conversationReceipts: [],
  pickupReceipts: [],
};

const uncommitted = { kind: "uncommitted" } as const;
const openScope = (scope: Scope = uncommitted, cwd = root) =>
  Sessions.use((s) => s.open({ command: "open", cwd, scope }));

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
  undecodable = [];
  deleteReceipts = [];
  captureCalls = [];
  githubCalls = [];
  headRefOid = "1".repeat(40);
  discovery = {
    ok: true,
    membership: {
      membership: "stacked",
      number: 7,
      baseRefName: "main",
      layers: [1, 2, 3].map((number) => ({
        position: number,
        pullRequest: pullRequestOf(number),
      })),
    },
  };
  pullRequestFailure = undefined;
  pullRequestEdit = {};
  pullRequestCaptureFailure = undefined;
  saveFails = false;
  removeFails = false;
  nextId = 0;
  gitPatch = patch;
  supporting = {};
  patchEffect = undefined;
  manifestFails = false;
  slowCapture = false;
  uncaptured = [];
  gate = undefined;
  saveGate = undefined;
  stackGate = undefined;
  commits = [];
});

describe("Sessions.check", () => {
  it("checks the recorded scope without changing review state, shares results, and resets on refresh", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope(uncommitted, `${root}/nested`);
          const created = yield* sessions.status({ command: "status", session: session.id });
          const ids = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
            ({ id }) => id,
          );
          yield* sessions.apply({
            command: "apply",
            session: session.id,
            batch: JSON.stringify({
              revision: 0,
              snapshotId: session.snapshotId,
              idempotencyKey: "prepare",
              ops: [
                {
                  type: "group.create",
                  id: "step",
                  title: "Change both paths",
                  overview: "Review both changes together.",
                  memberHunkIds: ids,
                },
              ],
            }),
          });
          yield* viewedNow(session.id, ids, "read");
          const reviewed = yield* sessions.status({ command: "status", session: session.id });
          expect(reviewed).toMatchObject({ revision: 2, viewedHunkIds: ids });
          const before = JSON.stringify([...files]);
          gitPatch = patch.replace("+two", "+changed");
          const checks = yield* Effect.all(
            [
              sessions.check({ command: "check", session: session.id }),
              sessions.check({ command: "check", session: session.id }),
            ],
            { concurrency: "unbounded" },
          );
          expect(checks[0]).toMatchObject({
            sessionId: created.session.id,
            revision: 2,
            state: "changed",
          });
          expect(checks[1]).toEqual(checks[0]);
          expect(captureCalls).toEqual([
            { root, scope: uncommitted },
            { root, scope: uncommitted },
          ]);
          expect(JSON.stringify([...files])).toBe(before);
          expect(yield* sessions.status({ command: "status", session: session.id })).toEqual(
            reviewed,
          );
          yield* refreshNow(session.id);
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            revision: 3,
            state: "unchanged",
          });
          expect(captureCalls).toHaveLength(4);
        }),
      ),
    );
  });

  it.skipIf(process.platform === "win32")(
    "bounds cleanup of Git ignoring SIGTERM without blocking review state or later checks",
    async () => {
      const ready = Promise.withResolvers<number>();
      const spawner = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const live = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return live.spawn(command);
            // Replace only the executable; exercise Git.run's real cancellation options and finalizer.
            return live
              .spawn(
                ChildProcess.make(
                  process.execPath,
                  [
                    "-e",
                    `
            process.on("SIGTERM", () => {});
            console.log("ready");
            setTimeout(() => process.exit(0), 6000);
          `,
                  ],
                  command.options,
                ),
              )
              .pipe(
                Effect.map((handle) => ({
                  ...handle,
                  stdout: handle.stdout.pipe(
                    Stream.tap(() => Effect.sync(() => ready.resolve(handle.pid))),
                  ),
                })),
              );
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      await run(
        Sessions.use((sessions) =>
          Effect.gen(function* () {
            const { session } = yield* openScope();
            const created = yield* sessions.status({ command: "status", session: session.id });
            patchEffect = Git.use((g) => g.capture(process.cwd(), uncommitted)).pipe(
              Effect.provide(
                Git.layer.pipe(
                  Layer.provide(Layer.mergeAll(NodeServices.layer, spawner, publishingContent())),
                ),
              ),
            );
            const started = performance.now();
            const checking = yield* Effect.forkChild(
              sessions.check({ command: "check", session: session.id }),
            );
            const pid = yield* Effect.promise(() => ready.promise);
            expect(
              yield* sessions
                .status({ command: "status", session: session.id })
                .pipe(Effect.timeout("1 second")),
            ).toEqual(created);
            expect(yield* Fiber.join(checking)).toMatchObject({ state: "unavailable" });
            // Two seconds for patch execution plus bounded termination, not the child's six-second exit.
            expect(performance.now() - started).toBeLessThan(4000);
            expect(() => process.kill(pid, 0)).toThrow("ESRCH");
            expect(yield* sessions.status({ command: "status", session: session.id })).toEqual(
              created,
            );
            patchEffect = undefined;
            // An identical capture replaces nothing, but is newer than the cached check.
            yield* refreshNow(session.id);
            expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
              state: "unchanged",
            });
          }),
        ),
      );
    },
    10_000,
  );

  it("expires cached checks, including a return to the captured source", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope();
          gitPatch = patch.replace("+two", "+other");
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            state: "changed",
          });
          gitPatch = patch;
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            state: "changed",
          });
          expect(captureCalls).toHaveLength(2);
          yield* Effect.sleep("5100 millis");
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            state: "unchanged",
          });
          expect(captureCalls).toHaveLength(3);
        }),
      ),
    );
  }, 10_000);

  it("reports an unreadable recorded scope as unavailable without changing saved state", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const before = JSON.stringify([...files]);
          patchEffect = Effect.fail(new BadArgs({ message: "recorded ref is unavailable" }));
          expect(yield* sessions.check({ command: "check", session: persisted.id })).toMatchObject({
            state: "unavailable",
            message: "recorded ref is unavailable",
          });
          expect(captureCalls).toEqual([{ root: otherRoot, scope: persisted.scope }]);
          expect(JSON.stringify([...files])).toBe(before);
        }),
      ),
    );
  });
  it("reports a changed supporting file as changed even when the diff is identical", async () => {
    supporting = { "helper.ts": "export const helper = 1;\n" };
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope();
          supporting = { "helper.ts": "export const helper = 2;\n" };
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            state: "changed",
          });
          expect(commits).toHaveLength(2);
        }),
      ),
    );
  });
  it("reports unavailable, not unchanged, when uncaptured working-tree inputs may have changed", async () => {
    uncaptured = [
      {
        path: "image.bin",
        old: { kind: "unavailable", reason: "binary" },
        new: { kind: "unavailable", reason: "binary" },
      },
      { path: "link", old: { kind: "absent" }, new: { kind: "unavailable", reason: "symlink" } },
    ];
    const range = { kind: "range", range: "main..feature" } as const;
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope();
          const check = sessions.check({ command: "check", session: session.id });
          expect(yield* check).toMatchObject({
            state: "unavailable",
            message: expect.stringMatching(/binary.*symlink.*image\.bin/),
          });
          // Committed endpoints identify every side, so a range compares completely.
          const ranged = yield* openScope(range);
          expect(
            yield* sessions.check({ command: "check", session: ranged.session.id }),
          ).toMatchObject({ state: "unchanged" });
        }),
      ),
    );
    // A difference in the captured inputs is still a definite change.
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const [first] = (yield* sessions.list).sessions.filter(
            (s) => s.scope.kind === "uncommitted",
          );
          gitPatch = patch.replace("+two", "+other");
          expect(yield* sessions.check({ command: "check", session: first!.id })).toMatchObject({
            state: "changed",
          });
        }),
      ),
    );
  });
});

describe("Sessions.open", () => {
  it("captures uncommitted changes of the caller's repository and returns its identity", async () => {
    const opened = await run(openScope(uncommitted, `${root}/sub`));
    const id = "01010101-0101-4101-8101-010101010101";
    expect(opened).toEqual({
      session: {
        id,
        repoRoot: root,
        scope: uncommitted,
        snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      created: true,
    });
    expect(captureCalls).toEqual([{ root, scope: uncommitted }]);
    expect(files.get(id)?.hunks).toHaveLength(2);
    const status = await run(Sessions.use((s) => s.status({ command: "status", session: id })));
    expect(status).toMatchObject({
      revision: 0,
      groups: [],
      viewedHunkIds: [],
      files: [
        { path: "a.txt", hunkCount: 1, viewed: false },
        { path: "b.txt", hunkCount: 1, viewed: false },
      ],
    });
  });

  it("reuses a saved scope as it is after refs move, from any directory and after restart", async () => {
    const first = await run(openScope(uncommitted, `${root}/sub`));
    const saved = JSON.stringify([...files]);
    gitPatch = patch.replace("+two", "+moved");
    const again = await run(
      Effect.gen(function* () {
        const reused = yield* openScope(uncommitted, `${root}/elsewhere`);
        expect(yield* openScope(uncommitted, root)).toEqual(reused);
        return reused;
      }),
    );
    expect(again).toEqual({ ...first, created: false });
    expect(captureCalls).toHaveLength(1);
    expect(JSON.stringify([...files])).toBe(saved);
    // The persisted range session resumes by scope, and by its exact id, without a capture.
    const byScope = await run(openScope(persisted.scope, otherRoot));
    const byId = await run(Sessions.use((s) => s.open({ command: "open", session: persisted.id })));
    expect(byScope).toEqual(byId);
    expect(byId).toMatchObject({
      created: false,
      session: { id: persisted.id, snapshotId: persisted.snapshotId },
    });
    expect(captureCalls).toHaveLength(1);
    expect(
      (await failure(Sessions.use((s) => s.open({ command: "open", session: "nope" }))))._tag,
    ).toBe("no_session");
  });

  it("keeps differently recorded scopes apart even when their diffs are equal", async () => {
    const scopes: Scope[] = [
      uncommitted,
      { kind: "range", range: "main...feature" },
      { kind: "range", range: "main..feature" },
    ];
    const opened = await run(Effect.forEach(scopes, (scope) => openScope(scope)));
    expect(new Set(opened.map(({ session }) => session.id)).size).toBe(3);
    // The recorded scope is part of the snapshot's identity, so equal diffs are distinct snapshots.
    expect(new Set(opened.map(({ session }) => session.snapshotId)).size).toBe(3);
    expect(opened.map(({ session }) => session.scope)).toEqual(scopes);
    // Equal scope, other repository: the persisted session, not the one just opened.
    expect((await run(openScope(scopes[1], otherRoot))).session.id).toBe(persisted.id);
    const { sessions } = await run(Sessions.use((s) => s.list));
    expect(sessions.map(({ id }) => id).sort()).toEqual(
      [persisted.id, ...opened.map(({ session }) => session.id)].sort(),
    );
    expect(sessions[0]).toEqual({
      id: persisted.id,
      repoRoot: otherRoot,
      scope: persisted.scope,
      snapshotId: persisted.snapshotId,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
    });
  });

  it("serializes concurrent opens so one scope gets exactly one session", async () => {
    slowCapture = true;
    const range = { kind: "range", range: "main..feature" } as const;
    const results = await run(
      Effect.all([openScope(), openScope(), openScope(range), openScope(range)], {
        concurrency: "unbounded",
      }),
    );
    const [a, b, c, d] = results.map(({ session }) => session.id);
    expect(a).toBe(b);
    expect(c).toBe(d);
    expect(a).not.toBe(c);
    expect(results.map(({ created }) => created)).toEqual([true, false, true, false]);
    expect(captureCalls).toHaveLength(2);
    expect(files.size).toBe(3);
  });

  it("rejects directories outside a repository and invalid captures without saving", async () => {
    expect(await failure(openScope(uncommitted, "/elsewhere"))).toMatchObject({
      _tag: "bad_args",
      message: "current directory is not inside a git repository",
    });
    patchEffect = Effect.fail(new BadArgs({ message: "the working tree changed" }));
    expect(await failure(openScope())).toMatchObject({
      _tag: "bad_args",
      message: "the working tree changed",
    });
    patchEffect = undefined;
    manifestFails = true;
    expect(await failure(openScope())).toMatchObject({
      _tag: "internal_error",
      message: "could not publish the captured snapshot",
    });
    expect([...files.keys()]).toEqual([persisted.id]);
    expect(commits).toEqual([]);
  });

  it("publishes the snapshot manifest before the session that names it", async () => {
    supporting = { "helper.ts": "export const helper = 1;\n" };
    const { session } = await run(openScope());
    expect(commits).toEqual([`manifest a.txt,b.txt,helper.ts`, `session ${session.id}`]);
    expect(session.snapshotId).toBe(snapshotIdOf(manifestOf(patch, uncommitted, supporting)));
  });

  it("keeps a session out of memory when capture, publication or persistence fails", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const listed = () =>
          sessions.list.pipe(Effect.map(({ sessions }) => sessions.map(({ id }) => id)));
        patchEffect = Effect.fail(new BadArgs({ message: "the working tree changed" }));
        expect(Exit.isFailure(yield* Effect.exit(openScope()))).toBe(true);
        expect(yield* listed()).toEqual([persisted.id]);
        patchEffect = undefined;
        manifestFails = true;
        expect(Exit.isFailure(yield* Effect.exit(openScope()))).toBe(true);
        expect(yield* listed()).toEqual([persisted.id]);
        manifestFails = false;
        saveFails = true;
        expect(Exit.isFailure(yield* Effect.exit(openScope()))).toBe(true);
        expect(yield* listed()).toEqual([persisted.id]);
        expect([...files.keys()]).toEqual([persisted.id]);
        // The same instance still opens once the fault clears.
        saveFails = false;
        expect((yield* openScope()).created).toBe(true);
      }),
    );
  });

  it("keeps other sessions readable and writable while a capture is in progress", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const held = yield* holdCaptures;
          const opening = yield* Effect.forkChild(openScope());
          yield* Deferred.await(held.started);
          const status = yield* sessions
            .status({ command: "status", session: persisted.id })
            .pipe(Effect.timeout("1 second"));
          expect(status.revision).toBe(persisted.revision);
          const applied = yield* sessions
            .apply({
              command: "apply",
              session: persisted.id,
              batch: JSON.stringify({
                revision: persisted.revision,
                snapshotId: persisted.snapshotId,
                idempotencyKey: "during-capture",
                ops: [
                  {
                    type: "group.create",
                    id: "g3",
                    memberHunkIds: ["h3"],
                    title: "third",
                    overview: "third",
                  },
                ],
              }),
            })
            .pipe(Effect.timeout("1 second"));
          expect(applied.revision).toBe(persisted.revision + 1);
          expect((yield* sessions.list.pipe(Effect.timeout("1 second"))).sessions).toHaveLength(1);
          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(opening)).created).toBe(true);
          expect(files.size).toBe(2);
        }),
      ),
    );
  });
});

describe("Sessions PR sessions", () => {
  const layer2: PullRequestScope = { kind: "pr", repository: "acme/widgets", number: 2 };
  const decodeSession = Schema.decodeUnknownSync(SessionSchema);
  const unavailable = (reason: "gh_missing" | "objects_missing") =>
    new SourceUnavailable({ message: `PR source unavailable: ${reason}`, detail: { reason } });

  it("captures the PR's range at GitHub's head and stores its attempted stack discovery", async () => {
    const opened = await run(openScope(layer2, `${root}/sub`));
    expect(opened).toMatchObject({ created: true, session: { repoRoot: root, scope: layer2 } });
    expect(captureCalls).toEqual([
      { root, scope: layer2, target: { baseRefName: "layer-1", headRefOid } },
    ]);
    expect(githubCalls).toEqual([
      { method: "pullRequest", number: 2 },
      { method: "stack", number: 2 },
    ]);
    const saved = decodeSession(files.get(opened.session.id));
    expect(saved.pullRequest).toEqual({
      pullRequest: pullRequestOf(2),
      stack: { verifiedAt: expect.any(String), ...(discovery.ok && discovery.membership) },
      unavailable: null,
    });
  });

  it("reuses the saved PR session as it is after its head, stack or checkout changes, without asking GitHub", async () => {
    const first = await run(openScope(layer2));
    const saved = JSON.stringify([...files]);
    const calls = githubCalls.length;
    headRefOid = "2".repeat(40);
    gitPatch = patch.replace("+two", "+restacked");
    discovery = { ok: false, reason: "github_failed" };
    const again = await run(
      Effect.gen(function* () {
        const elsewhere = yield* openScope(layer2, otherRoot);
        expect(yield* openScope(layer2, `${root}/sub`)).toEqual(elsewhere);
        return elsewhere;
      }),
    );
    expect(again).toEqual({ ...first, created: false });
    expect(githubCalls).toHaveLength(calls);
    expect(captureCalls).toHaveLength(1);
    expect(JSON.stringify([...files])).toBe(saved);
  });

  it("keeps a PR apart from a range with an equal diff, and from other PRs and repositories", async () => {
    const scopes: Scope[] = [
      { kind: "range", range: "layer-1...layer-2" },
      layer2,
      { ...layer2, number: 3 },
      { ...layer2, repository: "acme/gadgets" },
    ];
    const opened = await run(Effect.forEach(scopes, (scope) => openScope(scope)));
    expect(new Set(opened.map(({ session }) => session.id)).size).toBe(4);
    expect(new Set(opened.map(({ session }) => session.snapshotId)).size).toBe(4);
    expect(files.get(opened[0]!.session.id)?.pullRequest).toBeUndefined();
    expect((await run(openScope(scopes[1]))).session.id).toBe(opened[1]!.session.id);
  });

  it("never asks GitHub for uncommitted or range sessions", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          for (const scope of [uncommitted, { kind: "range", range: "main...feature" } as const]) {
            const { session } = yield* openScope(scope);
            yield* sessions.check({ command: "check", session: session.id });
            yield* refreshNow(session.id);
          }
        }),
      ),
    );
    expect(captureCalls.map(({ scope }) => scope.kind)).toEqual([
      "uncommitted",
      "uncommitted",
      "uncommitted",
      "range",
      "range",
      "range",
    ]);
    expect(githubCalls).toEqual([]);
  });

  it("saves nothing when GitHub or the PR's Git objects are unavailable", async () => {
    const saved = JSON.stringify([...files]);
    pullRequestFailure = unavailable("gh_missing");
    expect(await failure(openScope(layer2))).toBe(pullRequestFailure);
    expect(captureCalls).toEqual([]);
    pullRequestFailure = undefined;
    pullRequestCaptureFailure = unavailable("objects_missing");
    expect(await failure(openScope(layer2))).toBe(pullRequestCaptureFailure);
    // Discovery is attempted only once the PR's own range resolved.
    expect(githubCalls.map(({ method }) => method)).toEqual(["pullRequest", "pullRequest"]);
    expect(commits).toEqual([]);
    expect(JSON.stringify([...files])).toBe(saved);
  });

  it("opens a resolvable PR standalone when stack discovery is unavailable", async () => {
    discovery = { ok: false, reason: "github_failed" };
    const opened = await run(openScope(layer2));
    expect(opened.created).toBe(true);
    expect(decodeSession(files.get(opened.session.id)).pullRequest).toEqual({
      pullRequest: pullRequestOf(2),
      stack: null,
      unavailable: { at: expect.any(String), reason: "github_failed" },
    });
  });

  it("refreshes only the PR's range at its current head and keeps the stack context", async () => {
    const { session } = await run(openScope(layer2));
    const context = files.get(session.id)?.pullRequest;
    headRefOid = "2".repeat(40);
    gitPatch = patch.replace("+two", "+restacked");
    discovery = { ok: false, reason: "github_failed" };
    const refreshed = await run(refreshNow(session.id));
    expect(refreshed.snapshotId).not.toBe(session.snapshotId);
    expect(captureCalls.at(-1)).toEqual({
      root,
      scope: layer2,
      target: { baseRefName: "layer-1", headRefOid },
    });
    expect(githubCalls.map(({ method }) => method)).toEqual([
      "pullRequest",
      "stack",
      "pullRequest",
    ]);
    expect(decodeSession(files.get(session.id)).pullRequest).toEqual(context);

    // A refresh that cannot read the PR changes nothing.
    const saved = JSON.stringify([...files]);
    pullRequestFailure = unavailable("gh_missing");
    expect(await failure(refreshNow(session.id))).toBe(pullRequestFailure);
    expect(JSON.stringify([...files])).toBe(saved);
  });

  it("checks a PR against GitHub's current head and reports an unreadable PR as unavailable", async () => {
    const { session } = await run(openScope(layer2));
    const check = Sessions.use((s) => s.check({ command: "check", session: session.id }));
    expect(await run(check)).toMatchObject({ state: "unchanged" });
    gitPatch = patch.replace("+two", "+moved");
    expect(await run(check)).toMatchObject({ state: "changed" });
    pullRequestFailure = unavailable("gh_missing");
    expect(await run(check)).toEqual({
      sessionId: session.id,
      snapshotId: session.snapshotId,
      revision: 0,
      state: "unavailable",
      message: pullRequestFailure.message,
      checkedAt: expect.any(String),
    });
    expect(githubCalls.filter(({ method }) => method === "stack")).toHaveLength(1);
  });
});

describe("Sessions PR stacks", () => {
  const scopeOf = (number: number): PullRequestScope => ({
    kind: "pr",
    repository: "acme/widgets",
    number,
  });
  const layers = (...numbers: number[]) =>
    numbers.map((number, index) => ({ position: index + 1, pullRequest: pullRequestOf(number) }));
  const stacked = (...numbers: number[]): StackDiscovery => ({
    ok: true,
    membership: {
      membership: "stacked",
      number: 7,
      baseRefName: "main",
      layers: layers(...numbers),
    },
  });
  const statusOf = (session: string) =>
    Sessions.use((s) => s.status({ command: "status", session }));
  const recheck = (session: string) => Sessions.use((s) => s.stack({ command: "stack", session }));
  const openLayer = (session: string, number: number) =>
    Sessions.use((s) => s.layer({ command: "layer", session, number }));
  /** Everything a recheck must leave as it was: snapshot, review state, receipts and timestamps. */
  const reviewState = (session: Session) => ({ ...session, pullRequest: undefined });

  it("reports the whole known stack with the selected PR and only its opened layers' sessions", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    const status = await run(statusOf(b.id));
    expect(status.pullRequest).toEqual({
      ...files.get(b.id)!.pullRequest,
      selected: 2,
      sessions: [{ number: 2, sessionId: b.id, hunkCount: 2, viewedCount: 0, openThreads: 0 }],
    });
    expect(status.pullRequest?.stack).toMatchObject({ layers: layers(1, 2, 3) });
    expect((await run(statusOf(persisted.id))).pullRequest).toBeUndefined();
  });

  it("rechecks metadata only: membership, order and PR state change while snapshot and review state do not", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    const [first] = (await run(Sessions.use((s) => s.diff({ command: "diff", session: b.id }))))
      .hunks;
    await run(viewedNow(b.id, [first!.id], "viewed-1"));
    const before = files.get(b.id)!;
    const captures = captureCalls.length;
    const commitsBefore = commits.length;
    pullRequestEdit = {
      state: "merged",
      title: "Renamed layer",
      description: "<img src=x onerror=alert(1)> Rewritten.",
    };
    discovery = stacked(3, 2, 1);
    const result = await run(recheck(b.id));
    const after = files.get(b.id)!;
    expect(reviewState(after)).toEqual(reviewState(before));
    expect(after.pullRequest).toEqual({
      pullRequest: { ...pullRequestOf(2), ...pullRequestEdit },
      stack: {
        verifiedAt: expect.any(String),
        membership: "stacked",
        number: 7,
        baseRefName: "main",
        layers: layers(3, 2, 1),
      },
      unavailable: null,
    });
    expect(result).toEqual({
      sessionId: b.id,
      pullRequest: (await run(statusOf(b.id))).pullRequest,
    });
    expect(result.pullRequest.sessions).toEqual([
      { number: 2, sessionId: b.id, hunkCount: 2, viewedCount: 1, openThreads: 0 },
    ]);
    // The description follows the recheck like the title, as untrusted text stored verbatim.
    expect(result.pullRequest.pullRequest.description).toBe(
      "<img src=x onerror=alert(1)> Rewritten.",
    );
    // No capture, no publication: one session save only.
    expect(captureCalls).toHaveLength(captures);
    expect(commits.slice(commitsBefore)).toEqual([`session ${b.id}`]);
    expect(githubCalls.slice(-2)).toEqual([
      { method: "pullRequest", number: 2 },
      { method: "stack", number: 2 },
    ]);
  });

  it("keeps the last verified stack when a recheck fails, recording unavailable rather than removal", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    const verified = files.get(b.id)!.pullRequest!;
    discovery = { ok: false, reason: "github_failed" };
    const failed = await run(recheck(b.id));
    expect(failed.pullRequest).toMatchObject({
      pullRequest: verified.pullRequest,
      stack: verified.stack,
      unavailable: { at: expect.any(String), reason: "github_failed" },
    });
    // A PR GitHub cannot read keeps its last metadata too, and stack discovery is not attempted.
    const calls = githubCalls.length;
    pullRequestFailure = new SourceUnavailable({
      message: "gh is not installed",
      detail: { reason: "gh_missing" },
    });
    pullRequestEdit = { state: "closed" };
    expect((await run(recheck(b.id))).pullRequest).toMatchObject({
      pullRequest: verified.pullRequest,
      stack: verified.stack,
      unavailable: { reason: "gh_missing" },
    });
    expect(githubCalls.slice(calls)).toEqual([{ method: "pullRequest", number: 2 }]);
    // The next success clears unavailable.
    pullRequestFailure = undefined;
    discovery = stacked(1, 2, 3);
    expect((await run(recheck(b.id))).pullRequest).toMatchObject({
      pullRequest: { state: "closed" },
      unavailable: null,
    });
  });

  it("keeps a layer removed by a verified recheck reachable as its saved session", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    const { session: c } = await run(openLayer(b.id, 3));
    discovery = stacked(1, 2);
    const result = await run(recheck(b.id));
    expect(result.pullRequest.stack).toMatchObject({ layers: layers(1, 2) });
    expect(result.pullRequest.sessions.map(({ number }) => number)).toEqual([2]);
    const { sessions } = await run(Sessions.use((s) => s.list));
    expect(sessions.map(({ id }) => id)).toContain(c.id);
    // Each session keeps its own last verification until it is rechecked itself.
    expect((await run(statusOf(c.id))).pullRequest).toMatchObject({
      selected: 3,
      stack: { layers: layers(1, 2, 3) },
    });
    discovery = { ok: true, membership: { membership: "none" } };
    expect((await run(recheck(c.id))).pullRequest).toMatchObject({
      selected: 3,
      stack: { membership: "none" },
      sessions: [{ number: 3, sessionId: c.id }],
    });
    expect(
      await run(Sessions.use((s) => s.open({ command: "open", session: c.id }))),
    ).toMatchObject({ created: false, session: { id: c.id } });
    // Removed from the known stack, it can no longer be opened as one of B's layers.
    expect(await failure(openLayer(b.id, 3))).toMatchObject({ _tag: "validation_failed" });
  });

  it("does not resurrect a session deleted while its recheck read GitHub", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    const outcome = await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const held = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        stackGate = held;
        const fiber = yield* Effect.forkChild(sessions.stack({ command: "stack", session: b.id }));
        yield* Deferred.await(held.started);
        // Other sessions stay readable while GitHub answers.
        yield* sessions.status({ command: "status", session: persisted.id });
        yield* sessions.delete({ command: "delete", session: b.id, requestId: "gone" });
        yield* Deferred.succeed(held.release, undefined);
        return yield* Effect.flip(Fiber.join(fiber));
      }),
    );
    expect(outcome).toMatchObject({ _tag: "no_session" });
    expect(files.has(b.id)).toBe(false);
  });

  it("opens an unopened layer plainly from the selected session's checkout and resumes a saved one as it is", async () => {
    const { session: b } = await run(openScope(scopeOf(2), `${root}/sub`));
    const captures = captureCalls.length;
    const opened = await run(openLayer(b.id, 3));
    expect(opened).toMatchObject({ created: true, session: { repoRoot: root, scope: scopeOf(3) } });
    expect(captureCalls.slice(captures)).toEqual([
      { root, scope: scopeOf(3), target: { baseRefName: "layer-2", headRefOid } },
    ]);
    const c = files.get(opened.session.id)!;
    expect(c.groups).toEqual([]);
    expect(c.revision).toBe(0);
    expect(c.pullRequest?.pullRequest).toEqual(pullRequestOf(3));

    const saved = JSON.stringify([...files]);
    const calls = githubCalls.length;
    headRefOid = "2".repeat(40);
    gitPatch = patch.replace("+two", "+restacked");
    expect(await run(openLayer(b.id, 3))).toEqual({ ...opened, created: false });
    // The selected PR is a layer too: it resumes itself.
    expect((await run(openLayer(b.id, 2))).session.id).toBe(b.id);
    expect(githubCalls).toHaveLength(calls);
    expect(captureCalls).toHaveLength(captures + 1);
    expect(JSON.stringify([...files])).toBe(saved);
    expect((await run(statusOf(b.id))).pullRequest?.sessions.map(({ number }) => number)).toEqual([
      2, 3,
    ]);
  });

  it("announces a recheck and other layers' changes to a stack's open sessions at their revision, by context alone", async () => {
    const { session: b } = await run(openScope(scopeOf(2)));
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* Sessions;
          const { version, events } = yield* s.subscribe({ session: b.id });
          expect(version).toMatchObject({ revision: 0, context: expect.any(String) });
          const nothing = Queue.poll(events).pipe(Effect.map(Option.isNone));
          // Each frame is B's whole version now, as a new subscriber would read it.
          const announced = Effect.gen(function* () {
            const change = yield* Queue.take(events);
            const now = (yield* s.subscribe({ session: b.id })).version;
            expect(change).toEqual({ kind: "changed", ...now });
            expect(yield* nothing).toBe(true);
            return now;
          });
          const contexts = [version.context];
          const heard = (revision: number) =>
            Effect.gen(function* () {
              const now = yield* announced;
              expect(now.revision).toBe(revision);
              expect(now.context).not.toBe(contexts.at(-1));
              contexts.push(now.context);
            });

          discovery = stacked(3, 2, 1);
          yield* s.stack({ command: "stack", session: b.id });
          yield* heard(0);
          // Opening C, from B's stack or anywhere else, changes B's layer sessions.
          const { session: c } = yield* s.layer({ command: "layer", session: b.id, number: 3 });
          yield* heard(0);
          const [first] = (yield* s.diff({ command: "diff", session: c.id })).hunks;
          yield* viewedNow(c.id, [first!.id], "c-viewed");
          yield* heard(0);
          yield* s.delete({ command: "delete", session: c.id, requestId: "c-gone" });
          yield* heard(0);
          // Without C, B's context is the rechecked one again.
          expect(contexts.at(-1)).toBe(contexts[1]);
          // B's own Viewed moves its revision; its context, apart from its own counts, stays.
          const [own] = (yield* s.diff({ command: "diff", session: b.id })).hunks;
          yield* viewedNow(b.id, [own!.id], "b-viewed");
          expect((yield* announced).context).toBe(contexts.at(-1));
          // Sessions outside the stack's repository say nothing to it.
          yield* viewedNow(persisted.id, ["h2"], "local");
          expect(yield* nothing).toBe(true);
        }),
      ),
    );
  });

  it("refuses layers outside the known stack and stack work on non-PR sessions", async () => {
    discovery = { ok: false, reason: "gh_unauthenticated" };
    const { session: unknown } = await run(openScope(scopeOf(5)));
    discovery = stacked(1, 2, 3);
    const { session: b } = await run(openScope(scopeOf(2)));
    const saved = JSON.stringify([...files]);
    const calls = githubCalls.length;
    expect(await failure(openLayer(b.id, 4))).toMatchObject({
      _tag: "validation_failed",
      detail: { number: 4 },
    });
    // Unverified membership names no layers to open.
    expect(await failure(openLayer(unknown.id, 1))).toMatchObject({ _tag: "validation_failed" });
    const { session: local } = await run(openScope());
    const afterLocal = JSON.stringify([...files]);
    for (const id of [persisted.id, local.id]) {
      expect(await failure(recheck(id))).toBeInstanceOf(BadArgs);
      expect(await failure(openLayer(id, 1))).toBeInstanceOf(BadArgs);
    }
    expect(await failure(recheck("missing"))).toMatchObject({ _tag: "no_session" });
    expect(githubCalls).toHaveLength(calls);
    expect(JSON.stringify([...files])).toBe(afterLocal);
    expect(afterLocal).not.toBe(saved);
  });
});

describe("Sessions reads", () => {
  it("returns group diffs in explanation order rather than snapshot order", async () => {
    files.set(persisted.id, {
      ...persisted,
      groups: [{ ...persisted.groups[0]!, hunkIds: ["h3", "h1"] }],
    });
    const value = await run(
      Sessions.use((s) => s.diff({ command: "diff", session: persisted.id, group: "g1" })),
    );
    expect(value.hunks.map(({ id }) => id)).toEqual(["h3", "h1"]);
  });

  it("reads only the exact session id named", async () => {
    const other = await run(openScope());
    const byId = await run(
      Sessions.use((s) => s.status({ command: "status", session: persisted.id })),
    );
    expect(byId.session.id).toBe("persisted");
    expect(byId.groups[0]?.count).toBe(1);
    expect(byId.groups[1]).toEqual({ ...persisted.groups[1], count: 1 });
    expect(byId.preparation).toMatchObject({ state: "incomplete", groupedHunks: 2 });
    // Ungrouped h3 stays readable under its file; file Viewed derives from its hunks.
    expect(byId.viewedHunkIds).toEqual(["h1"]);
    expect(byId.files).toEqual([
      { path: "x.txt", hunkCount: 1, viewed: true },
      { path: "y.txt", hunkCount: 2, viewed: false },
    ]);
    const otherStatus = await run(
      Sessions.use((s) => s.status({ command: "status", session: other.session.id })),
    );
    expect(otherStatus.session).toEqual(other.session);
    const unknown = await failure(
      Sessions.use((s) => s.status({ command: "status", session: "nope" })),
    );
    expect(unknown).toMatchObject({ _tag: "no_session", message: "no session with id nope" });
  });

  it("filters diffs by hunk, group, or file and rejects bad selectors", async () => {
    const diff = (selector: { hunk?: string; group?: string; file?: string }) =>
      Sessions.use((s) => s.diff({ command: "diff", session: "persisted", ...selector }));
    expect((await run(diff({}))).hunks.map((hunk) => hunk.id)).toEqual(["h1", "h2", "h3"]);
    expect((await run(diff({ hunk: "h2" }))).hunks.map((hunk) => hunk.id)).toEqual(["h2"]);
    expect((await run(diff({ group: "g1" }))).hunks.map((hunk) => hunk.id)).toEqual(["h1"]);
    const byFile = await run(diff({ file: "y.txt" }));
    expect(byFile.hunks.map((hunk) => hunk.id)).toEqual(["h2", "h3"]);
    expect(byFile.revision).toBe(3);
    expect((await failure(diff({ hunk: "h1", file: "x.txt" })))._tag).toBe("bad_args");
    expect((await failure(diff({ group: "missing" })))._tag).toBe("validation_failed");
    expect((await failure(diff({ hunk: "missing" })))._tag).toBe("validation_failed");
  });
});

describe("Sessions.apply", () => {
  const apply = (envelope: unknown) =>
    Sessions.use((s) =>
      s.apply({
        command: "apply",
        session: persisted.id,
        batch: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
      }),
    );
  const envelope: ApplyEnvelope = {
    revision: 3,
    snapshotId: persisted.snapshotId,
    idempotencyKey: "first-pass",
    ops: [
      { type: "group.create", id: "g3", memberHunkIds: ["h3"], title: "third", overview: "third" },
    ],
  };

  it("applies a validated batch, bumps the revision, and persists a durable receipt", async () => {
    const status = await run(apply(envelope));
    expect(status.revision).toBe(4);
    expect(status.groups.map((group) => group.id)).toEqual(["g1", "g2", "g3"]);
    const saved = files.get("persisted")!;
    // The receipt stores each distinct text once; the notes of g1 and g2 share theirs.
    expect(saved.receiptTexts).toEqual(["Same edit.", "intent and behavior", "third"]);
    const [g1, g2, g3] = status.groups;
    expect(saved.applyReceipts).toEqual([
      {
        key: "first-pass",
        digest: expect.any(String),
        status: {
          ...status,
          groups: [
            {
              ...g1!,
              overview: { markdown: 0, references: [] },
              notes: [{ ...g1!.notes[0]!, markdown: 1 }],
            },
            { ...g2!, notes: [{ ...g2!.notes[0]!, markdown: 1 }] },
            { ...g3!, overview: { markdown: 2, references: [] } },
          ],
        },
      },
    ]);
    expect(saved.groups[2]?.title).toBe("third");
    // The receipt answers a replay before the revision check, so a retried batch is a no-op.
    expect(await run(apply(envelope))).toEqual(status);
    expect(files.get("persisted")?.revision).toBe(4);
  });

  it("rejects the whole batch on any invalid op, a removed queue op, or a stale revision", async () => {
    const invalid = await failure(
      apply({
        ...envelope,
        idempotencyKey: "invalid",
        ops: [
          {
            type: "group.create",
            id: "g3",
            title: "coherent change",
            overview: "Why.",
            memberHunkIds: ["h3"],
          },
          { type: "group.update", id: "missing", title: "nope" },
        ],
      }),
    );
    expect(invalid._tag).toBe("validation_failed");
    expect(invalid.detail).toEqual([{ opIndex: 1, message: "group missing does not exist" }]);
    // The review queue is gone: its op is an invalid envelope, not an alias.
    const queue = await failure(
      apply({
        ...envelope,
        idempotencyKey: "queue",
        ops: [{ type: "queue.set", itemIds: ["g1", "g2"] }],
      }),
    );
    expect(queue).toMatchObject({ _tag: "validation_failed", message: "invalid apply envelope" });
    for (const outdated of [{ revision: 0 }, { snapshotId: "older" }]) {
      const stale = await failure(apply({ ...envelope, ...outdated, idempotencyKey: "stale" }));
      expect(stale._tag).toBe("stale_revision");
      expect(stale.detail).toEqual([expect.objectContaining({ opIndex: -1 })]);
    }
    const malformed = await failure(apply("not json"));
    expect(malformed._tag).toBe("validation_failed");
    expect(malformed.message).toBe("invalid apply envelope");
    expect(malformed.detail).toEqual([{ opIndex: -1, message: expect.any(String) }]);
    const missing = await failure(
      Sessions.use((s) => s.apply({ command: "apply", session: persisted.id, batch: "" })),
    );
    expect(missing._tag).toBe("validation_failed");
    expect(files.get("persisted")).toEqual(persisted);
  });

  it("rejects legacy fields, partial metadata and controls without writes", async () => {
    for (const op of [
      { type: "group.update", id: "g1", notes: [] },
      { type: "group.update", id: "g1", notes: [{ hunkId: "h1", text: "old note" }] },
      { type: "group.update", id: "g1", overview: "bad\u001btext" },
      { type: "group.update", id: "g1", tldr: "old" },
      { type: "group.update", id: "g1", exemplarHunkId: "h1" },
      { type: "group.update", id: "g1", title: "new", tldr: "old" },
      { type: "group.create", id: "g3", memberHunkIds: ["h3"], title: "partial" },
      {
        type: "group.create",
        id: "g3",
        memberHunkIds: ["h3"],
        title: "bad\u001b",
        overview: "valid",
      },
      { type: "note.create", id: "n3", group: "g1", hunkId: "h1", text: "old note" },
      { type: "hunk.annotate", hunkId: "h3", title: "obsolete", overview: "obsolete" },
    ]) {
      expect(
        (await failure(apply({ ...envelope, idempotencyKey: "invalid", ops: [op] })))._tag,
      ).toBe("validation_failed");
      expect(files.get("persisted")).toEqual(persisted);
    }
  });

  it("publishes progressively around human Viewed and replays historical receipts without rollback", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* Sessions;
        const firstBatch = {
          ...envelope,
          idempotencyKey: "partial",
          ops: [{ type: "group.update", id: "g2", title: "read me first" }],
        };
        const first = yield* apply(firstBatch);
        expect(first.revision).toBe(4);
        yield* viewedNow("persisted", ["h2"], "read-g2");
        const viewed = yield* s.status({ command: "status", session: persisted.id });
        // A human write moves the revision the agent must name.
        const obsolete = yield* Effect.flip(apply({ ...envelope, revision: 4 }));
        expect(obsolete._tag).toBe("stale_revision");
        const second = yield* apply({ ...envelope, revision: viewed.revision });
        expect(second).toMatchObject({
          viewedHunkIds: ["h1", "h2"],
          groups: [{ id: "g1" }, { id: "g2", title: "read me first" }, { id: "g3" }],
        });
        expect(yield* apply(firstBatch)).toEqual(first);
        expect((yield* s.status({ command: "status", session: persisted.id })).revision).toBe(
          second.revision,
        );
        expect(files.get("persisted")?.revision).toBe(second.revision);
      }),
    );
  });

  it("serializes concurrent batches so the second sees a stale revision", async () => {
    const results = await run(
      Effect.all(
        [
          Effect.exit(apply(envelope)),
          Effect.exit(apply({ ...envelope, idempotencyKey: "second-pass" })),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(results.map(Exit.isSuccess)).toEqual([true, false]);
    expect(
      await run(Effect.flip(apply({ ...envelope, idempotencyKey: "third-pass" }))),
    ).toMatchObject({
      _tag: "stale_revision",
    });
    expect(files.get("persisted")?.revision).toBe(4);
  });
});

describe("Sessions.viewed", () => {
  const request = (fields: Partial<Input<"viewed">> = {}): Input<"viewed"> => ({
    command: "viewed",
    session: persisted.id,
    snapshotId: persisted.snapshotId,
    revision: persisted.revision,
    requestId: "r1",
    hunkIds: ["h2", "h3"],
    viewed: true,
    ...fields,
  });
  const viewed = (fields?: Partial<Input<"viewed">>) =>
    Sessions.use((s) => s.viewed(request(fields)));
  const status = Sessions.use((s) => s.status({ command: "status", session: persisted.id }));
  const sessionSaves = () => commits.filter((commit) => commit === `session ${persisted.id}`);

  it("sets and clears exactly the named hunks, saving effect and receipt together", async () => {
    const result = await run(viewed());
    expect(result).toEqual({
      sessionId: persisted.id,
      snapshotId: persisted.snapshotId,
      revision: 4,
      hunkIds: ["h2", "h3"],
      viewed: true,
    });
    // One save carries both the effect and the receipt that answers its retries.
    expect(sessionSaves()).toHaveLength(1);
    expect(files.get(persisted.id)).toMatchObject({
      revision: 4,
      viewedHunkIds: ["h1", "h2", "h3"],
      viewedReceipts: [{ requestId: "r1", digest: expect.any(String), result }],
    });
    expect((await run(status)).files).toEqual([
      { path: "x.txt", hunkCount: 1, viewed: true },
      { path: "y.txt", hunkCount: 2, viewed: true },
    ]);
    await run(viewed({ requestId: "r2", revision: 4, hunkIds: ["h2"], viewed: false }));
    const cleared = await run(status);
    expect(cleared.viewedHunkIds).toEqual(["h1", "h3"]);
    expect(cleared.files[1]).toEqual({ path: "y.txt", hunkCount: 2, viewed: false });
    // Groups carry no verdict to change.
    expect(files.get(persisted.id)?.groups).toEqual(persisted.groups);
  });

  it("answers an identical retry from its receipt after a restart, even once the state moved on", async () => {
    const first = await run(viewed());
    await run(viewed({ requestId: "r2", revision: 4, hunkIds: ["h1"], viewed: false }));
    const saved = JSON.stringify([...files]);
    // Each run is a fresh daemon over the persisted files.
    expect(await run(viewed())).toEqual(first);
    expect(JSON.stringify([...files])).toBe(saved);
    expect(sessionSaves()).toHaveLength(2);
  });

  it("fails a reused request id with a changed payload without writing", async () => {
    await run(viewed());
    const saved = JSON.stringify([...files]);
    for (const changed of [{ viewed: false }, { hunkIds: ["h2"] }, { revision: 4 }])
      expect(await failure(viewed(changed))).toMatchObject({
        _tag: "validation_failed",
        message: "request id reused with a different payload",
      });
    expect(JSON.stringify([...files])).toBe(saved);
  });

  it("conflicts on a stale revision or snapshot instead of overwriting", async () => {
    for (const stale of [{ revision: 2 }, { snapshotId: "b".repeat(64) }])
      expect(await failure(viewed(stale))).toMatchObject({
        _tag: "stale_revision",
        detail: { snapshotId: persisted.snapshotId, revision: persisted.revision },
      });
    expect(files.get(persisted.id)).toEqual(persisted);
    expect(commits).toEqual([]);
  });

  it("rejects unknown, duplicate or no hunk ids atomically", async () => {
    for (const hunkIds of [["h2", "gone"], ["h2", "h2"], []])
      expect((await failure(viewed({ hunkIds })))._tag).toBe("validation_failed");
    expect((await failure(viewed({ requestId: "" })))._tag).toBe("bad_args");
    expect((await failure(viewed({ session: "nope" })))._tag).toBe("no_session");
    expect(files.get(persisted.id)).toEqual(persisted);
    expect(commits).toEqual([]);
  });

  it("publishes nothing when persisting fails, so the same request can run again", async () => {
    await run(
      Effect.gen(function* () {
        const before = yield* status;
        saveFails = true;
        expect(Exit.isFailure(yield* Effect.exit(viewed()))).toBe(true);
        expect(yield* status).toEqual(before);
        expect(files.get(persisted.id)).toEqual(persisted);
        saveFails = false;
        expect((yield* viewed()).revision).toBe(4);
      }),
    );
  });

  it("holds a second request behind a pending save, which then sees a stale revision", async () => {
    await run(
      Effect.gen(function* () {
        const held = yield* holdNextSave;
        const first = yield* Effect.forkChild(viewed());
        yield* Deferred.await(held.started);
        const second = yield* Effect.forkChild(Effect.flip(viewed({ requestId: "r2" })));
        yield* Effect.sleep("20 millis");
        expect(second.pollUnsafe()).toBeUndefined();
        expect(sessionSaves()).toEqual([]);
        yield* Deferred.succeed(held.release, undefined);
        expect((yield* Fiber.join(first)).revision).toBe(4);
        const stale = yield* Fiber.join(second);
        expect([stale._tag, stale.detail]).toEqual([
          "stale_revision",
          { snapshotId: persisted.snapshotId, revision: 4 },
        ]);
      }),
    );
    expect(sessionSaves()).toHaveLength(1);
    expect(files.get(persisted.id)?.viewedReceipts).toHaveLength(1);
  });
});

describe("Sessions conversations", () => {
  type Act = Input<"draft" | "send" | "edit" | "retract" | "resolve" | "discard">;
  const act = (request: Act) => Sessions.use((s) => s.converse(request));
  const pickup = (session: string, requestId: string, mode: "pending" | "open" = "pending") =>
    Sessions.use((s) => s.threads({ command: "threads", session, mode, requestId }));
  const status = (session: string) => Sessions.use((s) => s.status({ command: "status", session }));
  /** Opens a session whose `notes.txt` is unchanged supporting code, and comments on its lines. */
  const commented = (markdown: string, requestId: string) =>
    Effect.gen(function* () {
      supporting = { "notes.txt": "n1\nn2\nn3\n" };
      const { session } = yield* openScope();
      const anchor = {
        snapshotId: session.snapshotId,
        path: "notes.txt",
        side: "new" as const,
        startLine: 1,
        endLine: 2,
      };
      const drafted = yield* act({
        command: "draft",
        session: session.id,
        requestId: `draft-${requestId}`,
        target: { kind: "comment", anchor },
      });
      const sent = yield* act({
        command: "send",
        session: session.id,
        requestId,
        draft: drafted.draft!,
        markdown,
        kind: "question",
      });
      return { session, anchor, sent };
    });

  it("keeps Pending bodies out of status and freezes exactly what one recorded pickup returns", async () => {
    const { session, anchor, sent } = await run(commented("Why keep *n2*?", "c1"));
    const counted = await run(status(session.id));
    expect(counted.threads).toEqual({ open: 1, resolved: 0, pending: 1 });
    expect(JSON.stringify(counted)).not.toContain("Why keep");
    // The author's listing names the thread and its counts, without bodies; reading the thread's
    // messages returns the body at the listed version. Neither freezes anything.
    const read = await run(
      Sessions.use((s) => s.conversations({ command: "conversations", session: session.id })),
    );
    const [listed] = read.threads;
    expect(listed).toMatchObject({ id: sent.thread, anchor, messageCount: 1, pendingCount: 1 });
    expect(JSON.stringify(read)).not.toContain("Why keep");
    const body = await run(
      Sessions.use((s) =>
        s.messages({ command: "messages", session: session.id, thread: listed!.id }),
      ),
    );
    expect(body).toMatchObject({ thread: sent.thread, version: listed!.version });
    expect(body.messages[0]).toMatchObject({ markdown: "Why keep *n2*?", pending: true });
    const gone = await run(
      Effect.flip(
        Sessions.use((s) =>
          s.messages({ command: "messages", session: session.id, thread: "gone" }),
        ),
      ),
    );
    expect(gone._tag).toBe("validation_failed");
    expect((await run(status(session.id))).threads.pending).toBe(1);

    const bundle = await run(pickup(session.id, "p1"));
    expect(bundle).toMatchObject({
      sessionId: session.id,
      revision: sent.revision + 1,
      progress: { viewed: 0, total: 2 },
      openThreads: 1,
      threads: [
        {
          id: sent.thread,
          anchor,
          code: { kind: "text", lines: ["n1", "n2"] },
          unread: [sent.message],
          messages: [{ id: sent.message, kind: "question", pending: false }],
        },
      ],
    });
    // The pickup froze the message, so the listing names another version of that thread only.
    const after = await run(
      Sessions.use((s) => s.conversations({ command: "conversations", session: session.id })),
    );
    expect(after.threads).toEqual([
      { ...listed, version: expect.not.stringMatching(listed!.version), pendingCount: 0 },
    ]);
    // Saved with its receipt: a fresh daemon replays the same bundle after a later arrival.
    const thread = sent.thread!;
    const drafted = await run(
      act({
        command: "draft",
        session: session.id,
        requestId: "d2",
        target: { kind: "thread", thread },
      }),
    );
    await run(
      act({
        command: "send",
        session: session.id,
        requestId: "c2",
        draft: drafted.draft!,
        markdown: "And n3?",
        kind: "change",
      }),
    );
    expect(await run(pickup(session.id, "p1"))).toEqual(bundle);
    expect(await failure(pickup(session.id, "p1", "open"))).toMatchObject({
      _tag: "validation_failed",
    });
    const next = await run(pickup(session.id, "p2"));
    expect(next.threads[0]!.unread).toHaveLength(1);
    expect(next.threads[0]!.messages.map(({ markdown }) => markdown)).toEqual([
      "Why keep *n2*?",
      "And n3?",
    ]);
    expect(files.get(session.id)?.pickupReceipts.map(({ requestId }) => requestId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("announces another conversations identity for a thread or draft pin change, never for Viewed alone", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, sent, anchor } = yield* commented("Why?", "c1");
          const { version, events } = yield* Sessions.use((s) =>
            s.subscribe({ session: session.id }),
          );
          const [hunk] = (yield* Sessions.use((s) =>
            s.diff({ command: "diff", session: session.id }),
          )).hunks;
          yield* viewedNow(session.id, [hunk!.id], "v1");
          const viewed = yield* Queue.take(events);
          expect(viewed).toMatchObject({ kind: "changed", conversations: version.conversations });
          const read = yield* Sessions.use((s) =>
            s.conversations({ command: "conversations", session: session.id }),
          );
          yield* act({
            command: "resolve",
            session: session.id,
            requestId: "r1",
            thread: sent.thread!,
            seen: read.threads[0]!.version,
            resolved: true,
          });
          const resolved = yield* Queue.take(events);
          expect(resolved.kind === "changed" && resolved.conversations).not.toBe(
            version.conversations,
          );
          // A draft pin changes no revision, but another tab, or a later note removal, shows it.
          const drafted = yield* act({
            command: "draft",
            session: session.id,
            requestId: "d1",
            target: { kind: "comment", anchor },
          });
          const pinned = yield* Queue.take(events);
          expect(pinned).toMatchObject({
            kind: "changed",
            revision: resolved.kind === "changed" && resolved.revision,
          });
          expect(pinned.kind === "changed" && pinned.conversations).not.toBe(
            resolved.kind === "changed" && resolved.conversations,
          );
          yield* act({
            command: "discard",
            session: session.id,
            requestId: "x1",
            draft: drafted.draft!,
          });
          const released = yield* Queue.take(events);
          expect(released.kind === "changed" && released.conversations).toBe(
            resolved.kind === "changed" && resolved.conversations,
          );
        }),
      ),
    );
  });

  it("serializes a pending edit against a pickup, which returns what the edit committed", async () => {
    await run(
      Effect.gen(function* () {
        const { session, sent } = yield* commented("Typo?", "c1");
        const held = yield* holdNextSave;
        const edit = yield* Effect.forkChild(
          act({
            command: "edit",
            session: session.id,
            requestId: "e1",
            message: sent.message!,
            seen: { markdown: "Typo?", kind: "question" },
            markdown: "Is n2 a typo?",
            kind: "change",
          }),
        );
        yield* Deferred.await(held.started);
        const picked = yield* Effect.forkChild(pickup(session.id, "p1"));
        yield* Effect.sleep("20 millis");
        expect(picked.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(held.release, undefined);
        yield* Fiber.join(edit);
        const bundle = yield* Fiber.join(picked);
        expect(bundle.threads[0]!.messages[0]).toMatchObject({
          markdown: "Is n2 a typo?",
          kind: "change",
          pending: false,
        });
        // Read means frozen: a later edit or delete is refused, and the correction is a new reply.
        const seen = { markdown: "Is n2 a typo?", kind: "change" } as const;
        for (const late of [
          { command: "edit", message: sent.message!, seen, kind: "question" },
          { command: "retract", message: sent.message!, seen },
        ] as const)
          expect(
            yield* Effect.flip(
              act({ session: session.id, requestId: `late-${late.command}`, ...late }),
            ),
          ).toMatchObject({ _tag: "validation_failed" });
      }),
    );
  });

  it("refuses a comment outside captured text or on a snapshot the session no longer pins", async () => {
    await run(
      Effect.gen(function* () {
        supporting = { "notes.txt": "n1\nn2\nn3\n" };
        const { session } = yield* openScope();
        const draft = (snapshotId: string, endLine: number) =>
          Effect.flip(
            act({
              command: "draft",
              session: session.id,
              requestId: `d-${snapshotId}-${endLine}`,
              target: {
                kind: "comment",
                anchor: { snapshotId, path: "notes.txt", side: "new", startLine: 1, endLine },
              },
            }),
          );
        expect((yield* draft(session.snapshotId, 4))._tag).toBe("validation_failed");
        expect((yield* draft("b".repeat(64), 1))._tag).toBe("stale_revision");
      }),
    );
  });

  it("keeps a draft's earlier code readable after a refresh until it is sent or discarded", async () => {
    await run(
      Effect.gen(function* () {
        const { session } = yield* openScope();
        const anchor = {
          snapshotId: session.snapshotId,
          path: "a.txt",
          side: "new" as const,
          startLine: 1,
          endLine: 1,
        };
        const drafted = yield* act({
          command: "draft",
          session: session.id,
          requestId: "d1",
          target: { kind: "comment", anchor },
        });
        gitPatch = patch.replace("+two", "+TWO");
        yield* refreshNow(session.id);
        const earlier = {
          command: "files",
          session: session.id,
          snapshotId: session.snapshotId,
        } as const;
        expect((yield* Sessions.use((s) => s.files(earlier))).snapshotId).toBe(session.snapshotId);
        // The changed line did not map, so the draft keeps its original context.
        const read = yield* Sessions.use((s) =>
          s.conversations({ command: "conversations", session: session.id }),
        );
        expect(read.drafts).toEqual([
          { id: drafted.draft, snapshotId: session.snapshotId, anchor },
        ]);
        yield* act({
          command: "discard",
          session: session.id,
          requestId: "x1",
          draft: drafted.draft!,
        });
        expect((yield* Effect.flip(Sessions.use((s) => s.files(earlier))))._tag).toBe(
          "stale_revision",
        );
      }),
    );
  });
});

describe("Sessions.refresh", () => {
  const changed = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -3 +3 @@
-one
+two
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-three
+FOUR
diff --git a/c.txt b/c.txt
--- a/c.txt
+++ b/c.txt
@@ -1 +1 @@
-five
+six
`;

  it("re-captures the recorded scope into a new snapshot, keeping only unchanged work", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* openScope(uncommitted, `${root}/sub`);
        const created = yield* sessions.status({ command: "status", session: session.id });
        const [a, b] = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
          (hunk) => hunk.id,
        );
        yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: 0,
            snapshotId: session.snapshotId,
            idempotencyKey: "fold",
            ops: [
              {
                type: "group.create",
                id: "g",
                title: "same",
                overview: "intent and behavior",
                memberHunkIds: [a],
              },
              {
                type: "group.create",
                id: "changed",
                memberHunkIds: [b],
                title: "changed",
                overview: "goes with its hunk",
              },
            ],
          }),
        });
        yield* viewedNow(session.id, [a!, b!], "read-both");
        gitPatch = changed;
        const replaced = yield* refreshNow(session.id, "first-refresh");
        expect(replaced).toEqual({
          sessionId: session.id,
          previousSnapshotId: session.snapshotId,
          snapshotId: expect.any(String),
          revision: 3,
          replaced: true,
        });
        expect(captureCalls[1]).toEqual({ root, scope: uncommitted });
        const refreshed = yield* sessions.status({ command: "status", session: session.id });
        expect(refreshed.session.snapshotId).toBe(replaced.snapshotId);
        expect(refreshed.session.snapshotId).not.toBe(session.snapshotId);
        expect(refreshed.revision).toBe(3);
        // The emptied group keeps its place, Outdated, until the agent repairs or removes it.
        expect(refreshed.groups).toEqual([
          expect.objectContaining({ id: "g", hunkIds: [a] }),
          expect.objectContaining({
            id: "changed",
            hunkIds: [],
            overview: { markdown: "goes with its hunk", references: [], outdated: ["code"] },
          }),
        ]);
        // Only the identical (merely shifted) hunk keeps Viewed; changed and new hunks start unviewed.
        expect(refreshed.viewedHunkIds).toEqual([a]);
        expect(refreshed.files).toEqual([
          { path: "a.txt", hunkCount: 1, viewed: true },
          { path: "b.txt", hunkCount: 1, viewed: false },
          { path: "c.txt", hunkCount: 1, viewed: false },
        ]);
        expect(files.get(created.session.id)?.revision).toBe(3);
      }),
    );
  });

  it("re-captures a range session's recorded range, not a resolved commit pair", async () => {
    const refreshed = await run(refreshNow(persisted.id));
    expect(captureCalls).toEqual([{ root: otherRoot, scope: persisted.scope }]);
    expect(refreshed.revision).toBe(4);
    expect(files.get(persisted.id)?.scope).toEqual(persisted.scope);
    expect(files.get(persisted.id)?.snapshotId).toBe(refreshed.snapshotId);
  });
  it("leaves saved and in-memory state untouched when capture, publication or saving fails", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        // Agent and human work recorded before the failing refreshes.
        yield* sessions.apply({
          command: "apply",
          session: persisted.id,
          batch: JSON.stringify({
            revision: persisted.revision,
            snapshotId: persisted.snapshotId,
            idempotencyKey: "before-refresh",
            ops: [
              {
                type: "group.create",
                id: "g3",
                memberHunkIds: ["h3"],
                title: "third",
                overview: "third",
              },
            ],
          }),
        });
        yield* viewedNow(persisted.id, ["h3"], "read-h3");
        const before = JSON.stringify([...files]);
        const status = yield* sessions.status({ command: "status", session: persisted.id });
        expect(status).toMatchObject({
          revision: persisted.revision + 2,
          viewedHunkIds: ["h1", "h3"],
        });
        const refresh = refreshNow(persisted.id, "failing");
        patchEffect = Effect.fail(new BadArgs({ message: "the working tree changed" }));
        expect(yield* Effect.flip(refresh)).toMatchObject({ _tag: "bad_args" });
        expect(yield* sessions.status({ command: "status", session: persisted.id })).toEqual(
          status,
        );
        patchEffect = undefined;
        manifestFails = true;
        expect(yield* Effect.flip(refresh)).toMatchObject({ _tag: "internal_error" });
        expect(yield* sessions.status({ command: "status", session: persisted.id })).toEqual(
          status,
        );
        manifestFails = false;
        saveFails = true;
        expect(Exit.isFailure(yield* Effect.exit(refresh))).toBe(true);
        expect(yield* sessions.status({ command: "status", session: persisted.id })).toEqual(
          status,
        );
        expect(JSON.stringify([...files])).toBe(before);
      }),
    );
  });

  it("reconciles against work saved while it captured, not the session it started from", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope();
          const ids = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
            ({ id }) => id,
          );
          const held = yield* holdCaptures;
          const refreshing = yield* Effect.forkChild(refreshNow(session.id));
          yield* Deferred.await(held.started);
          yield* sessions
            .apply({
              command: "apply",
              session: session.id,
              batch: JSON.stringify({
                revision: 0,
                snapshotId: session.snapshotId,
                idempotencyKey: "late",
                ops: [
                  {
                    type: "group.create",
                    id: "late",
                    title: "Late guidance",
                    overview: "Written during capture.",
                    memberHunkIds: ids,
                  },
                ],
              }),
            })
            .pipe(Effect.timeout("1 second"));
          // Human Viewed progress, also written during the capture.
          yield* viewedNow(session.id, ids, "late-read").pipe(Effect.timeout("1 second"));
          // The capture sees a third file appear.
          gitPatch = patch + patch.replaceAll("a.txt", "c.txt").split("diff --git a/b.txt")[0];
          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(refreshing)).revision).toBe(3);
          const refreshed = yield* sessions.status({ command: "status", session: session.id });
          expect(refreshed.groups).toEqual([expect.objectContaining({ id: "late" })]);
          expect(refreshed.viewedHunkIds).toEqual(ids);
          expect(files.get(session.id)?.revision).toBe(3);
        }),
      ),
    );
  });

  it("keeps an identical capture's snapshot, revision and progress, saving only its receipt", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* openScope();
        const [a] = (yield* sessions.diff({ command: "diff", session: session.id })).hunks;
        yield* viewedNow(session.id, [a!.id], "read");
        const before = yield* sessions.status({ command: "status", session: session.id });
        commits = [];
        expect(yield* refreshNow(session.id, "same")).toEqual({
          sessionId: session.id,
          previousSnapshotId: session.snapshotId,
          snapshotId: session.snapshotId,
          revision: before.revision,
          replaced: false,
        });
        expect(yield* sessions.status({ command: "status", session: session.id })).toEqual(before);
        // Nothing is published; the receipt alone is saved.
        expect(commits).toEqual([`session ${session.id}`]);
        expect(files.get(session.id)?.refreshReceipts).toHaveLength(1);
      }),
    );
  });

  it("answers a retried refresh with its recorded result after a restart, never as a new one", async () => {
    const { session } = await run(openScope());
    const request: Input<"refresh"> = {
      command: "refresh",
      session: session.id,
      snapshotId: session.snapshotId,
      requestId: "lost",
    };
    gitPatch = changed;
    const first = await run(Sessions.use((s) => s.refresh(request)));
    expect(first).toMatchObject({ previousSnapshotId: session.snapshotId, replaced: true });
    const [a] = (await run(Sessions.use((s) => s.diff({ command: "diff", session: session.id }))))
      .hunks;
    await run(viewedNow(session.id, [a!.id], "later"));
    captureCalls = [];
    gitPatch = patch;
    // A fresh daemon over the same files: the receipt answers, and nothing is captured again.
    expect(await run(Sessions.use((s) => s.refresh(request)))).toEqual(first);
    expect(
      await failure(Sessions.use((s) => s.refresh({ ...request, snapshotId: first.snapshotId }))),
    ).toMatchObject({ _tag: "validation_failed" });
    expect(
      await failure(Sessions.use((s) => s.refresh({ ...request, requestId: "fresh" }))),
    ).toMatchObject({ _tag: "stale_revision", detail: { snapshotId: first.snapshotId } });
    expect(captureCalls).toEqual([]);
    expect(files.get(session.id)?.snapshotId).toBe(first.snapshotId);
  });

  it("refuses revalidation for a snapshot a newer refresh replaced", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* openScope();
        const ids = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
          ({ id }) => id,
        );
        const apply = (snapshotId: string, revision: number, key: string, ops: unknown[]) =>
          sessions.apply({
            command: "apply",
            session: session.id,
            batch: JSON.stringify({ revision, snapshotId, idempotencyKey: key, ops }),
          });
        yield* apply(session.snapshotId, 0, "publish", [
          { type: "walkthrough.update", overview: "Two edits." },
          {
            type: "group.create",
            id: "g",
            title: "Both",
            overview: "Both edits.",
            memberHunkIds: ids,
          },
        ]);
        yield* viewedNow(session.id, ids, "read");
        gitPatch = changed;
        const second = yield* refreshNow(session.id);
        const outdated = yield* sessions.status({ command: "status", session: session.id });
        // A new file appeared and b.txt changed: the walkthrough and its group are Outdated.
        expect(outdated.overview?.outdated).toEqual(["code"]);
        expect(outdated.groups[0]?.overview?.outdated).toEqual(["code"]);
        expect(outdated.preparation).toMatchObject({ state: "incomplete", overviewOutdated: true });
        // The agent checked `second`, but another refresh committed meanwhile.
        gitPatch = changed.replace("+six", "+seven");
        const third = yield* refreshNow(session.id);
        expect(
          yield* Effect.flip(
            apply(second.snapshotId, second.revision, "revalidate", [
              { type: "walkthrough.revalidate" },
            ]),
          ),
        ).toMatchObject({ _tag: "stale_revision" });
        const revalidated = yield* apply(third.snapshotId, third.revision, "revalidate-third", [
          { type: "walkthrough.revalidate" },
        ]);
        expect(revalidated.overview).toEqual({ markdown: "Two edits.", references: [] });
        // Revalidation never restores or clears Viewed.
        expect(revalidated.viewedHunkIds).toEqual(outdated.viewedHunkIds);
      }),
    );
  });

  it("does not resurrect a session deleted while its refresh captured", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const held = yield* holdCaptures;
          const refreshing = yield* Effect.forkChild(refreshNow(persisted.id));
          yield* Deferred.await(held.started);
          yield* sessions
            .delete({ command: "delete", session: persisted.id, requestId: "gone" })
            .pipe(Effect.timeout("1 second"));
          yield* Deferred.succeed(held.release, undefined);
          expect(yield* Effect.flip(Fiber.join(refreshing))).toMatchObject({ _tag: "no_session" });
          expect(files.has(persisted.id)).toBe(false);
          expect((yield* sessions.list).sessions).toEqual([]);
        }),
      ),
    );
  });
});

describe("Sessions.load", () => {
  it("replaces the in-memory sessions with what is persisted now", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        // A rival daemon deleted the persisted session and opened another while we waited.
        files.delete(persisted.id);
        files.set("fresh", { ...persisted, id: "fresh", repoRoot: root });
        yield* sessions.load;
        const stale = yield* Effect.flip(
          sessions.status({ command: "status", session: persisted.id }),
        );
        expect(stale._tag).toBe("no_session");
        expect((yield* sessions.list).sessions.map(({ id }) => id)).toEqual(["fresh"]);
      }),
    );
  });
});

describe("Sessions.delete", () => {
  const remove = (session: string, requestId: string) =>
    Sessions.use((s) => s.delete({ command: "delete", session, requestId }));

  it("removes only the named session and signals idle once the last one is gone", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* openScope();
        const kept = files.get(persisted.id);
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        expect(yield* remove(session.id, "first")).toEqual({
          deleted: true,
          sessionId: session.id,
        });
        expect(files.has(session.id)).toBe(false);
        expect(files.get(persisted.id)).toBe(kept);
        expect(
          (yield* sessions.status({ command: "status", session: persisted.id })).session.id,
        ).toBe(persisted.id);
        expect(yield* sessions.isEmpty).toBe(false);
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        yield* remove(persisted.id, "second");
        expect(yield* sessions.isEmpty).toBe(true);
        yield* sessions.idle;
        expect(files.size).toBe(0);
        expect(deleteReceipts).toEqual([
          { requestId: "first", sessionId: session.id },
          { requestId: "second", sessionId: persisted.id },
        ]);
      }),
    );
  });

  it("replays the recorded result after restart and rejects the id for another session", async () => {
    const { session: other } = await run(openScope());
    const deleted = await run(remove(persisted.id, "retry-me"));
    // A fresh daemon, after the session file is gone.
    await run(
      Effect.gen(function* () {
        expect(yield* remove(persisted.id, "retry-me")).toEqual(deleted);
        expect(yield* Effect.flip(remove(other.id, "retry-me"))).toMatchObject({
          _tag: "validation_failed",
          message: "request id reused with a different payload",
        });
        expect((yield* Effect.flip(remove(persisted.id, "a-new-request")))._tag).toBe("no_session");
        // Another session remains, so a replay must not arm the idle shutdown.
        yield* Effect.flip(
          Effect.timeout(
            Sessions.use((s) => s.idle),
            "30 millis",
          ),
        );
      }),
    );
    expect([...files.keys()]).toEqual([other.id]);
    expect(deleteReceipts).toEqual([{ requestId: "retry-me", sessionId: persisted.id }]);
    expect((await failure(remove(other.id, "")))._tag).toBe("bad_args");
  });

  it("arms idle when a replay after restart finds no sessions, until an open arrives", async () => {
    const deleted = await run(remove(persisted.id, "last"));
    // A fresh daemon starts empty but must not be idle before its first request.
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        yield* Effect.flip(Effect.timeout(sessions.idle, "30 millis"));
        expect(yield* remove(persisted.id, "last")).toEqual(deleted);
        yield* Effect.timeout(sessions.idle, "1 second");
        expect(yield* sessions.isEmpty).toBe(true);
      }),
    );
    // Racing an open, the replay answers the same and the opened session keeps the daemon busy.
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const [replayed, opened] = yield* Effect.all([remove(persisted.id, "last"), openScope()], {
          concurrency: "unbounded",
        });
        expect(replayed).toEqual(deleted);
        expect(yield* sessions.isEmpty).toBe(false);
        yield* Effect.flip(Effect.timeout(sessions.idle, "30 millis"));
        expect(yield* remove(persisted.id, "last")).toEqual(deleted);
        yield* Effect.flip(Effect.timeout(sessions.idle, "30 millis"));
        yield* remove(opened.session.id, "opened");
        yield* Effect.timeout(sessions.idle, "1 second");
      }),
    );
    expect(deleteReceipts).toHaveLength(2);
  });

  it("keeps the session and every receipt when the receipt cannot be written", async () => {
    await run(remove(persisted.id, "earlier").pipe(Effect.andThen(openScope())));
    const saved = new Map(files);
    const receipts = deleteReceipts;
    saveFails = true;
    const [openedId] = [...files.keys()];
    await run(
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(remove(openedId!, "fails")))).toBe(true);
        expect(
          (yield* Sessions.use((s) => s.status({ command: "status", session: openedId! }))).session
            .id,
        ).toBe(openedId);
      }),
    );
    expect(files).toEqual(saved);
    expect(deleteReceipts).toBe(receipts);
    saveFails = false;
    // The failed request was never recorded, so its retry performs the deletion.
    expect(await run(remove(openedId!, "fails"))).toEqual({ deleted: true, sessionId: openedId });
  });

  it("treats the durable receipt as the deletion when removing the file fails", async () => {
    const { session } = await run(openScope());
    removeFails = true;
    await run(
      Effect.gen(function* () {
        expect(yield* remove(session.id, "committed")).toEqual({
          deleted: true,
          sessionId: session.id,
        });
        expect(
          (yield* Effect.flip(
            Sessions.use((s) => s.status({ command: "status", session: session.id })),
          ))._tag,
        ).toBe("no_session");
      }),
    );
    expect(files.has(session.id)).toBe(true);
    removeFails = false;
    // Restart: the leftover file is not served again, and loading finishes its removal.
    await run(
      Effect.gen(function* () {
        expect((yield* Sessions.use((s) => s.list)).sessions.map(({ id }) => id)).toEqual([
          persisted.id,
        ]);
        expect(yield* remove(session.id, "committed")).toEqual({
          deleted: true,
          sessionId: session.id,
        });
      }),
    );
    expect(files.has(session.id)).toBe(false);
    expect(files.has(persisted.id)).toBe(true);
  });

  it("answers concurrent retries of one deletion with one result and one receipt", async () => {
    const results = await run(
      Effect.all([remove(persisted.id, "twice"), remove(persisted.id, "twice")], {
        concurrency: "unbounded",
      }),
    );
    expect(results[0]).toEqual(results[1]);
    expect(deleteReceipts).toEqual([{ requestId: "twice", sessionId: persisted.id }]);
  });
});

describe("Sessions.subscribe", () => {
  const subscribe = (session = persisted.id) => Sessions.use((s) => s.subscribe({ session }));
  const versionNow = (session = persisted.id) => {
    const saved = files.get(session)!;
    return {
      sessionId: saved.id,
      snapshotId: saved.snapshotId,
      revision: saved.revision,
      conversations: expect.any(String),
    };
  };
  const apply = (revision: number, idempotencyKey: string) =>
    Sessions.use((s) =>
      s.apply({
        command: "apply",
        session: persisted.id,
        batch: JSON.stringify({
          revision,
          snapshotId: files.get(persisted.id)!.snapshotId,
          idempotencyKey,
          ops: [{ type: "group.update", id: "g2", title: idempotencyKey }],
        }),
      }),
    );
  const refresh = refreshNow(persisted.id, "announced");
  const remove = (requestId: string) =>
    Sessions.use((s) => s.delete({ command: "delete", session: persisted.id, requestId }));

  it("returns the version current at registration, and no_session for an unknown id", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { version, events } = yield* subscribe();
          expect(version).toEqual({
            sessionId: persisted.id,
            snapshotId: persisted.snapshotId,
            revision: persisted.revision,
            conversations: expect.any(String),
          });
          expect(yield* Queue.poll(events)).toEqual(Option.none());
          expect((yield* Effect.flip(subscribe("nope")))._tag).toBe("no_session");
        }),
      ),
    );
  });

  it("announces each committed viewed, apply, refresh and delete once, after it is saved", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { events } = yield* subscribe();
          const nothing = Queue.poll(events).pipe(Effect.map(Option.isNone));
          yield* viewedNow(persisted.id, ["h2"], "read-h2");
          expect(yield* Queue.take(events)).toEqual({ kind: "changed", ...versionNow() });
          expect(yield* nothing).toBe(true);
          yield* apply(versionNow().revision, "retitle");
          expect(yield* Queue.take(events)).toEqual({ kind: "changed", ...versionNow() });
          expect(yield* nothing).toBe(true);
          const refreshed = yield* refresh;
          const after = yield* Queue.take(events);
          expect(after).toEqual({ kind: "changed", ...versionNow() });
          expect(after).toMatchObject({
            snapshotId: refreshed.snapshotId,
            revision: refreshed.revision,
          });
          expect(refreshed.snapshotId).not.toBe(persisted.snapshotId);
          expect(yield* nothing).toBe(true);
          yield* remove("gone");
          expect(files.has(persisted.id)).toBe(false);
          expect(yield* Queue.take(events)).toEqual({ kind: "deleted", sessionId: persisted.id });
          expect(yield* nothing).toBe(true);
        }),
      ),
    );
  });

  it("announces nothing for a Viewed, apply or delete answered from its receipt", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* Sessions;
          const { request } = yield* viewedNow(persisted.id, ["h2"], "once");
          yield* apply(persisted.revision + 1, "once");
          const { events } = yield* subscribe();
          const saved = JSON.stringify([...files]);
          yield* s.viewed(request);
          yield* apply(persisted.revision + 1, "once");
          expect(JSON.stringify([...files])).toBe(saved);
          expect(yield* Queue.poll(events)).toEqual(Option.none());
          yield* remove("gone");
          expect((yield* Queue.take(events)).kind).toBe("deleted");
          yield* remove("gone");
          expect(yield* Queue.poll(events)).toEqual(Option.none());
        }),
      ),
    );
  });

  it("announces nothing while a save is pending, and the saved version once it commits", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { events } = yield* subscribe();
          const held = yield* holdNextSave;
          const writing = yield* Effect.forkChild(viewedNow(persisted.id, ["h2"], "held"));
          yield* Deferred.await(held.started);
          yield* Effect.sleep("20 millis");
          expect(yield* Queue.poll(events)).toEqual(Option.none());
          expect(files.get(persisted.id)).toBe(persisted);
          yield* Deferred.succeed(held.release, undefined);
          const { result } = yield* Fiber.join(writing);
          const change = yield* Queue.take(events);
          expect(change).toEqual({ kind: "changed", ...versionNow() });
          expect(change).toMatchObject({ revision: result.revision });
        }),
      ),
    );
  });

  it("announces nothing when saving fails, leaving the state as it was", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { events } = yield* subscribe();
          saveFails = true;
          const mutations: ReadonlyArray<Effect.Effect<unknown, unknown, Sessions>> = [
            viewedNow(persisted.id, ["h2"], "fails"),
            apply(persisted.revision, "fails"),
            refresh,
            remove("fails"),
          ];
          for (const mutation of mutations)
            expect(Exit.isFailure(yield* Effect.exit(mutation))).toBe(true);
          expect(yield* Queue.poll(events)).toEqual(Option.none());
          expect(files.get(persisted.id)).toBe(persisted);
          expect(deleteReceipts).toEqual([]);
        }),
      ),
    );
  });

  it("keeps only the newest undelivered change", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const { events } = yield* subscribe();
          yield* viewedNow(persisted.id, ["h2"], "first");
          yield* viewedNow(persisted.id, ["h3"], "second");
          yield* viewedNow(persisted.id, ["h2"], "third", false);
          expect(yield* Queue.take(events)).toEqual({
            kind: "changed",
            ...versionNow(),
            revision: persisted.revision + 3,
          });
          expect(yield* Queue.poll(events)).toEqual(Option.none());
        }),
      ),
    );
  });

  it("never misses a mutation racing the registration: ready or a change carries it", async () => {
    const outcomes = { inReady: 0, announced: 0 };
    await run(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 20; attempt++)
          yield* Effect.scoped(
            Effect.gen(function* () {
              // Staggered starts land the registration before, between and after the write's steps.
              const late = Effect.forEach(
                Array.from({ length: attempt % 4 }),
                () => Effect.yieldNow,
              );
              const [{ version, events }, { result }] = yield* Effect.all(
                [
                  late.pipe(Effect.andThen(subscribe())),
                  viewedNow(persisted.id, ["h2"], `race-${attempt}`, attempt % 2 === 0),
                ],
                { concurrency: "unbounded" },
              );
              const change = Option.getOrUndefined(yield* Queue.poll(events));
              if (change) {
                expect(change).toEqual({ kind: "changed", ...versionNow() });
                outcomes.announced++;
              } else outcomes.inReady++;
              expect(change?.kind === "changed" ? change.revision : version.revision).toBe(
                result.revision,
              );
            }),
          );
      }),
    );
    expect(outcomes.inReady).toBeGreaterThan(0);
    expect(outcomes.announced).toBeGreaterThan(0);
  });

  it("unregisters a subscriber when its scope closes, leaving the others", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const kept = yield* subscribe();
          const closed = yield* Effect.scoped(subscribe());
          yield* viewedNow(persisted.id, ["h2"], "after-close");
          expect(yield* Queue.take(kept.events)).toEqual({ kind: "changed", ...versionNow() });
          // Shut down rather than merely quiet: a closed subscriber's take ends at once.
          const ended = yield* Effect.exit(
            Queue.take(closed.events).pipe(Effect.timeout("1 second")),
          );
          expect(Exit.hasInterrupts(ended)).toBe(true);
        }),
      ),
    );
  });
});

describe("Sessions captured reads over real captures", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "gyst-reads-")));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** When set, each captured-content read signals `started` and then waits for `release`. */
  let readGate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  /** When set, the next diff copy (all blobs committed) signals `started`, then waits for `release`. */
  let diffGate: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  /** How many blob writes still fail as out of space before writes succeed again. */
  let outOfSpace = 0;
  const gatedContent = Layer.effect(
    CapturedContent,
    Effect.map(CapturedContent, (real) => ({
      ...real,
      putBlob: <E>(bytes: Stream.Stream<Uint8Array, E>) => {
        if (outOfSpace > 0) {
          outOfSpace--;
          return Effect.fail(
            new SourceUnavailable({
              message: "gyst's data directory is out of space",
              detail: { reason: "storage_full" },
            }),
          );
        }
        return real.putBlob(bytes);
      },
      materialize: (blob: string) => {
        const held = diffGate;
        diffGate = undefined;
        return held
          ? Deferred.succeed(held.started, undefined).pipe(
              Effect.andThen(Deferred.await(held.release)),
              Effect.andThen(real.materialize(blob)),
            )
          : real.materialize(blob);
      },
      readBlob: (blob: string, range: ByteRange) =>
        readGate
          ? Stream.unwrap(
              Deferred.succeed(readGate.started, undefined).pipe(
                Effect.andThen(Deferred.await(readGate.release)),
                Effect.as(real.readBlob(blob, range)),
              ),
            )
          : real.readBlob(blob, range),
    })),
  ).pipe(Layer.provide(CapturedContent.layer));
  // Sessions here are real captures; the shared fixture names no captured snapshot.
  beforeEach(() => {
    files.delete(persisted.id);
    outOfSpace = 0;
  });
  /** Real Git capture into real captured content under a private data dir. */
  const runReal = <A, E>(
    effect: Effect.Effect<A, E, Sessions>,
    environment: Record<string, string> = {},
  ) =>
    Effect.runPromise(
      Effect.provide(
        Sessions.use((s) => s.load).pipe(Effect.andThen(effect)),
        Sessions.layer.pipe(
          Layer.provide(Git.layer.pipe(Layer.provideMerge(gatedContent))),
          Layer.provide(Layer.mergeAll(store, crypto, github)),
          Layer.provide(Paths.layer),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ GYST_DATA_DIR: join(dir, "data"), ...environment }),
            ),
          ),
        ),
      ),
    );

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo = async (name: string, committed: Record<string, string | Uint8Array>) => {
    const cwd = join(dir, name);
    await mkdir(cwd, { recursive: true });
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "test@gyst.invalid");
    git(cwd, "config", "user.name", "Gyst Test");
    for (const [path, content] of Object.entries(committed))
      await writeFile(join(cwd, path), content);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial");
    return cwd;
  };

  type Code = Input<"code">;
  const code = (request: Omit<Code, "command">) =>
    Sessions.use((s) => s.code({ command: "code", ...request }));
  const codeError = (request: Omit<Code, "command">) => Effect.flip(code(request));
  /** Every page from the start, following `next.offset`, checking each page's bound and labels. */
  const allPages = (request: Omit<Code, "command">) =>
    Effect.gen(function* () {
      let text = "";
      let pages = 0;
      let offset: number | undefined;
      let expectedLine = 1;
      while (true) {
        const { content } = yield* code({ ...request, offset });
        if (content.kind !== "text") throw new Error(`not text: ${content.kind}`);
        pages++;
        expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(pageBytes);
        expect(content.start).toEqual({ line: expectedLine, offset: offset ?? 0 });
        text += content.text;
        if (!content.next) return { text, pages };
        expectedLine = 1 + (text.match(/\n/g)?.length ?? 0);
        expect(content.next).toEqual({ line: expectedLine, offset: Buffer.byteLength(text) });
        offset = content.next.offset;
      }
    });

  const endings = "\uFEFFfirst\r\nsecond\rstill second\nlast";
  const bigLine = (index: number) => `line ${String(index).padStart(5, "0")} ${"x".repeat(40)}\n`;
  const big = Array.from({ length: 4000 }, (_, index) => bigLine(index + 1)).join("");
  const lineBytes = bigLine(1).length;
  // Two-byte characters align with every page split; a short line follows the giant one.
  const giant = `${"é".repeat(100_000)}z\nshort\n`;
  // Three-byte characters do not: 65,536 is one byte into a `€`, so a split must retreat.
  const euros = `${"€".repeat(50_000)}\n`;

  it("reads exact captured bytes by line, page and side after the checkout is deleted", async () => {
    const cwd = await repo("exact", {
      "changed.txt": "old one\nold two\n",
      "deleted.txt": "going away\n",
      "helper.ts": "export const helper = 1;\n",
    });
    await writeFile(join(cwd, "changed.txt"), "old one\nnew two\n");
    await rm(join(cwd, "deleted.txt"));
    await writeFile(join(cwd, "endings.txt"), endings);
    await writeFile(join(cwd, "empty.txt"), "");
    await writeFile(join(cwd, "big.txt"), big);
    await writeFile(join(cwd, "giant.txt"), giant);
    await writeFile(join(cwd, "euros.txt"), euros);
    await writeFile(join(cwd, "image.bin"), new Uint8Array([0x89, 0x50, 0, 1]));

    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        yield* Effect.promise(() => rm(cwd, { recursive: true, force: true }));
        const ids = { session: session.id, snapshotId: session.snapshotId };
        const diff = yield* sessions.diff({ command: "diff", session: session.id });
        expect(diff.snapshotId).toBe(session.snapshotId);

        const read = (file: string, side: "old" | "new" = "new", more = {}) =>
          code({ ...ids, file, side, ...more }).pipe(Effect.map(({ content }) => content));
        expect(yield* read("endings.txt")).toEqual({
          kind: "text",
          size: Buffer.byteLength(endings),
          start: { line: 1, offset: 0 },
          text: endings,
          next: null,
        });
        const firstLine = Buffer.byteLength("\uFEFFfirst\r\n");
        expect(yield* read("endings.txt", "new", { startLine: 2, endLine: 2 })).toMatchObject({
          start: { line: 2, offset: firstLine },
          text: "second\rstill second\n",
          next: null,
        });
        expect(yield* read("endings.txt", "new", { startLine: 3 })).toMatchObject({
          start: { line: 3 },
          text: "last",
          next: null,
        });
        expect(yield* read("empty.txt")).toEqual({
          kind: "text",
          size: 0,
          start: { line: 1, offset: 0 },
          text: "",
          next: null,
        });
        // Unchanged supporting files are members too, on both sides.
        expect(yield* read("helper.ts", "old")).toMatchObject({
          text: "export const helper = 1;\n",
        });
        expect(yield* read("changed.txt", "old")).toMatchObject({ text: "old one\nold two\n" });
        expect(yield* read("changed.txt")).toMatchObject({ text: "old one\nnew two\n" });
        expect(yield* read("deleted.txt")).toEqual({ kind: "absent" });
        expect(yield* read("endings.txt", "old")).toEqual({ kind: "absent" });
        expect(yield* read("image.bin")).toEqual({ kind: "unavailable", reason: "binary" });

        const bigPages = yield* allPages({ ...ids, file: "big.txt", side: "new" });
        expect(bigPages.text).toBe(big);
        expect(bigPages.pages).toBe(Math.ceil(4000 / Math.floor(pageBytes / lineBytes)));
        const firstBig = yield* read("big.txt");
        // A page ends after its last whole line.
        if (firstBig.kind === "text") expect(firstBig.text.endsWith("\n")).toBe(true);
        const giantPages = yield* allPages({ ...ids, file: "giant.txt", side: "new" });
        expect(giantPages.text).toBe(giant);
        expect(giantPages.pages).toBe(4);
        // The giant line continues across pages: every page after the first still starts in line 1
        // until it ends, and the last page holds the rest of it and the short line.
        const lastGiant = yield* read("giant.txt", "new", { offset: 3 * pageBytes });
        expect(lastGiant).toMatchObject({ start: { line: 1 }, next: null });
        const euroPages = yield* allPages({ ...ids, file: "euros.txt", side: "new" });
        expect(euroPages.text).toBe(euros);
        expect(euroPages.pages).toBe(3);
        expect(yield* read("euros.txt")).toMatchObject({
          start: { line: 1, offset: 0 },
          next: { line: 1, offset: pageBytes - 1 },
        });
        // End of content: one past the last line only after a final LF.
        const endingsSize = Buffer.byteLength(endings);
        expect(yield* read("endings.txt", "new", { offset: endingsSize })).toMatchObject({
          start: { line: 3, offset: endingsSize },
          text: "",
          next: null,
        });
        expect(yield* read("big.txt", "new", { offset: big.length })).toMatchObject({
          start: { line: 4001, offset: big.length },
          text: "",
          next: null,
        });
        expect(yield* read("big.txt", "new", { startLine: 4000, endLine: 4000 })).toMatchObject({
          start: { line: 4000, offset: 3999 * lineBytes },
          text: bigLine(4000),
          next: null,
        });
        expect(yield* read("big.txt", "new", { startLine: 2, endLine: 3 })).toMatchObject({
          text: bigLine(2) + bigLine(3),
          next: null,
        });

        const invalid = (file: string, more: object) =>
          codeError({ ...ids, file, side: "new", ...more });
        expect(yield* invalid("endings.txt", { startLine: 4 })).toMatchObject({
          _tag: "bad_args",
          detail: { startLine: 4, lines: 3 },
        });
        expect(yield* invalid("empty.txt", { startLine: 1 })).toMatchObject({
          _tag: "bad_args",
          detail: { lines: 0 },
        });
        expect(yield* invalid("big.txt", { startLine: 4001 })).toMatchObject({
          _tag: "bad_args",
          detail: { lines: 4000 },
        });
        expect(yield* invalid("big.txt", { endLine: 4001 })).toMatchObject({ _tag: "bad_args" });
        expect(
          yield* invalid("big.txt", { offset: lineBytes * 10 + 5, endLine: 10 }),
        ).toMatchObject({
          _tag: "bad_args",
          detail: { endLine: 10, line: 11 },
        });
        expect(yield* invalid("big.txt", { offset: big.length + 1 })).toMatchObject({
          _tag: "bad_args",
        });
        // Byte 1 of the BOM, and the second byte of an `é`.
        expect(yield* invalid("endings.txt", { offset: 1 })).toMatchObject({ _tag: "bad_args" });
        expect(yield* invalid("giant.txt", { offset: 1 })).toMatchObject({ _tag: "bad_args" });
        expect(yield* read("giant.txt", "new", { offset: 2 })).toMatchObject({
          start: { line: 1, offset: 2 },
        });
        expect(yield* invalid("missing.txt", {})).toMatchObject({
          _tag: "validation_failed",
          detail: { file: "missing.txt" },
        });
      }),
    );
  });

  it("checks applied note anchors and references against the captured lines, not the checkout", async () => {
    const cwd = await repo("anchors", {
      "changed.txt": "one\ntwo\nthree\n",
      "deleted.txt": "going away\n",
      "helper.ts": "a\nb\n",
    });
    // The new side's last line is unterminated: it still counts.
    await writeFile(join(cwd, "changed.txt"), "one\nTWO\nthree\nfour");
    await rm(join(cwd, "deleted.txt"));
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        // Only captured content answers: the checkout is gone and a live-only file never existed.
        yield* Effect.promise(() => rm(cwd, { recursive: true, force: true }));
        const ids = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
          ({ id }) => id,
        );
        const anchor = (path: string, side: "old" | "new", startLine: number, endLine: number) => ({
          path,
          side,
          startLine,
          endLine,
        });
        const apply = (revision: number, idempotencyKey: string, ops: unknown[]) =>
          sessions.apply({
            command: "apply",
            session: session.id,
            batch: JSON.stringify({
              revision,
              snapshotId: session.snapshotId,
              idempotencyKey,
              ops,
            }),
          });
        const note = (id: string, range: ReturnType<typeof anchor>) => ({
          type: "note.create",
          id,
          group: "g",
          anchor: range,
          markdown: `About ${id}.`,
        });
        const published = yield* apply(0, "publish", [
          {
            type: "group.create",
            id: "g",
            title: "All",
            overview: "Everything.",
            memberHunkIds: ids,
          },
          note("tail", anchor("changed.txt", "new", 1, 4)),
          note("removed", anchor("deleted.txt", "old", 1, 1)),
        ]);
        expect(published.groups[0]?.notes.map(({ id }) => id)).toEqual(["tail", "removed"]);
        for (const [range, message] of [
          [
            anchor("changed.txt", "new", 4, 5),
            "lines 4-5 are outside the new side of changed.txt, which has 4 lines",
          ],
          [anchor("deleted.txt", "new", 1, 1), "the new side of deleted.txt does not exist"],
          [anchor("live.txt", "new", 1, 1), "live.txt is not in the captured snapshot"],
          // An unchanged supporting file is captured, but a note must cover its group's changes.
          [anchor("helper.ts", "new", 1, 2), "must cover a changed line of its group g"],
        ] as const) {
          const rejected = yield* Effect.flip(apply(1, `bad-${message}`, [note("bad", range)]));
          expect(rejected).toMatchObject({
            _tag: "validation_failed",
            detail: [{ opIndex: 0, message: expect.stringContaining(message) }],
          });
        }
        expect((yield* sessions.status({ command: "status", session: session.id })).revision).toBe(
          1,
        );

        // References in Markdown are indexed from the same captured content.
        const referenced = yield* apply(1, "references", [
          {
            type: "walkthrough.update",
            overview:
              "Uses [the helper](gyst:new/helper.ts#L1-L2) and [gone](gyst:old/deleted.txt#L1).",
          },
        ]);
        expect(referenced.overview?.references).toEqual([
          { snapshotId: session.snapshotId, ...anchor("helper.ts", "new", 1, 2) },
          { snapshotId: session.snapshotId, ...anchor("deleted.txt", "old", 1, 1) },
        ]);
        for (const [href, message] of [
          [
            "gyst:new/helper.ts#L2-L3",
            "lines 2-3 are outside the new side of helper.ts, which has 2 lines",
          ],
          ["gyst:new/deleted.txt#L1", "the new side of deleted.txt does not exist"],
          ["gyst:new/live.txt#L1", "live.txt is not in the captured snapshot"],
        ] as const) {
          const rejected = yield* Effect.flip(
            apply(2, `bad-${href}`, [{ type: "walkthrough.update", overview: `[x](${href})` }]),
          );
          expect(rejected).toMatchObject({
            _tag: "validation_failed",
            detail: [{ opIndex: 0, message: `reference ${href}: ${message}` }],
          });
        }
      }),
    );
  });

  it("lists every captured file in bounded pages that resume after the previous one", async () => {
    const committed = Object.fromEntries(
      Array.from({ length: 700 }, (_, index) => [
        `${String(index).padStart(3, "0")}-${"n".repeat(80)}.txt`,
        "same\n",
      ]),
    );
    const cwd = await repo("many", committed);
    await writeFile(join(cwd, "added.txt"), "new\n");
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        const ids = { command: "files", session: session.id, snapshotId: session.snapshotId };
        const listed = [];
        let after: string | undefined;
        let pages = 0;
        do {
          const page = yield* sessions.files({ ...ids, after } as Input<"files">);
          pages++;
          expect(page.total).toBe(701);
          expect(Buffer.byteLength(JSON.stringify(page.files))).toBeLessThanOrEqual(
            pageBytes + page.files.length + 1,
          );
          listed.push(...page.files);
          after = page.next ?? undefined;
          if (page.next) expect(page.next).toBe(page.files.at(-1)!.path);
        } while (after !== undefined);
        expect(pages).toBeGreaterThan(2);
        expect(listed.map(({ path }) => path)).toEqual(
          [...Object.keys(committed), "added.txt"].sort(),
        );
        expect(listed.find(({ path }) => path === "added.txt")).toMatchObject({
          old: { kind: "absent" },
          new: { kind: "text", size: 4 },
        });
        expect(
          yield* Effect.flip(sessions.files({ ...ids, after: "not-a-member" } as Input<"files">)),
        ).toMatchObject({ _tag: "validation_failed" });
      }),
    );
  });

  it("reconciles a real refresh: moved notes stay current, changed references keep their old code", async () => {
    const numbered = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${index + 1}\n`).join("");
    const cwd = await repo("refresh", {
      "a.ts": numbered("a", 20),
      "helper.ts": numbered("h", 4),
    });
    await writeFile(join(cwd, "a.ts"), numbered("a", 20).replace("a10\n", "changed\n"));
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        const [change] = (yield* sessions.diff({ command: "diff", session: session.id })).hunks;
        const link = "[the helper](gyst:new/helper.ts#L2-L3)";
        yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: 0,
            snapshotId: session.snapshotId,
            idempotencyKey: "publish",
            ops: [
              { type: "walkthrough.update", overview: "One change." },
              {
                type: "group.create",
                id: "g",
                title: "Change",
                overview: `Uses ${link}.`,
                memberHunkIds: [change!.id],
              },
              {
                type: "note.create",
                id: "n",
                group: "g",
                anchor: { path: "a.ts", side: "new", startLine: 10, endLine: 10 },
                markdown: `Calls ${link}.`,
              },
            ],
          }),
        });
        yield* viewedNow(session.id, [change!.id], "read");
        // Two lines above the change move it; an edit inside the referenced helper lines changes them.
        yield* Effect.promise(async () => {
          await writeFile(
            join(cwd, "a.ts"),
            `top\nsecond\n${numbered("a", 20).replace("a10\n", "changed\n")}`,
          );
          await writeFile(join(cwd, "helper.ts"), numbered("h", 4).replace("h3\n", "H3\n"));
        });
        const refreshed = yield* refreshNow(session.id);
        const status = yield* sessions.status({ command: "status", session: session.id });
        const current = refreshed.snapshotId;
        const pinned = { snapshotId: session.snapshotId, path: "helper.ts", side: "new" } as const;
        expect(status.groups[0]?.hunkIds).toEqual([change!.id]);
        expect(status.groups[0]?.notes[0]).toEqual({
          id: "n",
          anchor: { snapshotId: current, path: "a.ts", side: "new", startLine: 12, endLine: 12 },
          markdown: `Calls ${link}.`,
          references: [{ ...pinned, startLine: 2, endLine: 3 }],
          outdated: ["references"],
        });
        expect(status.groups[0]?.overview?.outdated).toEqual(["references"]);
        expect(status.overview?.outdated).toEqual(["code"]);
        // The note's changed reference unviews its own anchored hunk.
        expect(status.viewedHunkIds).toEqual([]);
        // The earlier snapshot stays readable while guidance pins it.
        const earlier = {
          session: session.id,
          snapshotId: session.snapshotId,
          file: "helper.ts",
          side: "new",
        } as const;
        expect(yield* code({ ...earlier, startLine: 3, endLine: 3 })).toMatchObject({
          snapshotId: session.snapshotId,
          content: { text: "h3\n" },
        });
        const revalidated = yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: refreshed.revision,
            snapshotId: current,
            idempotencyKey: "revalidate",
            ops: [
              { type: "walkthrough.revalidate" },
              { type: "group.revalidate", id: "g" },
              { type: "note.revalidate", id: "n" },
            ],
          }),
        });
        expect(revalidated.groups[0]?.notes[0]?.references).toEqual([
          { ...pinned, snapshotId: current, startLine: 2, endLine: 3 },
        ]);
        expect(revalidated.preparation.state).toBe("incomplete");
        // Nothing pins it any more.
        expect(yield* codeError(earlier)).toMatchObject({ _tag: "stale_revision" });
      }),
    );
  });

  it("re-anchoring a note a refresh kept on earlier code unviews its surviving hunks too", async () => {
    const numbered = Array.from({ length: 40 }, (_, index) => `a${index + 1}\n`).join("");
    const edited = (twenty: string) =>
      numbered.replace("a10\n", "x10\n").replace("a20\n", twenty).replace("a30\n", "x30\n");
    const cwd = await repo("historical", { "a.ts": numbered });
    await writeFile(join(cwd, "a.ts"), edited("x20\n"));
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        const hunkIds = (yield* sessions.diff({ command: "diff", session: session.id })).hunks.map(
          ({ id }) => id,
        );
        const [first, , third] = hunkIds;
        yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: 0,
            snapshotId: session.snapshotId,
            idempotencyKey: "publish",
            ops: [
              {
                type: "group.create",
                id: "g",
                title: "Edits",
                overview: "Three edits.",
                memberHunkIds: hunkIds,
              },
              {
                type: "note.create",
                id: "n",
                group: "g",
                anchor: { path: "a.ts", side: "new", startLine: 10, endLine: 20 },
                markdown: "Spans the first two edits.",
              },
            ],
          }),
        });
        yield* viewedNow(session.id, hunkIds, "read");
        // The second edit changes, so the note stays on the first snapshot's code.
        yield* Effect.promise(() => writeFile(join(cwd, "a.ts"), edited("y20\n")));
        const refreshed = yield* refreshNow(session.id);
        const kept = yield* sessions.status({ command: "status", session: session.id });
        expect(kept.groups[0]?.notes[0]?.anchor.snapshotId).toBe(session.snapshotId);
        expect(kept.viewedHunkIds).toEqual([first, third]);
        const reanchored = yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: refreshed.revision,
            snapshotId: refreshed.snapshotId,
            idempotencyKey: "re-anchor",
            ops: [
              {
                type: "note.update",
                id: "n",
                anchor: { path: "a.ts", side: "new", startLine: 30, endLine: 30 },
              },
            ],
          }),
        });
        expect(reanchored.viewedHunkIds).toEqual([]);
      }),
    );
  });

  it("reads a range's captured commit messages in pages; refresh recaptures them, a check does not", async () => {
    const cwd = await repo("commits", { "a.txt": "base\n" });
    git(cwd, "branch", "-M", "main");
    git(cwd, "switch", "-qc", "feature");
    // Big enough that the two commits take two pages.
    const long = `Explain the change\n\n${"Why it matters. ".repeat(4500)}`;
    await writeFile(join(cwd, "a.txt"), "one\n");
    git(cwd, "commit", "-qam", long);
    await writeFile(join(cwd, "a.txt"), "two\n");
    git(cwd, "commit", "-qam", "Second step");
    const one = git(cwd, "rev-parse", "HEAD~1").trim();
    const two = git(cwd, "rev-parse", "HEAD").trim();
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const scope = { kind: "range", range: "main..feature" } as const;
        const { session } = yield* sessions.open({ command: "open", cwd, scope });
        const read = (snapshotId: string, after?: string) =>
          sessions.commits({ command: "commits", session: session.id, snapshotId, after });
        const first = yield* read(session.snapshotId);
        expect(first).toEqual({
          sessionId: session.id,
          snapshotId: session.snapshotId,
          total: 2,
          commits: [{ id: one, message: long.trimEnd() }],
          next: one,
        });
        expect(yield* read(session.snapshotId, one)).toMatchObject({
          commits: [{ id: two, message: "Second step" }],
          next: null,
        });
        // A well-formed id of no captured commit: two's with its first digit changed, whatever it is.
        const unknown = two.replace(/./u, (digit) => (digit === "0" ? "1" : "0"));
        expect(yield* Effect.flip(read(session.snapshotId, unknown))).toMatchObject({
          _tag: "validation_failed",
        });

        // A reworded commit changes no code; a check reports the change and replaces nothing.
        git(cwd, "commit", "-q", "--amend", "-m", "Second step, reworded");
        expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
          state: "changed",
        });
        expect(yield* read(session.snapshotId, one)).toMatchObject({
          commits: [{ id: two, message: "Second step" }],
        });
        const refreshed = yield* refreshNow(session.id);
        expect(refreshed).toMatchObject({ replaced: true, previousSnapshotId: session.snapshotId });
        const reworded = git(cwd, "rev-parse", "HEAD").trim();
        expect(yield* read(refreshed.snapshotId, one)).toMatchObject({
          commits: [{ id: reworded, message: "Second step, reworded" }],
        });
        expect(yield* Effect.flip(read(session.snapshotId))).toMatchObject({
          _tag: "stale_revision",
          detail: { snapshotId: refreshed.snapshotId },
        });

        // Uncommitted work captures none, so its one page is empty.
        const { session: local } = yield* sessions.open({
          command: "open",
          cwd,
          scope: uncommitted,
        });
        expect(
          yield* sessions.commits({
            command: "commits",
            session: local.id,
            snapshotId: local.snapshotId,
          }),
        ).toEqual({
          sessionId: local.id,
          snapshotId: local.snapshotId,
          total: 0,
          commits: [],
          next: null,
        });
      }),
    );
  });

  it("rejects a replaced snapshot as stale and finishes an in-flight read against its own", async () => {
    const cwd = await repo("stale", { "a.txt": "before\n" });
    await writeFile(join(cwd, "a.txt"), "during\n");
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        const first = { session: session.id, snapshotId: session.snapshotId };
        const held = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        readGate = held;
        const reading = yield* Effect.forkChild(code({ ...first, file: "a.txt", side: "new" }));
        yield* Deferred.await(held.started);
        readGate = undefined;
        yield* Effect.promise(() => writeFile(join(cwd, "a.txt"), "after\n"));
        const current = (yield* refreshNow(session.id)).snapshotId;
        expect(current).not.toBe(session.snapshotId);
        yield* Deferred.succeed(held.release, undefined);
        expect(yield* Fiber.join(reading)).toMatchObject({
          snapshotId: session.snapshotId,
          content: { text: "during\n" },
        });

        const stale = { _tag: "stale_revision", detail: { snapshotId: current } };
        expect(yield* codeError({ ...first, file: "a.txt", side: "new" })).toMatchObject(stale);
        expect(yield* Effect.flip(sessions.files({ command: "files", ...first }))).toMatchObject(
          stale,
        );
        expect(
          yield* codeError({ ...first, snapshotId: "f".repeat(64), file: "a.txt", side: "new" }),
        ).toMatchObject(stale);
        expect(
          yield* code({ session: session.id, snapshotId: current, file: "a.txt", side: "new" }),
        ).toMatchObject({ snapshotId: current, content: { text: "after\n" } });
      }),
    );
  });

  it("keeps Generated files from capture: reads and checks never resolve them, refresh does", async () => {
    const cwd = await repo("generated", {
      ".gitattributes": "gen.txt linguist-generated\n",
      "gen.txt": "generated\n",
      "plain.txt": "plain\n",
    });
    await writeFile(join(cwd, "gen.txt"), "generated again\n");
    await writeFile(join(cwd, "plain.txt"), "plain again\n");
    await runReal(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
        const status = () => sessions.status({ command: "status", session: session.id });
        const created = yield* status();
        expect(created.files).toEqual([
          { path: "gen.txt", hunkCount: 1, viewed: false, generated: true },
          { path: "plain.txt", hunkCount: 1, viewed: false },
        ]);
        const diff = yield* sessions.diff({ command: "diff", session: session.id });
        expect(diff.generatedFiles).toEqual(["gen.txt"]);
        const plainOnly = { command: "diff", session: session.id, file: "plain.txt" } as const;
        expect(yield* sessions.diff(plainOnly)).not.toHaveProperty("generatedFiles");
        const files = yield* sessions.files({
          command: "files",
          session: session.id,
          snapshotId: session.snapshotId,
        });
        expect(files.files.find(({ path }) => path === "gen.txt")).toMatchObject({
          generated: true,
        });
        yield* viewedNow(
          session.id,
          diff.hunks.map(({ id }) => id),
          "both",
        );

        // Git's own resolution now unmarks gen.txt without touching captured content: a source
        // check keeps the snapshot's record, and only a refresh reads attributes again.
        yield* Effect.promise(() =>
          writeFile(join(cwd, ".git", "info", "attributes"), "gen.txt -linguist-generated\n"),
        );
        expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
          state: "unchanged",
        });
        expect((yield* status()).files[0]).toMatchObject({ generated: true });
        const unmarked = yield* refreshNow(session.id);
        expect(unmarked).toMatchObject({ replaced: true, previousSnapshotId: session.snapshotId });
        expect((yield* status()).files).toEqual([
          { path: "gen.txt", hunkCount: 1, viewed: true },
          { path: "plain.txt", hunkCount: 1, viewed: true },
        ]);

        // A committed attribute edited in the checkout is captured content, so a check sees it.
        yield* Effect.promise(() =>
          writeFile(join(cwd, ".gitattributes"), "plain.txt linguist-vendored\n"),
        );
        expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
          state: "changed",
        });
        expect((yield* refreshNow(session.id)).replaced).toBe(true);
        expect((yield* status()).files).toEqual([
          { path: ".gitattributes", hunkCount: 1, viewed: false },
          { path: "gen.txt", hunkCount: 1, viewed: true },
          { path: "plain.txt", hunkCount: 1, viewed: true, generated: true },
        ]);
        expect(
          (yield* sessions.diff({ command: "diff", session: session.id })).generatedFiles,
        ).toEqual(["plain.txt"]);
      }),
    );
  });

  describe("reclaiming storage", () => {
    const onDisk = (kind: "blobs" | "snapshots" | "staging") =>
      readdir(join(dir, "data", "content", kind));
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const reclaim = Sessions.use((s) => s.reclaim);
    const remove = (session: string, requestId: string) =>
      Sessions.use((s) => s.delete({ command: "delete", session, requestId }));
    type Act = Input<"draft" | "send" | "resolve" | "discard">;
    const act = (request: Act) => Sessions.use((s) => s.converse(request));

    it("shares content across sessions and deletes one releasing only what no other retains", async () => {
      const cwd = await repo("shared", { "shared.ts": "shared\n", "a.ts": "a one\n" });
      await writeFile(join(cwd, "a.ts"), "a two\n");
      await writeFile(join(cwd, "b.ts"), "b\n");
      git(cwd, "add", ".");
      git(cwd, "commit", "-qm", "second");
      await writeFile(join(cwd, "a.ts"), "a three\n");
      const { uncommittedId, rangeId } = await runReal(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const open = (scope: Scope) => sessions.open({ command: "open", cwd, scope });
          const local = (yield* open(uncommitted)).session;
          const range = (yield* open({ kind: "range", range: "HEAD~1..HEAD" })).session;
          yield* reclaim;
          return { uncommittedId: local.id, rangeId: range.id };
        }),
      );
      // Only "a one" is the range's alone; the uncommitted scope's old side is the range's head.
      const bytes = ["shared\n", "a one\n", "a two\n", "a three\n", "b\n"];
      expect((await onDisk("blobs")).toSorted()).toEqual(bytes.map(sha256).toSorted());
      expect(await onDisk("snapshots")).toHaveLength(2);

      await runReal(
        Effect.gen(function* () {
          expect(yield* remove(rangeId, "delete-range")).toEqual({
            deleted: true,
            sessionId: rangeId,
          });
          expect(yield* reclaim).toEqual({ snapshots: 1, blobs: 1 });
        }),
      );
      expect((await onDisk("blobs")).toSorted()).toEqual(
        ["shared\n", "a two\n", "a three\n", "b\n"].map(sha256).toSorted(),
      );
      // What the remaining session reads survives the checkout too.
      await rm(cwd, { recursive: true, force: true });
      await runReal(
        Effect.gen(function* () {
          const { session } = yield* Sessions.use((s) =>
            s.open({ command: "open", session: uncommittedId }),
          );
          const read = (file: string, side: "old" | "new") =>
            code({ session: uncommittedId, snapshotId: session.snapshotId, file, side }).pipe(
              Effect.map(({ content }) => content.kind === "text" && content.text),
            );
          expect(yield* read("shared.ts", "new")).toBe("shared\n");
          expect(yield* read("a.ts", "old")).toBe("a two\n");
          expect(yield* read("a.ts", "new")).toBe("a three\n");
          // A lost reply's retry still gets the recorded deletion.
          expect(yield* remove(rangeId, "delete-range")).toEqual({
            deleted: true,
            sessionId: rangeId,
          });
          yield* remove(uncommittedId, "delete-local");
          expect(yield* reclaim).toEqual({ snapshots: 1, blobs: 4 });
        }),
      );
      expect(await onDisk("blobs")).toEqual([]);
      expect(await onDisk("snapshots")).toEqual([]);
    });

    it("keeps of an older snapshot what references, resolved threads and live drafts pin, across a restart", async () => {
      const numbered = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index + 1}\n`).join("");
      const cwd = await repo("pins", {
        "a.ts": numbered("a", 20),
        "helper.ts": numbered("h", 4),
        "thread.ts": "t1\nt2\n",
        "draft.ts": "d1\nd2\n",
        "other.ts": "o1\n",
      });
      const edit = (version: string) =>
        Promise.all([
          writeFile(join(cwd, "a.ts"), numbered("a", 20).replace("a10\n", "changed\n")),
          writeFile(join(cwd, "thread.ts"), `t-${version}\nt2\n`),
          writeFile(join(cwd, "draft.ts"), `d-${version}\nd2\n`),
          writeFile(join(cwd, "other.ts"), `o-${version}\n`),
        ]);
      await edit("first");
      const { sessionId, earlier, draft } = await runReal(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
          const change = (yield* sessions.diff({
            command: "diff",
            session: session.id,
          })).hunks.find(({ file }) => file === "a.ts");
          const others = (yield* sessions.diff({ command: "diff", session: session.id })).hunks
            .filter(({ file }) => file !== "a.ts")
            .map(({ id }) => id);
          yield* sessions.apply({
            command: "apply",
            session: session.id,
            batch: JSON.stringify({
              revision: 0,
              snapshotId: session.snapshotId,
              idempotencyKey: "publish",
              ops: [
                { type: "walkthrough.update", overview: "Edits." },
                {
                  type: "group.create",
                  id: "g",
                  title: "Change",
                  overview: "The change.",
                  memberHunkIds: [change!.id, ...others],
                },
                {
                  type: "note.create",
                  id: "n",
                  group: "g",
                  anchor: { path: "a.ts", side: "new", startLine: 10, endLine: 10 },
                  markdown: "Calls [the helper](gyst:new/helper.ts#L2-L3).",
                },
              ],
            }),
          });
          const anchor = (path: string) => ({
            snapshotId: session.snapshotId,
            path,
            side: "new" as const,
            startLine: 1,
            endLine: 1,
          });
          const comment = yield* act({
            command: "draft",
            session: session.id,
            requestId: "comment",
            target: { kind: "comment", anchor: anchor("thread.ts") },
          });
          const sent = yield* act({
            command: "send",
            session: session.id,
            requestId: "send",
            draft: comment.draft!,
            markdown: "Why?",
            kind: "question",
          });
          yield* act({
            command: "resolve",
            session: session.id,
            requestId: "resolve",
            thread: sent.thread!,
            resolved: true,
          });
          const live = yield* act({
            command: "draft",
            session: session.id,
            requestId: "live",
            target: { kind: "comment", anchor: anchor("draft.ts") },
          });
          yield* Effect.promise(async () => {
            await edit("second");
            await writeFile(join(cwd, "helper.ts"), numbered("h", 4).replace("h2\n", "H2\n"));
          });
          expect((yield* refreshNow(session.id)).replaced).toBe(true);
          return { sessionId: session.id, earlier: session.snapshotId, draft: live.draft! };
        }),
      );
      const readEarlier = (file: string) =>
        code({ session: sessionId, snapshotId: earlier, file, side: "new" }).pipe(
          Effect.map(({ content }) => content.kind === "text" && content.text),
        );
      // A new daemon: the browser that began the draft is long gone, and its pin still holds the
      // whole snapshot its links may name.
      await runReal(
        Effect.gen(function* () {
          yield* reclaim;
          expect(yield* readEarlier("other.ts")).toBe("o-first\n");
          expect(yield* readEarlier("draft.ts")).toBe("d-first\nd2\n");
        }),
      );
      expect(await onDisk("blobs")).toContain(sha256("o-first\n"));
      await runReal(
        Effect.gen(function* () {
          yield* act({ command: "discard", session: sessionId, requestId: "discard", draft });
          yield* reclaim;
          expect(yield* readEarlier("helper.ts")).toBe(numbered("h", 4));
          expect(yield* readEarlier("thread.ts")).toBe("t-first\nt2\n");
          for (const file of ["other.ts", "draft.ts"])
            expect(
              yield* Effect.flip(
                code({ session: sessionId, snapshotId: earlier, file, side: "new" }),
              ),
            ).toMatchObject({ _tag: "stale_revision", message: expect.stringContaining(file) });
          const listed = yield* Sessions.use((s) =>
            s.files({ command: "files", session: sessionId, snapshotId: earlier }),
          );
          // The note moved on with its unchanged line; its reference and the thread did not.
          expect(listed.files.map(({ path }) => path)).toEqual(["helper.ts", "thread.ts"]);
        }),
      );
      const kept = await onDisk("blobs");
      expect(kept).toContain(sha256("t-first\nt2\n"));
      expect(kept).not.toContain(sha256("o-first\n"));
      expect(kept).not.toContain(sha256("d-first\nd2\n"));
    });

    it("never reclaims what an in-flight read or capture holds", async () => {
      const cwd = await repo("held", { "x.txt": "before\n" });
      await writeFile(join(cwd, "x.txt"), "read while deleted\n");
      const second = await repo("captured", { "y.txt": "before\n" });
      await writeFile(join(second, "y.txt"), "captured during a reclaim\n");
      await runReal(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
          const held = {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          readGate = held;
          const reading = yield* Effect.forkChild(
            code({
              session: session.id,
              snapshotId: session.snapshotId,
              file: "x.txt",
              side: "new",
            }),
          );
          yield* Deferred.await(held.started);
          readGate = undefined;
          yield* remove(session.id, "delete-while-reading");
          let reclaimed = false;
          const reclaiming = yield* Effect.forkChild(
            reclaim.pipe(Effect.tap(() => Effect.sync(() => (reclaimed = true)))),
          );
          yield* Effect.sleep("50 millis");
          expect(reclaimed).toBe(false);
          yield* Deferred.succeed(held.release, undefined);
          expect(yield* Fiber.join(reading)).toMatchObject({
            content: { text: "read while deleted\n" },
          });
          yield* Fiber.join(reclaiming);
          expect(yield* Effect.promise(() => onDisk("blobs"))).not.toContain(
            sha256("read while deleted\n"),
          );

          // Every blob of this capture is committed while no session names them yet.
          const diffing = {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          diffGate = diffing;
          const opening = yield* Effect.forkChild(
            sessions.open({ command: "open", cwd: second, scope: uncommitted }),
          );
          yield* Deferred.await(diffing.started);
          reclaimed = false;
          const racing = yield* Effect.forkChild(
            reclaim.pipe(Effect.tap(() => Effect.sync(() => (reclaimed = true)))),
          );
          yield* Effect.sleep("50 millis");
          expect(reclaimed).toBe(false);
          yield* Deferred.succeed(diffing.release, undefined);
          const opened = (yield* Fiber.join(opening)).session;
          yield* Fiber.join(racing);
          expect(
            yield* code({
              session: opened.id,
              snapshotId: opened.snapshotId,
              file: "y.txt",
              side: "new",
            }),
          ).toMatchObject({ content: { text: "captured during a reclaim\n" } });
          yield* remove(opened.id, "delete-captured");
        }),
      );
    });

    it("reclaims and retries a capture that ran out of space once, then refuses with nothing saved", async () => {
      const retried = await repo("full-once", { "f.txt": "before\n" });
      await writeFile(join(retried, "f.txt"), "after\n");
      const refused = await repo("full", { "f.txt": "before\n" });
      await writeFile(join(refused, "f.txt"), "after\n");
      await runReal(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          outOfSpace = 1;
          const { session } = yield* sessions.open({
            command: "open",
            cwd: retried,
            scope: uncommitted,
          });
          expect(outOfSpace).toBe(0);
          const saved = new Set(files.keys());
          outOfSpace = 2;
          const error = yield* Effect.flip(
            sessions.open({ command: "open", cwd: refused, scope: uncommitted }),
          );
          expect(error).toMatchObject({
            _tag: "source_unavailable",
            detail: { reason: "storage_full" },
          });
          expect(new Set(files.keys())).toEqual(saved);
          expect((yield* sessions.list).sessions.map(({ id }) => id)).toEqual([session.id]);
          yield* remove(session.id, "delete-full");
          yield* reclaim;
        }),
      );
      expect(await onDisk("staging")).toEqual([]);
    });

    it("keeps every snapshot a session file this version cannot read names", async () => {
      const cwd = await repo("unreadable", { "u.txt": "before\n" });
      await writeFile(join(cwd, "u.txt"), "kept for an older version\n");
      const saved = await runReal(
        Sessions.use((s) => s.open({ command: "open", cwd, scope: uncommitted })),
      );
      const session = files.get(saved.session.id)!;
      files.delete(session.id);
      undecodable = [JSON.stringify({ ...session, revision: "from another version" })];
      await runReal(reclaim);
      expect(await onDisk("snapshots")).toEqual([`${session.snapshotId}.json`]);
      expect(await onDisk("blobs")).toContain(sha256("kept for an older version\n"));
      undecodable = [];
      await runReal(reclaim);
      expect(await onDisk("blobs")).toEqual([]);
    });

    it("captures under an optional snapshot quota and says which supporting files it left out", async () => {
      const cwd = await repo("quota", { "big.ts": "x".repeat(1000), "small.ts": "small\n" });
      await writeFile(join(cwd, "small.ts"), "changed\n");
      await runReal(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const { session } = yield* sessions.open({ command: "open", cwd, scope: uncommitted });
          const listed = yield* sessions.files({
            command: "files",
            session: session.id,
            snapshotId: session.snapshotId,
          });
          const omitted = { kind: "unavailable", reason: "quota" };
          expect(listed.files).toContainEqual({ path: "big.ts", old: omitted, new: omitted });
          expect(
            yield* code({
              session: session.id,
              snapshotId: session.snapshotId,
              file: "big.ts",
              side: "new",
            }),
          ).toMatchObject({ content: omitted });
          expect(yield* sessions.check({ command: "check", session: session.id })).toMatchObject({
            state: "unavailable",
            message: expect.stringContaining("quota"),
          });
          yield* remove(session.id, "delete-quota");
        }),
        { GYST_SNAPSHOT_QUOTA: "100 B" },
      );
      const tooSmall = await runReal(
        Effect.flip(Sessions.use((s) => s.open({ command: "open", cwd, scope: uncommitted }))),
        { GYST_SNAPSHOT_QUOTA: "5 B" },
      );
      expect(tooSmall).toMatchObject({
        _tag: "source_unavailable",
        detail: { reason: "quota_exceeded" },
      });
      expect([...files.values()].filter(({ repoRoot }) => repoRoot === cwd)).toEqual([]);
    });
  });
});
