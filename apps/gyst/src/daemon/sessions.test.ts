import { beforeEach, describe, expect, it } from "bun:test";
import {
  type ApplyEnvelope,
  BadArgs,
  type HumanAction,
  type Request,
  type Session,
} from "@gyst/core";
import { Crypto, Effect, Exit, Layer, PlatformError } from "effect";
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
    Effect.sync(() => {
      patchCalls.push({ root, cwd, args, includeUntracked });
      return gitPatch;
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
const request = (
  command: Request["command"],
  args: string[] = [],
  cwd = root,
  stdin?: string,
): Request => ({ command, cwd, args, ...(stdin === undefined ? {} : { stdin }) });

const persisted: Session = {
  id: "persisted",
  repoRoot: otherRoot,
  source: { kind: "stdin" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  seq: 1,
  cursor: { itemId: null, expanded: false },
  hunks: [
    {
      id: "h1",
      file: "x.txt",
      header: "@@ -1 +1 @@",
      patch: "@@ -1 +1 @@\n-a\n+b",
      contentHash: "ab",
      accepted: false,
    },
    {
      id: "h2",
      file: "y.txt",
      header: "@@ -1 +1 @@",
      patch: "@@ -1 +1 @@\n-c\n+d",
      contentHash: "cd",
      title: "read me",
      overview: "intent and behavior",
      accepted: true,
    },
    {
      id: "h3",
      file: "y.txt",
      header: "@@ -5 +5 @@",
      patch: "@@ -5 +5 @@\n-e\n+f",
      contentHash: "ef",
      accepted: false,
    },
  ],
  groups: [
    {
      id: "g1",
      title: "same edit",
      overview: "intent and behavior",
      hunkIds: ["h1"],
      accepted: true,
    },
  ],
  queue: ["h2", "g1", "h3"],
  queueSet: false,
  acceptHistory: ["h2", "g1"],
  receiptOverviews: [],
  applyReceipts: [],
};

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
  patchCalls = [];
  saveFails = false;
  nextId = 0;
  gitPatch = patch;
});

describe("Sessions.create", () => {
  it("creates the bare scope from git with untracked files and persists it", async () => {
    const status = await run(
      Sessions.use((s) => s.create(request("create", ["--"], `${root}/sub`))),
    );
    expect(status.inbox.map((hunk) => hunk.file)).toEqual(["a.txt", "b.txt"]);
    expect(status.session.source).toEqual({
      kind: "git",
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
      Sessions.use((s) => s.create(request("create", ["--", "HEAD~1", "HEAD", "--", "a.txt"]))),
    );
    expect(status.session.source).toEqual({
      kind: "git",
      args: ["HEAD~1", "HEAD", "--", "a.txt"],
      cwd: root,
    });
    expect(patchCalls[0]?.includeUntracked).toBe(false);
  });

  it("reads a unified diff from stdin without touching git", async () => {
    const status = await run(
      Sessions.use((s) => s.create(request("create", ["--stdin", "--"], root, patch))),
    );
    expect(status.session.source).toEqual({ kind: "stdin" });
    expect(status.inbox).toHaveLength(2);
    expect(patchCalls).toEqual([]);
  });

  it("rejects git options, stdin mixed with arguments, and non-patch stdin", async () => {
    const option = await failure(
      Sessions.use((s) => s.create(request("create", ["--", "--stat"]))),
    );
    expect(option._tag).toBe("bad_args");
    expect(option.message).toContain("--stat");
    const mixed = await failure(
      Sessions.use((s) => s.create(request("create", ["--stdin", "--", "HEAD"], root, patch))),
    );
    expect(mixed._tag).toBe("bad_args");
    const text = await failure(
      Sessions.use((s) => s.create(request("create", ["--stdin", "--"], root, "just text\n"))),
    );
    expect(text._tag).toBe("bad_args");
    expect(text.message).toBe("invalid unified diff");
    const truncated = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n";
    const malformed = await failure(
      Sessions.use((s) => s.create(request("create", ["--stdin", "--"], root, truncated))),
    );
    expect(malformed._tag).toBe("bad_args");
    expect(malformed.detail).toBe("parsePatchContent: hunk line count mismatch");
    expect(patchCalls).toEqual([]);
  });

  it("refuses a second session for the same repository", async () => {
    const error = await failure(
      Sessions.use((s) => s.create(request("create", ["--"], otherRoot))),
    );
    expect(error._tag).toBe("session_exists");
  });

  it("keeps a session out of memory when persistence fails", async () => {
    saveFails = true;
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const exit = yield* Effect.exit(sessions.create(request("create", ["--"])));
        expect(Exit.isFailure(exit)).toBe(true);
        const status = yield* Effect.flip(sessions.status(request("status")));
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
      Sessions.use((s) => s.diff(request("diff", ["--group", "g1"], otherRoot))),
    );
    expect(value.hunks.map(({ id }) => id)).toEqual(["h3", "h1"]);
  });
  it("selects by repository or by exact --session id", async () => {
    const byRepo = await run(Sessions.use((s) => s.status(request("status", [], otherRoot))));
    expect(byRepo.session.id).toBe("persisted");
    expect(byRepo.groups[0]?.count).toBe(1);
    expect(byRepo.groups[0]?.accepted).toBe(true);
    expect(byRepo.spotlight).toEqual([
      {
        id: "h2",
        file: "y.txt",
        title: "read me",
        overview: "intent and behavior",
        accepted: true,
      },
    ]);
    expect(byRepo.inbox).toEqual([{ id: "h3", file: "y.txt" }]);
    const byId = await run(
      Sessions.use((s) => s.status(request("status", ["--session", "persisted"], "/elsewhere"))),
    );
    expect(byId.session.id).toBe("persisted");
    const missing = await failure(Sessions.use((s) => s.status(request("status"))));
    expect(missing._tag).toBe("no_session");
    const unknown = await failure(
      Sessions.use((s) => s.status(request("status", ["--session", "nope"]))),
    );
    expect(unknown._tag).toBe("no_session");
  });

  it("filters diffs by hunk, group, or file and rejects bad selectors", async () => {
    const diff = (args: string[]) =>
      Sessions.use((s) => s.diff(request("diff", ["--session", "persisted", ...args])));
    expect((await run(diff([]))).hunks.map((hunk) => hunk.id)).toEqual(["h1", "h2", "h3"]);
    expect((await run(diff(["--hunk", "h2"]))).hunks.map((hunk) => hunk.id)).toEqual(["h2"]);
    expect((await run(diff(["--group", "g1"]))).hunks.map((hunk) => hunk.id)).toEqual(["h1"]);
    const byFile = await run(diff(["--file", "y.txt"]));
    expect(byFile.hunks.map((hunk) => hunk.id)).toEqual(["h2", "h3"]);
    expect(byFile.revision).toBe(3);
    expect((await failure(diff(["--hunk", "h1", "--file", "x.txt"])))._tag).toBe("bad_args");
    expect((await failure(diff(["--group", "missing"])))._tag).toBe("validation_failed");
    expect((await failure(diff(["--hunk", "missing"])))._tag).toBe("validation_failed");
    expect((await failure(diff(["--bogus"])))._tag).toBe("bad_args");
  });

  it("rejects options another command owns and leaves the session untouched", async () => {
    const apply = await failure(
      Sessions.use((s) =>
        s.apply(
          request(
            "apply",
            ["--file", "x.txt"],
            otherRoot,
            JSON.stringify({ revision: 3, idempotencyKey: "flagged", ops: [] }),
          ),
        ),
      ),
    );
    expect(apply._tag).toBe("bad_args");
    const status = await failure(Sessions.use((s) => s.status(request("status", ["--stdin"]))));
    expect(status._tag).toBe("bad_args");
    const refresh = await failure(
      Sessions.use((s) => s.refresh(request("refresh", ["--hunk", "h1"], otherRoot))),
    );
    expect(refresh._tag).toBe("bad_args");
    expect(files.get("persisted")).toEqual(persisted);
    expect(patchCalls).toEqual([]);
  });
});

describe("Sessions.apply", () => {
  const apply = (envelope: unknown, cwd = otherRoot) =>
    Sessions.use((s) =>
      s.apply(
        request(
          "apply",
          [],
          cwd,
          typeof envelope === "string" ? envelope : JSON.stringify(envelope),
        ),
      ),
    );
  const envelope: ApplyEnvelope = {
    revision: 3,
    idempotencyKey: "first-pass",
    ops: [
      { type: "hunk.annotate", hunkId: "h3", title: "third", overview: "third" },
      { type: "queue.set", itemIds: ["g1", "h2", "h3"] },
    ],
  };

  it("applies a validated batch, bumps the revision, and persists a durable receipt", async () => {
    const status = await run(apply(envelope));
    expect(status.revision).toBe(4);
    expect(status.seq).toBe(2);
    expect(status.inbox).toEqual([]);
    expect(status.spotlight.map((hunk) => hunk.id)).toEqual(["h2", "h3"]);
    expect(status).toMatchObject({ queue: ["g1", "h2", "h3"], queueSet: true, ready: true });
    const saved = files.get("persisted")!;
    // The receipt stores each distinct overview once; g1 and h2 share the same text.
    expect(saved.receiptOverviews).toEqual(["intent and behavior", "third"]);
    expect(saved.applyReceipts).toEqual([
      {
        key: "first-pass",
        digest: expect.any(String),
        status: {
          ...status,
          groups: [{ ...status.groups[0]!, overview: 0 }],
          spotlight: [
            { ...status.spotlight[0]!, overview: 0 },
            { ...status.spotlight[1]!, overview: 1 },
          ],
        },
      },
    ]);
    expect(saved.hunks[2]?.title).toBe("third");
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
            id: "g2",
            title: "coherent change",
            overview: "intent and behavior",
            memberHunkIds: ["h3"],
          },
          { type: "hunk.annotate", hunkId: "missing", title: "nope", overview: "nope" },
        ],
      }),
    );
    expect(invalid._tag).toBe("validation_failed");
    expect(invalid.detail).toEqual([{ opIndex: 1, message: "hunk missing does not exist" }]);
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
    const missing = await failure(Sessions.use((s) => s.apply(request("apply", [], otherRoot))));
    expect(missing._tag).toBe("validation_failed");
    expect(files.get("persisted")).toEqual(persisted);
  });

  it("rejects legacy fields, partial metadata and controls without writes", async () => {
    for (const op of [
      { type: "group.update", id: "g1", tldr: "old" },
      { type: "group.update", id: "g1", exemplarHunkId: "h1" },
      { type: "group.update", id: "g1", title: "new", tldr: "old" },
      { type: "hunk.annotate", hunkId: "h3", title: "partial" },
      { type: "hunk.annotate", hunkId: "h3", title: "bad\u001b", overview: "valid" },
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
          ops: [{ type: "queue.set", itemIds: ["h2", "g1"] }],
        };
        const first = yield* apply(firstBatch);
        expect(first).toMatchObject({ ready: false, inbox: [{ id: "h3" }] });
        yield* s.tuiAction({
          ...request("tui.action", [], otherRoot),
          action: { type: "cursor.move", itemId: "h2" },
        });
        const verdict = yield* s.tuiAction({
          ...request("tui.action", [], otherRoot),
          action: { type: "verdict.toggle", itemId: "h2", sessionId: "persisted", revision: 4 },
        });
        const obsolete = yield* Effect.flip(apply({ ...envelope, revision: 4 }));
        expect(obsolete._tag).toBe("stale_revision");
        const second = yield* apply({
          ...envelope,
          revision: verdict.revision,
          ops: [envelope.ops[0], { type: "queue.set", itemIds: ["h2", "g1", "h3"] }],
        });
        expect(second).toMatchObject({
          queue: ["h2", "g1", "h3"],
          cursor: verdict.cursor,
          spotlight: [
            { id: "h2", accepted: false },
            { id: "h3", accepted: false },
          ],
        });
        expect(yield* apply(firstBatch)).toEqual(first);
        expect((yield* s.status(request("status", [], otherRoot))).revision).toBe(second.revision);
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
        const created = yield* sessions.create(request("create", ["--"], `${root}/sub`));
        const [a, b] = created.inbox.map((hunk) => hunk.id);
        yield* sessions.apply(
          request(
            "apply",
            [],
            root,
            JSON.stringify({
              revision: 0,
              idempotencyKey: "fold",
              ops: [
                {
                  type: "group.create",
                  id: "g",
                  title: "same",
                  overview: "intent and behavior",
                  memberHunkIds: [a],
                },
                { type: "hunk.annotate", hunkId: b, title: "stale note", overview: "stale note" },
                { type: "queue.set", itemIds: ["g", b] },
              ],
            }),
          ),
        );
        gitPatch = changed;
        const refreshed = yield* sessions.refresh(request("refresh", [], root));
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
        expect(refreshed.spotlight).toEqual([]);
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
        yield* sessions.create(request("create", ["--", "HEAD~1", "HEAD"]));
        const refreshed = yield* sessions.refresh(request("refresh", [], `${root}/sub`));
        expect(refreshed.revision).toBe(1);
        expect(patchCalls[1]).toEqual({
          root,
          cwd: root,
          args: ["HEAD~1", "HEAD"],
          includeUntracked: false,
        });
        const piped = yield* Effect.flip(
          sessions.refresh(request("refresh", ["--stdin"], root, patch)),
        );
        expect(piped._tag).toBe("bad_args");
        expect(piped.message).toBe("git sessions refresh their recorded arguments");
      }),
    );
  });

  it("refreshes stdin sessions only from a new --stdin patch", async () => {
    const withoutPipe = await failure(
      Sessions.use((s) => s.refresh(request("refresh", [], otherRoot))),
    );
    expect(withoutPipe._tag).toBe("bad_args");
    expect(withoutPipe.message).toBe("stdin sessions must be refreshed with --stdin");
    const notAPatch = await failure(
      Sessions.use((s) => s.refresh(request("refresh", ["--stdin"], otherRoot, "text\n"))),
    );
    expect(notAPatch._tag).toBe("bad_args");
    const refreshed = await run(
      Sessions.use((s) => s.refresh(request("refresh", ["--stdin"], otherRoot, patch))),
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
        const stale = yield* Effect.flip(sessions.status(request("status", [], otherRoot)));
        expect(stale._tag).toBe("no_session");
        expect((yield* sessions.status(request("status"))).session.id).toBe("fresh");
      }),
    );
  });
});

