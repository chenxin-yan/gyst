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
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, publishingContent } from "./capture-doubles.ts";
import { CapturedContent } from "./content.ts";
import { Git, type PullRequestTarget } from "./git.ts";
import { GitHub, type StackDiscovery } from "./github.ts";
import { Paths } from "./paths.ts";
import { Sessions } from "./sessions.ts";
import { type DeleteReceipt, SessionStore } from "./store.ts";

type Input<C extends Request["command"]> = Extract<Request, { readonly command: C }>;
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
let nextId: number;
let gitPatch: string;
let supporting: Record<string, string>;
let patchEffect: Effect.Effect<SnapshotManifest, BadArgs | InternalError> | undefined;
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
};

const uncommitted = { kind: "uncommitted" } as const;
const openScope = (scope: Scope = uncommitted, cwd = root) =>
  Sessions.use((s) => s.open({ command: "open", cwd, scope }));

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
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
          yield* sessions.refresh({ command: "refresh", session: session.id });
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
            yield* sessions.refresh({ command: "refresh", session: session.id });
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
  it("captures uncommitted changes of the caller's repository and returns identity and launch data", async () => {
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
      launch: { argv: ["gyst", "--session", id] },
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
            yield* sessions.refresh({ command: "refresh", session: session.id });
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
    const refreshed = await run(
      Sessions.use((s) => s.refresh({ command: "refresh", session: session.id })),
    );
    expect(refreshed.session.snapshotId).not.toBe(session.snapshotId);
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
    expect(
      await failure(Sessions.use((s) => s.refresh({ command: "refresh", session: session.id }))),
    ).toBe(pullRequestFailure);
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
      sessions: [{ number: 2, sessionId: b.id, hunkCount: 2, viewedCount: 0 }],
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
    pullRequestEdit = { state: "merged", title: "Renamed layer" };
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
      { number: 2, sessionId: b.id, hunkCount: 2, viewedCount: 1 },
    ]);
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
        const refreshed = yield* sessions.refresh({ command: "refresh", session: session.id });
        expect(captureCalls[1]).toEqual({ root, scope: uncommitted });
        expect(refreshed.session.snapshotId).not.toBe(session.snapshotId);
        expect(refreshed.revision).toBe(3);
        expect(refreshed.groups).toEqual([expect.objectContaining({ id: "g", hunkIds: [a] })]);
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
    const refreshed = await run(
      Sessions.use((s) => s.refresh({ command: "refresh", session: persisted.id })),
    );
    expect(captureCalls).toEqual([{ root: otherRoot, scope: persisted.scope }]);
    expect(refreshed.revision).toBe(4);
    expect(refreshed.session.scope).toEqual(persisted.scope);
    expect(files.get(persisted.id)?.snapshotId).toBe(refreshed.session.snapshotId);
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
        const refresh = sessions.refresh({ command: "refresh", session: persisted.id });
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
          const refreshing = yield* Effect.forkChild(
            sessions.refresh({ command: "refresh", session: session.id }),
          );
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
          yield* Deferred.succeed(held.release, undefined);
          const refreshed = yield* Fiber.join(refreshing);
          expect(refreshed.revision).toBe(3);
          expect(refreshed.groups).toEqual([expect.objectContaining({ id: "late" })]);
          expect(refreshed.viewedHunkIds).toEqual(ids);
          expect(files.get(session.id)?.revision).toBe(3);
        }),
      ),
    );
  });

  it("does not resurrect a session deleted while its refresh captured", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const held = yield* holdCaptures;
          const refreshing = yield* Effect.forkChild(
            sessions.refresh({ command: "refresh", session: persisted.id }),
          );
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
    return { sessionId: saved.id, snapshotId: saved.snapshotId, revision: saved.revision };
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
  const refresh = Sessions.use((s) => s.refresh({ command: "refresh", session: persisted.id }));
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
            snapshotId: refreshed.session.snapshotId,
            revision: refreshed.revision,
          });
          expect(refreshed.session.snapshotId).not.toBe(persisted.snapshotId);
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
  const gatedContent = Layer.effect(
    CapturedContent,
    Effect.map(CapturedContent, (real) => ({
      ...real,
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
  /** Real Git capture into real captured content under a private data dir. */
  const runReal = <A, E>(effect: Effect.Effect<A, E, Sessions>) =>
    Effect.runPromise(
      Effect.provide(
        Sessions.use((s) => s.load).pipe(Effect.andThen(effect)),
        Sessions.layer.pipe(
          Layer.provide(Git.layer.pipe(Layer.provideMerge(gatedContent))),
          Layer.provide(Layer.mergeAll(store, crypto, github)),
          Layer.provide(Paths.layer),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: join(dir, "data") })),
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
        const refreshed = yield* sessions.refresh({ command: "refresh", session: session.id });
        const current = refreshed.session.snapshotId;
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
});
