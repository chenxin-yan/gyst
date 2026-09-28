import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApplyEnvelope,
  applyHumanAction,
  BadArgs,
  type HumanAction,
  type Scope,
  type Session,
} from "@gyst/core";
import { Crypto, Effect, Exit, Fiber, Layer, PlatformError, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Git } from "./git.ts";
import { Sessions } from "./sessions.ts";
import { type DeleteReceipt, SessionStore } from "./store.ts";

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
let patchEffect: Effect.Effect<string, BadArgs> | undefined;

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
      return patchEffect ?? Effect.succeed(gitPatch);
    }),
});

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

const sessionsLayer = Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, store, crypto)));
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
  patchEffect = undefined;
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
                Git.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawner))),
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
          gitPatch = patch + "\n";
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
    expect(new Set(opened.map(({ session }) => session.snapshotId)).size).toBe(1);
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
    patchEffect = Effect.sleep("20 millis").pipe(Effect.as(patch));
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
    gitPatch = "just text\n";
    expect(await failure(openScope())).toMatchObject({
      _tag: "bad_args",
      message: "invalid unified diff",
    });
    gitPatch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n";
    expect(await failure(openScope())).toMatchObject({
      _tag: "bad_args",
      detail: "parsePatchContent: hunk line count mismatch",
    });
    expect([...files.keys()]).toEqual([persisted.id]);
  });

  it("keeps a session out of memory when persistence fails", async () => {
    saveFails = true;
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        expect(Exit.isFailure(yield* Effect.exit(openScope()))).toBe(true);
        expect((yield* sessions.list).sessions.map(({ id }) => id)).toEqual([persisted.id]);
        expect([...files.keys()]).toEqual([persisted.id]);
      }),
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
      }),
    );
    expect([...files.keys()]).toEqual([other.id]);
    expect(deleteReceipts).toEqual([{ requestId: "retry-me", sessionId: persisted.id }]);
    expect((await failure(remove(other.id, "")))._tag).toBe("bad_args");
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