describe("Sessions.tuiAction", () => {
  const frame = (revision: number) => ({ sessionId: "persisted", revision });
  const act = (action: HumanAction | undefined, args: string[] = []) =>
    Sessions.use((s) =>
      s.tuiAction({ command: "tui.action", cwd: otherRoot, args, ...(action ? { action } : {}) }),
    );

  it("moves and folds the cursor on seq only, persisting each step", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const moved = yield* act({ type: "cursor.move", itemId: "g1" });
        expect(moved.cursor).toEqual({ itemId: "g1", expanded: false });
        expect(moved).toMatchObject({ revision: 3, seq: 2 });
        expect(files.get("persisted")?.cursor).toEqual({ itemId: "g1", expanded: false });
        const expanded = yield* act({ type: "expand.toggle" });
        expect(expanded.cursor).toEqual({ itemId: "g1", expanded: true });
        expect(expanded).toMatchObject({ revision: 3, seq: 3 });
        yield* act({ type: "cursor.move", itemId: "h3" });
        const onHunk = yield* Effect.flip(act({ type: "expand.toggle" }));
        expect(onHunk._tag).toBe("validation_failed");
        expect(onHunk.message).toBe("TUI action does not apply to the current session");
        // The fixture's queue is not finalized, so verdicts wait for the pre-pass.
        const early = yield* Effect.flip(
          act({ type: "verdict.toggle", itemId: "g1", ...frame(3) }),
        );
        expect(early).toMatchObject({
          _tag: "validation_failed",
          message: "review queue is not set",
        });
        expect((yield* sessions.status(request("status", [], otherRoot))).seq).toBe(4);
      }),
    );
  });

  it("toggles verdicts on the revision and undoes them in accept order", async () => {
    files.set(persisted.id, { ...persisted, queueSet: true });
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const undone = yield* act({ type: "verdict.undo", ...frame(3) });
        expect(undone.groups[0]).toMatchObject({ id: "g1", accepted: false });
        expect(undone.cursor).toEqual({ itemId: "g1", expanded: false });
        expect(undone).toMatchObject({ revision: 4, seq: 2 });
        const undoneAgain = yield* act({ type: "verdict.undo", ...frame(4) });
        expect(undoneAgain.spotlight[0]).toMatchObject({ id: "h2", accepted: false });
        expect(undoneAgain.cursor.itemId).toBe("h2");
        const exhausted = yield* Effect.flip(act({ type: "verdict.undo", ...frame(5) }));
        expect(exhausted._tag).toBe("validation_failed");
        const accepted = yield* act({ type: "verdict.toggle", itemId: "g1", ...frame(5) }, [
          "--session",
          "persisted",
        ]);
        expect(accepted.groups[0]?.accepted).toBe(true);
        expect(accepted).toMatchObject({ revision: 6, seq: 4 });
        expect(files.get("persisted")).toMatchObject({ revision: 6, acceptHistory: ["g1"] });
        const inbox = yield* Effect.flip(
          act({ type: "verdict.toggle", itemId: "h3", ...frame(6) }),
        );
        expect(inbox._tag).toBe("validation_failed");
        const missing = yield* Effect.flip(act(undefined));
        expect(missing._tag).toBe("validation_failed");
        expect(missing.message).toBe("invalid TUI action");
        const bogus = yield* Effect.flip(
          act({ type: "verdict.undo", ...frame(6) }, ["--hunk", "h1"]),
        );
        expect(bogus._tag).toBe("bad_args");
        expect((yield* sessions.status(request("status", [], otherRoot))).revision).toBe(6);
      }),
    );
  });

  it("rejects a verdict on a frame the human did not see", async () => {
    files.set(persisted.id, { ...persisted, queueSet: true });
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        for (const seen of [
          { sessionId: "persisted", revision: 2 },
          { sessionId: "replaced", revision: 3 },
        ]) {
          const stale = yield* Effect.flip(act({ type: "verdict.toggle", itemId: "g1", ...seen }));
          expect(stale).toMatchObject({
            _tag: "stale_revision",
            detail: { sessionId: "persisted", revision: 3, seen },
          });
        }
        const staleUndo = yield* Effect.flip(
          act({ type: "verdict.undo", sessionId: "persisted", revision: 2 }),
        );
        expect(staleUndo._tag).toBe("stale_revision");
        const status = yield* sessions.status(request("status", [], otherRoot));
        expect(status).toMatchObject({ revision: 3, seq: 1 });
        expect(status.groups[0]?.accepted).toBe(true);
      }),
    );
  });
});

describe("Sessions.close", () => {
  it("removes the session and signals idle once the last one is gone", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const created = yield* sessions.create(request("create", ["--"]));
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        const closed = yield* sessions.close(request("close"));
        expect(closed).toEqual({ closed: true, sessionId: created.session.id });
        expect(files.has(created.session.id)).toBe(false);
        expect(yield* sessions.isEmpty).toBe(false);
        yield* Effect.flip(Effect.timeout(sessions.idle, "10 millis"));
        yield* sessions.close(request("close", [], otherRoot));
        expect(yield* sessions.isEmpty).toBe(true);
        yield* sessions.idle;
        expect(files.size).toBe(0);
      }),
    );
  });
});
