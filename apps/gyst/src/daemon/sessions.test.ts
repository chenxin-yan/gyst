import { beforeEach, describe, expect, it } from "bun:test";
import { BadArgs, type Request, type Session } from "@gyst/core";
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
      return patch;
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
    { id: "h1", file: "x.txt", header: "@@ -1 +1 @@", patch: "@@ -1 +1 @@\n-a\n+b" },
    {
      id: "h2",
      file: "y.txt",
      header: "@@ -1 +1 @@",
      patch: "@@ -1 +1 @@\n-c\n+d",
      tldr: "read me",
    },
    { id: "h3", file: "y.txt", header: "@@ -5 +5 @@", patch: "@@ -5 +5 @@\n-e\n+f" },
  ],
  groups: [{ id: "g1", tldr: "same edit", exemplarHunkId: "h1", hunkIds: ["h1"] }],
};

beforeEach(() => {
  files = new Map([[persisted.id, persisted]]);
  patchCalls = [];
  saveFails = false;
  nextId = 0;
});

describe("Sessions.create", () => {
  it("creates the bare scope from git with untracked files and persists it", async () => {
    const status = await run(
      Sessions.use((s) => s.create(request("create", ["--"], `${root}/sub`))),
    );
    expect(status.inbox.map((hunk) => hunk.file)).toEqual(["a.txt", "b.txt"]);
    expect(status.session.source).toEqual({ kind: "git", args: ["HEAD"], cwd: `${root}/sub` });
    expect(patchCalls).toEqual([{ root, cwd: `${root}/sub`, args: [], includeUntracked: true }]);
    expect(status.session.id).toBe("01010101-0101-4101-8101-010101010101");
    expect(files.get(status.session.id)?.hunks).toHaveLength(2);
    expect(status.revision).toBe(0);
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
  it("selects by repository or by exact --session id", async () => {
    const byRepo = await run(Sessions.use((s) => s.status(request("status", [], otherRoot))));
    expect(byRepo.session.id).toBe("persisted");
    expect(byRepo.groups[0]?.count).toBe(1);
    expect(byRepo.spotlight).toEqual([
      { id: "h2", file: "y.txt", tldr: "read me", accepted: false },
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
