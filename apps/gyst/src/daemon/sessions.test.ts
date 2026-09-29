import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApplyEnvelope,
  applyHumanAction,
  BadArgs,
  type HumanAction,
  type Session,
} from "@gyst/core";
import { Crypto, Effect, Exit, Fiber, Layer, PlatformError, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Git } from "./git.ts";
import { Sessions } from "./sessions.ts";
import { SessionStore } from "./store.ts";

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
let patchCalls: Array<{
  root: string;
  cwd: string;
  args: ReadonlyArray<string>;
  includeUntracked: boolean;
}>;
let saveFails: boolean;
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
  patch: (root, cwd, args, includeUntracked) =>
    Effect.suspend(() => {
      patchCalls.push({ root, cwd, args, includeUntracked });
      return patchEffect ?? Effect.succeed(gitPatch);
    }),
});

const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  save: (session) =>
    saveFails
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFile",
          }),
        )
      : Effect.sync(() => {
          files.set(session.id, session);
        }),
  remove: (id) =>
    Effect.sync(() => {
      files.delete(id);
    }),
});

const sessionsLayer = Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, store, crypto)));
// Like the daemon: persisted sessions are loaded once the service is built, not while building it.
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
  source: { kind: "stdin" },
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

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
  patchCalls = [];
  saveFails = false;
  nextId = 0;
  gitPatch = patch;
  patchEffect = undefined;
});

describe("Sessions.check", () => {
  it("checks the recorded scope without changing review state, shares results, and resets on refresh", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          const created = yield* sessions.create({
            command: "create",
            cwd: `${root}/nested`,
            revisions: ["HEAD"],
            pathspecs: ["a.txt"],
          });
          yield* sessions.apply({
            command: "apply",
            cwd: root,
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
          const reviewed = yield* sessions.status({ command: "status", cwd: root });
          expect(reviewed).toMatchObject({ revision: 2, groups: [{ id: "step", accepted: true }] });
          const before = JSON.stringify([...files]);
          gitPatch = patch.replace("+two", "+changed");
          const checks = yield* Effect.all(
            [
              sessions.check({ command: "check", cwd: root }),
              sessions.check({ command: "check", cwd: root }),
            ],
            { concurrency: "unbounded" },
          );
          expect(checks[0]).toMatchObject({
            sessionId: created.session.id,
            revision: 2,
            state: "changed",
          });
          expect(checks[1]).toEqual(checks[0]);
          expect(patchCalls).toHaveLength(2);
          expect(patchCalls[1]).toEqual({
            root,
            cwd: `${root}/nested`,
            args: ["HEAD", "--", "a.txt"],
            includeUntracked: false,
          });
          expect(JSON.stringify([...files])).toBe(before);
          expect(yield* sessions.status({ command: "status", cwd: root })).toEqual(reviewed);
          yield* sessions.refresh({ command: "refresh", cwd: root });
          expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
            revision: 3,
            state: "unchanged",
          });
          expect(patchCalls).toHaveLength(4);
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
            const created = yield* sessions.create({ command: "create", cwd: root, revisions: [] });
            patchEffect = Git.use((g) =>
              g.patch(process.cwd(), process.cwd(), ["HEAD"], false),
            ).pipe(
              Effect.provide(
                Git.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawner))),
              ),
            );
            const started = performance.now();
            const checking = yield* Effect.forkChild(
              sessions.check({ command: "check", cwd: root }),
            );
            const pid = yield* Effect.promise(() => ready.promise);
            expect(
              yield* sessions
                .status({ command: "status", cwd: root })
                .pipe(Effect.timeout("1 second")),
            ).toEqual(created);
            expect(yield* Fiber.join(checking)).toMatchObject({ state: "unavailable" });
            // Two seconds for patch execution plus bounded termination, not the child's six-second exit.
            expect(performance.now() - started).toBeLessThan(4000);
            expect(() => process.kill(pid, 0)).toThrow("ESRCH");
            expect(yield* sessions.status({ command: "status", cwd: root })).toEqual(created);
            patchEffect = undefined;
            yield* sessions.refresh({ command: "refresh", cwd: root });
            expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
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
          yield* sessions.create({ command: "create", cwd: root, revisions: [] });
          gitPatch = patch + "\n";
          expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
            state: "changed",
          });
          gitPatch = patch;
          expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
            state: "changed",
          });
          expect(patchCalls).toHaveLength(2);
          yield* Effect.sleep("5100 millis");
          expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
            state: "unchanged",
          });
          expect(patchCalls).toHaveLength(3);
        }),
      ),
    );
  }, 10_000);

  it("does not check stdin and reports an unreadable Git scope as unavailable", async () => {
    await run(
      Sessions.use((sessions) =>
        Effect.gen(function* () {
          expect(
            yield* sessions.check({ command: "check", cwd: root, session: persisted.id }),
          ).toMatchObject({ state: "stdin" });
          expect(patchCalls).toHaveLength(0);
          yield* sessions.create({ command: "create", cwd: root, revisions: [] });
          const before = JSON.stringify([...files]);
          patchEffect = Effect.fail(new BadArgs({ message: "recorded ref is unavailable" }));
          expect(yield* sessions.check({ command: "check", cwd: root })).toMatchObject({
            state: "unavailable",
          });
          expect(patchCalls[1]).toEqual({ root, cwd: root, args: [], includeUntracked: true });
          expect(JSON.stringify([...files])).toBe(before);
        }),
      ),
    );
  });
});

