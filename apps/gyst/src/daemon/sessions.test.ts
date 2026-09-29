import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApplyEnvelope,
  applyHumanAction,
  BadArgs,
  type ByteRange,
  type HumanAction,
  InternalError,
  type Scope,
  type Session,
  type ManifestFile,
  pageBytes,
  type Request,
  type SnapshotManifest,
  snapshotIdOf,
} from "@gyst/core";
import {
  ConfigProvider,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PlatformError,
  Result,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestOf, publishingContent } from "./capture-doubles.ts";
import { CapturedContent } from "./content.ts";
import { Git } from "./git.ts";
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
let captureCalls: Array<{ root: string; scope: Scope }>;
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

const git = Layer.succeed(Git, {
  repoRoot: (cwd) =>
    cwd.startsWith(root) || cwd.startsWith(otherRoot)
      ? Effect.succeed(cwd.startsWith(root) ? root : otherRoot)
      : Effect.fail(new BadArgs({ message: "current directory is not inside a git repository" })),
  capture: (root, scope) =>
    Effect.suspend(() => {
      captureCalls.push({ root, scope });
      const captured =
        patchEffect ?? Effect.sync(() => withUncaptured(manifestOf(gitPatch, scope, supporting)));
      const delayed = slowCapture ? Effect.delay(captured, "20 millis") : captured;
      return gate
        ? Deferred.succeed(gate.started, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(delayed),
          )
        : delayed;
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
    saveFails
      ? Effect.fail(writeFailure)
      : Effect.sync(() => {
          commits.push(`session ${session.id}`);
          files.set(session.id, session);
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
  Layer.provide(Layer.mergeAll(git, store, crypto, content)),
);
// Like the daemon: persisted sessions are loaded once the service is built, not while building it.
// Each `run` is a fresh daemon over the same persisted files and receipts.
const run = <A, E>(effect: Effect.Effect<A, E, Sessions>) =>
  Effect.runPromise(
    Effect.provide(Sessions.use((s) => s.load).pipe(Effect.andThen(effect)), sessionsLayer),
  );
const failure = <A, E>(effect: Effect.Effect<A, E, Sessions>) => run(Effect.flip(effect));
// No daemon operation carries human work any more, so tests persist it with the pure reducer and
// reload, as a restarted daemon would read it.
const recordHumanAction = (sessionId: string, action: HumanAction) =>
  Effect.gen(function* () {
    const saved = files.get(sessionId)!;
    files.set(sessionId, Result.getOrThrow(applyHumanAction(saved, action, saved.updatedAt)));
    yield* Sessions.use((s) => s.load);
  });

const persisted: Session = {
  id: "persisted",
  repoRoot: otherRoot,
  scope: { kind: "range", range: "main...feature" },
  snapshotId: "persisted-snapshot",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  seq: 1,
  cursor: { itemId: null, pane: "queue" },
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
  groups: [
    {
      id: "g1",
      title: "same edit",
      notes: [{ hunkId: "h1", text: "intent and behavior" }],
      hunkIds: ["h1"],
      accepted: true,
    },
    {
      id: "g2",
      title: "read me",
      notes: [{ hunkId: "h2", text: "intent and behavior" }],
      hunkIds: ["h2"],
      accepted: true,
    },
  ],
  queue: ["g2", "g1", "h3"],
  queueSet: false,
  acceptHistory: ["g2", "g1"],
  receiptNoteTexts: [],
  applyReceipts: [],
};

const uncommitted = { kind: "uncommitted" } as const;
const openScope = (scope: Scope = uncommitted, cwd = root) =>
  Sessions.use((s) => s.open({ command: "open", cwd, scope }));

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
  deleteReceipts = [];
  captureCalls = [];
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
  commits = [];
});

describe("Sessions.check", () => {
  it("checks the recorded scope without changing review state, shares results, and resets on refresh", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const { session } = yield* openScope(uncommitted, `${root}/nested`);
          const created = yield* sessions.status({ command: "status", session: session.id });
          yield* sessions.apply({
            command: "apply",
            session: session.id,
            batch: JSON.stringify({
              revision: 0,
              idempotencyKey: "prepare",
              ops: [
                {
                  type: "group.create",
                  id: "step",
                  title: "Change both paths",
                  notes: [{ hunkId: created.inbox[0]!.id, text: "Review both changes together." }],
                  memberHunkIds: created.inbox.map(({ id }) => id),
                },
                { type: "queue.set", itemIds: ["step"] },
              ],
            }),
          });
          yield* recordHumanAction(created.session.id, {
            type: "verdict.toggle",
            sessionId: created.session.id,
            revision: 1,
            itemId: "step",
          });
          const reviewed = yield* sessions.status({ command: "status", session: session.id });
          expect(reviewed).toMatchObject({ revision: 2, groups: [{ id: "step", accepted: true }] });
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
    expect(status).toMatchObject({ revision: 0, queue: [], queueSet: false, ready: false });
    expect(status.inbox.map((hunk) => hunk.file)).toEqual(["a.txt", "b.txt"]);
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
                idempotencyKey: "during-capture",
                ops: [
                  {
                    type: "group.create",
                    id: "g3",
                    memberHunkIds: ["h3"],
                    title: "third",
                    notes: [{ hunkId: "h3", text: "third" }],
                  },
                  { type: "queue.set", itemIds: ["g1", "g2", "g3"] },
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
    expect(byId.groups[0]?.accepted).toBe(true);
    expect(byId.groups[1]).toEqual({
      id: "g2",
      hunkIds: ["h2"],
      count: 1,
      title: "read me",
      notes: [{ hunkId: "h2", text: "intent and behavior" }],
      accepted: true,
    });
    expect(byId.inbox).toEqual([{ id: "h3", file: "y.txt" }]);
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
    idempotencyKey: "first-pass",
    ops: [
      {
        type: "group.create",
        id: "g3",
        memberHunkIds: ["h3"],
        title: "third",
        notes: [{ hunkId: "h3", text: "third" }],
      },
      { type: "queue.set", itemIds: ["g1", "g2", "g3"] },
    ],
  };

  it("applies a validated batch, bumps the revision, and persists a durable receipt", async () => {
    const status = await run(apply(envelope));
    expect(status.revision).toBe(4);
    expect(status.seq).toBe(2);
    expect(status.inbox).toEqual([]);
    expect(status.groups.map((group) => group.id)).toEqual(["g1", "g2", "g3"]);
    expect(status).toMatchObject({ queue: ["g1", "g2", "g3"], queueSet: true, ready: true });
    const saved = files.get("persisted")!;
    // The receipt stores each distinct note text once; g1 and g2 share the same text.
    expect(saved.receiptNoteTexts).toEqual(["intent and behavior", "third"]);
    expect(saved.applyReceipts).toEqual([
      {
        key: "first-pass",
        digest: expect.any(String),
        status: {
          ...status,
          groups: [
            { ...status.groups[0]!, notes: [{ hunkId: "h1", text: 0 }] },
            { ...status.groups[1]!, notes: [{ hunkId: "h2", text: 0 }] },
            { ...status.groups[2]!, notes: [{ hunkId: "h3", text: 1 }] },
          ],
        },
      },
    ]);
    expect(saved.groups[2]?.title).toBe("third");
    // The receipt answers a replay before the revision check, so a retried batch is a no-op.
    expect(await run(apply(envelope))).toEqual(status);
    expect(files.get("persisted")?.revision).toBe(4);
  });

  it("rejects the whole batch on any invalid op, an incomplete queue, or a stale revision", async () => {
    const invalid = await failure(
      apply({
        revision: 3,
        idempotencyKey: "invalid",
        ops: [
          {
            type: "group.create",
            id: "g3",
            title: "coherent change",
            notes: [],
            memberHunkIds: ["h3"],
          },
          { type: "group.update", id: "missing", title: "nope" },
        ],
      }),
    );
    expect(invalid._tag).toBe("validation_failed");
    expect(invalid.detail).toEqual([{ opIndex: 1, message: "group missing does not exist" }]);
    const incomplete = await failure(
      apply({
        revision: 3,
        idempotencyKey: "incomplete",
        ops: [{ type: "queue.set", itemIds: ["g1"] }],
      }),
    );
    expect(incomplete._tag).toBe("validation_failed");
    expect((incomplete.detail as Array<{ message: string }>).at(-1)?.message).toContain(
      "exactly once",
    );
    const stale = await failure(apply({ revision: 0, idempotencyKey: "stale", ops: [] }));
    expect(stale._tag).toBe("stale_revision");
    expect(stale.detail).toEqual([expect.objectContaining({ opIndex: -1 })]);
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
      { type: "group.update", id: "g1", overview: "old" },
      { type: "group.update", id: "g1", notes: [{ hunkId: "h2", text: "wrong group" }] },
      { type: "group.update", id: "g1", notes: [{ hunkId: "h1", text: "bad\ntext" }] },
      { type: "group.update", id: "g1", tldr: "old" },
      { type: "group.update", id: "g1", exemplarHunkId: "h1" },
      { type: "group.update", id: "g1", title: "new", tldr: "old" },
      { type: "group.create", id: "g3", memberHunkIds: ["h3"], title: "partial" },
      {
        type: "group.create",
        id: "g3",
        memberHunkIds: ["h3"],
        title: "bad\u001b",
        notes: [{ hunkId: "h3", text: "valid" }],
      },
      { type: "hunk.annotate", hunkId: "h3", title: "obsolete", overview: "obsolete" },
    ]) {
      expect(
        (await failure(apply({ revision: 3, idempotencyKey: "invalid", ops: [op] })))._tag,
      ).toBe("validation_failed");
      expect(files.get("persisted")).toEqual(persisted);
    }
  });

  it("publishes progressively around human work and replays historical receipts without rollback", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* Sessions;
        const firstBatch = {
          revision: 3,
          idempotencyKey: "partial",
          ops: [{ type: "queue.set", itemIds: ["g2", "g1"] }],
        };
        const first = yield* apply(firstBatch);
        expect(first).toMatchObject({ ready: false, inbox: [{ id: "h3" }] });
        yield* recordHumanAction("persisted", { type: "cursor.move", itemId: "g2" });
        yield* recordHumanAction("persisted", {
          type: "verdict.toggle",
          itemId: "g2",
          sessionId: "persisted",
          revision: 4,
        });
        const verdict = yield* s.status({ command: "status", session: persisted.id });
        const obsolete = yield* Effect.flip(apply({ ...envelope, revision: 4 }));
        expect(obsolete._tag).toBe("stale_revision");
        const second = yield* apply({
          ...envelope,
          revision: verdict.revision,
          ops: [envelope.ops[0], { type: "queue.set", itemIds: ["g2", "g1", "g3"] }],
        });
        expect(second).toMatchObject({
          queue: ["g2", "g1", "g3"],
          cursor: verdict.cursor,
          groups: [
            { id: "g1", accepted: true },
            { id: "g2", accepted: false },
            { id: "g3", accepted: false },
          ],
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
        const [a, b] = created.inbox.map((hunk) => hunk.id);
        yield* sessions.apply({
          command: "apply",
          session: session.id,
          batch: JSON.stringify({
            revision: 0,
            idempotencyKey: "fold",
            ops: [
              {
                type: "group.create",
                id: "g",
                title: "same",
                notes: [{ hunkId: a, text: "intent and behavior" }],
                memberHunkIds: [a],
              },
              {
                type: "group.create",
                id: "changed",
                memberHunkIds: [b],
                title: "stale note",
                notes: [{ hunkId: b, text: "stale note" }],
              },
              { type: "queue.set", itemIds: ["g", "changed"] },
            ],
          }),
        });
        gitPatch = changed;
        const refreshed = yield* sessions.refresh({ command: "refresh", session: session.id });
        expect(captureCalls[1]).toEqual({ root, scope: uncommitted });
        expect(refreshed.session.snapshotId).not.toBe(session.snapshotId);
        expect(refreshed.revision).toBe(2);
        expect(refreshed.groups).toEqual([
          expect.objectContaining({ id: "g", hunkIds: [a], accepted: false }),
        ]);
        expect(refreshed.inbox.map((hunk) => hunk.file)).toEqual(["b.txt", "c.txt"]);
        expect(refreshed.inbox.map((hunk) => hunk.id)).not.toContain(b);
        expect(refreshed.queue).toEqual(["g", ...refreshed.inbox.map((hunk) => hunk.id)]);
        expect(refreshed).toMatchObject({ queueSet: false, ready: false });
        expect(files.get(created.session.id)?.revision).toBe(2);
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
            idempotencyKey: "before-refresh",
            ops: [
              {
                type: "group.create",
                id: "g3",
                memberHunkIds: ["h3"],
                title: "third",
                notes: [{ hunkId: "h3", text: "third" }],
              },
              { type: "queue.set", itemIds: ["g1", "g2", "g3"] },
            ],
          }),
        });
        yield* recordHumanAction(persisted.id, {
          type: "verdict.toggle",
          sessionId: persisted.id,
          revision: persisted.revision + 1,
          itemId: "g3",
        });
        const before = JSON.stringify([...files]);
        const status = yield* sessions.status({ command: "status", session: persisted.id });
        expect(status).toMatchObject({ revision: persisted.revision + 2 });
        expect(status.groups.find(({ id }) => id === "g3")?.accepted).toBe(true);
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
          const created = yield* sessions.status({ command: "status", session: session.id });
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
                idempotencyKey: "late",
                ops: [
                  {
                    type: "group.create",
                    id: "late",
                    title: "Late guidance",
                    notes: [{ hunkId: created.inbox[0]!.id, text: "Written during capture." }],
                    memberHunkIds: created.inbox.map(({ id }) => id),
                  },
                  { type: "queue.set", itemIds: ["late"] },
                ],
              }),
            })
            .pipe(Effect.timeout("1 second"));
          // A human verdict persisted by another process, then loaded, also during the capture.
          yield* recordHumanAction(session.id, {
            type: "verdict.toggle",
            sessionId: session.id,
            revision: 1,
            itemId: "late",
          }).pipe(Effect.timeout("1 second"));
          yield* Deferred.succeed(held.release, undefined);
          const refreshed = yield* Fiber.join(refreshing);
          expect(refreshed.revision).toBe(3);
          expect(refreshed.groups).toEqual([
            expect.objectContaining({ id: "late", accepted: true }),
          ]);
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
          Layer.provide(Layer.mergeAll(store, crypto)),
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
  // Two-byte characters straddle every page split; a short line follows the giant one.
  const giant = `${"é".repeat(100_000)}z\nshort\n`;

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