describe("Sessions.create", () => {
  it("creates the bare scope from git with untracked files and persists it", async () => {
    const status = await run(
      Sessions.use((s) => s.create({ command: "create", cwd: `${root}/sub`, revisions: [] })),
    );
    expect(status.inbox.map((hunk) => hunk.file)).toEqual(["a.txt", "b.txt"]);
    expect(status.session.source).toEqual({
      kind: "git",
      patchHash: expect.any(String),
      args: ["HEAD"],
      cwd: `${root}/sub`,
      includeUntracked: true,
    });
    expect(patchCalls).toEqual([{ root, cwd: `${root}/sub`, args: [], includeUntracked: true }]);
    expect(status.session.id).toBe("01010101-0101-4101-8101-010101010101");
    expect(files.get(status.session.id)?.hunks).toHaveLength(2);
    expect(status.revision).toBe(0);
    expect(status.queue).toEqual([]);
    expect(status.queueSet).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("replays explicit revisions and pathspecs from the caller's directory", async () => {
    const status = await run(
      Sessions.use((s) =>
        s.create({
          command: "create",
          cwd: root,
          revisions: ["HEAD~1", "HEAD"],
          pathspecs: ["a.txt"],
        }),
      ),
    );
    expect(status.session.source).toEqual({
      kind: "git",
      patchHash: expect.any(String),
      args: ["HEAD~1", "HEAD", "--", "a.txt"],
      cwd: root,
    });
    expect(patchCalls[0]?.includeUntracked).toBe(false);
  });

  it("reads a unified diff from stdin without touching git", async () => {
    const status = await run(
      Sessions.use((s) => s.create({ command: "create", cwd: root, revisions: [], patch })),
    );
    expect(status.session.source).toEqual({ kind: "stdin" });
    expect(status.inbox).toHaveLength(2);
    expect(patchCalls).toEqual([]);
  });

  it("rejects git options, stdin mixed with arguments, and non-patch stdin", async () => {
    const option = await failure(
      Sessions.use((s) => s.create({ command: "create", cwd: root, revisions: ["--stat"] })),
    );
    expect(option._tag).toBe("bad_args");
    expect(option.message).toContain("--stat");
    for (const [revisions, pathspecs, rejected] of [
      [["HEAD"], ["a.txt", "-p"], "-p"],
      // A revision `--` would move the pathspec separator Git sees.
      [["--", "HEAD"], ["a.txt"], "--"],
    ] as const) {
      const error = await failure(
        Sessions.use((s) => s.create({ command: "create", cwd: root, revisions, pathspecs })),
      );
      expect(error).toMatchObject({
        _tag: "bad_args",
        message: `git options are not accepted: ${rejected}`,
      });
    }
    for (const mixedArgs of [{ revisions: ["HEAD"] }, { revisions: [], pathspecs: [] }]) {
      const mixed = await failure(
        Sessions.use((s) => s.create({ command: "create", cwd: root, ...mixedArgs, patch })),
      );
      expect(mixed).toMatchObject({
        _tag: "bad_args",
        message: "--stdin cannot be combined with git arguments",
      });
    }
    const text = await failure(
      Sessions.use((s) =>
        s.create({ command: "create", cwd: root, revisions: [], patch: "just text\n" }),
      ),
    );
    expect(text._tag).toBe("bad_args");
    expect(text.message).toBe("invalid unified diff");
    const truncated = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n";
    const malformed = await failure(
      Sessions.use((s) =>
        s.create({ command: "create", cwd: root, revisions: [], patch: truncated }),
      ),
    );
    expect(malformed._tag).toBe("bad_args");
    expect(malformed.detail).toBe("parsePatchContent: hunk line count mismatch");
    expect(patchCalls).toEqual([]);
  });

  it("refuses a second session for the same repository", async () => {
    const error = await failure(
      Sessions.use((s) => s.create({ command: "create", cwd: otherRoot, revisions: [] })),
    );
    expect(error._tag).toBe("session_exists");
  });

  it("keeps a session out of memory when persistence fails", async () => {
    saveFails = true;
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const exit = yield* Effect.exit(
          sessions.create({ command: "create", cwd: root, revisions: [] }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const status = yield* Effect.flip(sessions.status({ command: "status", cwd: root }));
        expect(status._tag).toBe("no_session");
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
      Sessions.use((s) => s.diff({ command: "diff", cwd: otherRoot, group: "g1" })),
    );
    expect(value.hunks.map(({ id }) => id)).toEqual(["h3", "h1"]);
  });
  it("selects by repository or by exact --session id", async () => {
    const byRepo = await run(Sessions.use((s) => s.status({ command: "status", cwd: otherRoot })));
    expect(byRepo.session.id).toBe("persisted");
    expect(byRepo.groups[0]?.count).toBe(1);
    expect(byRepo.groups[0]?.accepted).toBe(true);
    expect(byRepo.groups[1]).toEqual({
      id: "g2",
      hunkIds: ["h2"],
      count: 1,
      title: "read me",
      notes: [{ hunkId: "h2", text: "intent and behavior" }],
      accepted: true,
    });
    expect(byRepo.inbox).toEqual([{ id: "h3", file: "y.txt" }]);
    const byId = await run(
      Sessions.use((s) => s.status({ command: "status", cwd: "/elsewhere", session: "persisted" })),
    );
    expect(byId.session.id).toBe("persisted");
    const missing = await failure(Sessions.use((s) => s.status({ command: "status", cwd: root })));
    expect(missing._tag).toBe("no_session");
    const unknown = await failure(
      Sessions.use((s) => s.status({ command: "status", cwd: root, session: "nope" })),
    );
    expect(unknown._tag).toBe("no_session");
  });

  it("filters diffs by hunk, group, or file and rejects bad selectors", async () => {
    const diff = (selector: { hunk?: string; group?: string; file?: string }) =>
      Sessions.use((s) =>
        s.diff({ command: "diff", cwd: root, session: "persisted", ...selector }),
      );
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
  const apply = (envelope: unknown, cwd = otherRoot) =>
    Sessions.use((s) =>
      s.apply({
        command: "apply",
        cwd: cwd,
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
      Sessions.use((s) => s.apply({ command: "apply", cwd: otherRoot, batch: "" })),
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
        const verdict = yield* s.status({ command: "status", cwd: otherRoot });
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
        expect((yield* s.status({ command: "status", cwd: otherRoot })).revision).toBe(
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

  it("re-reads a bare git session from its recorded source, keeping only unchanged work", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const created = yield* sessions.create({
          command: "create",
          cwd: `${root}/sub`,
          revisions: [],
        });
        const [a, b] = created.inbox.map((hunk) => hunk.id);
        yield* sessions.apply({
          command: "apply",
          cwd: root,
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
        const refreshed = yield* sessions.refresh({ command: "refresh", cwd: root });
        expect(patchCalls[1]).toEqual({
          root,
          cwd: `${root}/sub`,
          args: [],
          includeUntracked: true,
        });
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

  it("replays explicit git arguments and refuses --stdin for git sessions", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        yield* sessions.create({ command: "create", cwd: root, revisions: ["HEAD~1", "HEAD"] });
        const refreshed = yield* sessions.refresh({ command: "refresh", cwd: `${root}/sub` });
        expect(refreshed.revision).toBe(1);
        expect(patchCalls[1]).toEqual({
          root,
          cwd: root,
          args: ["HEAD~1", "HEAD"],
          includeUntracked: false,
        });
        const piped = yield* Effect.flip(
          sessions.refresh({ command: "refresh", cwd: root, patch }),
        );
        expect(piped._tag).toBe("bad_args");
        expect(piped.message).toBe("git sessions refresh their recorded arguments");
      }),
    );
  });

  it("refreshes stdin sessions only from a new --stdin patch", async () => {
    const withoutPipe = await failure(
      Sessions.use((s) => s.refresh({ command: "refresh", cwd: otherRoot })),
    );
    expect(withoutPipe._tag).toBe("bad_args");
    expect(withoutPipe.message).toBe("stdin sessions must be refreshed with --stdin");
    const notAPatch = await failure(
      Sessions.use((s) => s.refresh({ command: "refresh", cwd: otherRoot, patch: "text\n" })),
    );
    expect(notAPatch._tag).toBe("bad_args");
    const refreshed = await run(
      Sessions.use((s) => s.refresh({ command: "refresh", cwd: otherRoot, patch })),
    );
    expect(refreshed.revision).toBe(4);
    expect(refreshed.groups).toEqual([]);
    expect(refreshed.inbox.map((hunk) => hunk.file)).toEqual(["a.txt", "b.txt"]);
    expect(patchCalls).toEqual([]);
  });
});

describe("Sessions.load", () => {
  it("replaces the in-memory sessions with what is persisted now", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        // A rival daemon closed the persisted session and created another while we waited.
        files.delete(persisted.id);
        files.set("fresh", { ...persisted, id: "fresh", repoRoot: root });
        yield* sessions.load;
        const stale = yield* Effect.flip(sessions.status({ command: "status", cwd: otherRoot }));
        expect(stale._tag).toBe("no_session");
        expect((yield* sessions.status({ command: "status", cwd: root })).session.id).toBe("fresh");
      }),
    );
  });
});

describe("Sessions.close", () => {
  it("removes the session and signals idle once the last one is gone", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const created = yield* sessions.create({ command: "create", cwd: root, revisions: [] });
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        const closed = yield* sessions.close({ command: "close", cwd: root });
        expect(closed).toEqual({ closed: true, sessionId: created.session.id });
        expect(files.has(created.session.id)).toBe(false);
        expect(yield* sessions.isEmpty).toBe(false);
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        yield* sessions.close({ command: "close", cwd: otherRoot });
        expect(yield* sessions.isEmpty).toBe(true);
        yield* sessions.idle;
        expect(files.size).toBe(0);
      }),
    );
  });
});
