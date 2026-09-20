import {
  applyBatch,
  ApplyEnvelopeSchema,
  BadArgs,
  type ClosePayload,
  type DiffPayload,
  NoSession,
  parseSnapshot,
  refreshSession,
  type Request,
  type Session,
  SessionExists,
  type StaleRevision,
  type StatusPayload,
  statusOf,
  ValidationFailed,
} from "@gyst/core";
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Latch,
  Layer,
  type PlatformError,
  Schema,
  Semaphore,
} from "effect";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Git } from "./git.ts";
import { SessionStore } from "./store.ts";

const requestArgs = <T extends ParseArgsConfig>(config: T) =>
  Effect.try({
    try: () => parseArgs(config),
    catch: (error) =>
      new BadArgs({ message: error instanceof Error ? error.message : String(error) }),
  });

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ApplyEnvelopeSchema));

// Options each session command accepts; anything else is `bad_args`.
const sessionOptions = { session: { type: "string" } } as const;
const selectorOptions = {
  ...sessionOptions,
  hunk: { type: "string" },
  group: { type: "string" },
  file: { type: "string" },
} as const;
const stdinOptions = { ...sessionOptions, stdin: { type: "boolean" } } as const;

export class Sessions extends Context.Service<
  Sessions,
  {
    create(request: Request): Effect.Effect<StatusPayload, BadArgs | SessionExists>;
    status(request: Request): Effect.Effect<StatusPayload, BadArgs | NoSession>;
    diff(request: Request): Effect.Effect<DiffPayload, BadArgs | NoSession | ValidationFailed>;
    /** One schema-validated batch from `request.stdin`: all ops or none, replays answered by receipt. */
    apply(
      request: Request,
    ): Effect.Effect<StatusPayload, BadArgs | NoSession | StaleRevision | ValidationFailed>;
    /** Re-reads the recorded source (or `--stdin`); unchanged hunks keep their group and verdict. */
    refresh(request: Request): Effect.Effect<StatusPayload, BadArgs | NoSession>;
    close(request: Request): Effect.Effect<ClosePayload, BadArgs | NoSession>;
    /**
     * Replaces the in-memory sessions with the persisted ones. The daemon calls it once it owns
     * the socket: a contender that loaded earlier would otherwise serve a map a rival has since
     * changed on disk.
     */
    readonly load: Effect.Effect<void, PlatformError.PlatformError>;
    /** Resolves once a close has removed the last session; a later create arms it again. */
    readonly idle: Effect.Effect<void>;
    /** Waits for in-flight mutations, so a create racing the idle check is counted. */
    readonly isEmpty: Effect.Effect<boolean>;
  }
>()("gyst/daemon/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const git = yield* Git;
      const store = yield* SessionStore;
      const { randomUUIDv4 } = yield* Crypto.Crypto;
      const sessions = new Map<string, Session>();
      // Server handlers run concurrently; one permit keeps state changes from interleaving.
      const lock = yield* Semaphore.make(1);
      const idle = yield* Latch.make(false);

      // A plain generic (not `Effect.fn`) so `values` keeps the keys of the command's own table;
      // parseArgs's result type stays deferred inside, hence the local `session` view.
      const selected = <O extends typeof sessionOptions>(
        cwd: string,
        args: ReadonlyArray<string>,
        options: O,
      ) =>
        Effect.gen(function* () {
          const { values } = yield* requestArgs({ args, options, strict: true });
          const { session: id } = values as { session?: string };
          if (id) {
            const session = sessions.get(id);
            if (!session) return yield* new NoSession({ message: `no session with id ${id}` });
            return { values, session };
          }
          const root = yield* git.repoRoot(cwd);
          const session = [...sessions.values()].find((candidate) => candidate.repoRoot === root);
          if (!session)
            return yield* new NoSession({ message: `no session for repository ${root}` });
          return { values, session };
        }).pipe(Effect.withSpan("Sessions.selected"));

      const create = Effect.fn("Sessions.create")(function* (request: Request) {
        const root = yield* git.repoRoot(request.cwd);
        const { values, positionals } = yield* requestArgs({
          args: request.args,
          options: { stdin: { type: "boolean" } },
          allowPositionals: true,
          strict: true,
        });
        if ([...sessions.values()].some((session) => session.repoRoot === root))
          return yield* new SessionExists({ message: `a session already exists for ${root}` });
        if (values.stdin && positionals.length)
          return yield* new BadArgs({ message: "--stdin cannot be combined with git arguments" });
        // Only revisions and pathspecs are replayable; git options change the output format.
        const option = positionals.find((arg) => arg.startsWith("-") && arg !== "--");
        if (option)
          return yield* new BadArgs({ message: `git options are not accepted: ${option}` });
        const includeUntracked = !values.stdin && positionals.length === 0;
        const patch = values.stdin
          ? (request.stdin ?? "")
          : yield* git.patch(root, request.cwd, positionals, includeUntracked);
        const hunks = yield* Effect.fromResult(parseSnapshot(patch));
        const now = DateTime.formatIso(yield* DateTime.now);
        // Like persistence, an id source that cannot produce randomness is an operational defect.
        const session: Session = {
          id: yield* Effect.orDie(randomUUIDv4),
          repoRoot: root,
          source: values.stdin
            ? { kind: "stdin" }
            : {
                kind: "git",
                args: positionals.length ? positionals : ["HEAD"],
                cwd: request.cwd,
                ...(includeUntracked ? { includeUntracked } : {}),
              },
          createdAt: now,
          updatedAt: now,
          revision: 0,
          seq: 0,
          cursor: { itemId: null, expanded: false },
          hunks,
          groups: [],
          queue: [],
          queueSet: false,
          applyReceipts: [],
        };
        yield* store.save(session).pipe(Effect.orDie);
        sessions.set(session.id, session);
        yield* idle.close;
        return statusOf(session);
      }, Semaphore.withPermit(lock));

      const status = Effect.fn("Sessions.status")(function* (request: Request) {
        const { session } = yield* selected(request.cwd, request.args, sessionOptions);
        return statusOf(session);
      }, Semaphore.withPermit(lock));

      const diff = Effect.fn("Sessions.diff")(function* (request: Request) {
        const { values, session } = yield* selected(request.cwd, request.args, selectorOptions);
        const selectors = [values.hunk, values.group, values.file].filter(Boolean);
        if (selectors.length > 1)
          return yield* new BadArgs({ message: "choose only one diff selector" });
        let hunks = [...session.hunks];
        if (values.hunk) hunks = hunks.filter((hunk) => hunk.id === values.hunk);
        if (values.group) {
          const group = session.groups.find((candidate) => candidate.id === values.group);
          if (!group)
            return yield* new ValidationFailed({
              message: "group selector does not exist",
              detail: { groupId: values.group },
            });
          hunks = hunks.filter((hunk) => group.hunkIds.includes(hunk.id));
        }
        if (values.file) hunks = hunks.filter((hunk) => hunk.file === values.file);
        if (selectors.length && hunks.length === 0)
          return yield* new ValidationFailed({ message: "diff selector matched nothing" });
        return { sessionId: session.id, revision: session.revision, hunks } satisfies DiffPayload;
      }, Semaphore.withPermit(lock));

      const load = Effect.gen(function* () {
        const persisted = yield* store.loadAll;
        sessions.clear();
        for (const session of persisted) sessions.set(session.id, session);
      }).pipe(Semaphore.withPermit(lock), Effect.withSpan("Sessions.load"));

      const apply = Effect.fn("Sessions.apply")(function* (request: Request) {
        const { session } = yield* selected(request.cwd, request.args, sessionOptions);
        const envelope = yield* decodeEnvelope(request.stdin ?? "").pipe(
          Effect.mapError(
            (error) =>
              new ValidationFailed({
                message: "invalid apply envelope",
                detail: [{ opIndex: -1, message: error.message }],
              }),
          ),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        const outcome = yield* Effect.fromResult(applyBatch(session, envelope, now));
        if (outcome.session) {
          yield* store.save(outcome.session).pipe(Effect.orDie);
          sessions.set(session.id, outcome.session);
        }
        return outcome.status;
      }, Semaphore.withPermit(lock));

      const refresh = Effect.fn("Sessions.refresh")(function* (request: Request) {
        const { values, session } = yield* selected(request.cwd, request.args, stdinOptions);
        let patch: string;
        if (session.source.kind === "stdin") {
          if (!values.stdin)
            return yield* new BadArgs({ message: "stdin sessions must be refreshed with --stdin" });
          patch = request.stdin ?? "";
        } else {
          if (values.stdin)
            return yield* new BadArgs({ message: "git sessions refresh their recorded arguments" });
          const bare = session.source.includeUntracked ?? false;
          // A bare scope re-resolves HEAD (or the empty tree) rather than replaying the recorded args.
          patch = yield* git.patch(
            session.repoRoot,
            session.source.cwd,
            bare ? [] : session.source.args,
            bare,
          );
        }
        const refreshed = refreshSession(
          session,
          yield* Effect.fromResult(parseSnapshot(patch)),
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* store.save(refreshed).pipe(Effect.orDie);
        sessions.set(session.id, refreshed);
        return statusOf(refreshed);
      }, Semaphore.withPermit(lock));

      const close = Effect.fn("Sessions.close")(function* (request: Request) {
        const { session } = yield* selected(request.cwd, request.args, sessionOptions);
        yield* store.remove(session.id).pipe(Effect.orDie);
        sessions.delete(session.id);
        if (sessions.size === 0) yield* idle.open;
        return { closed: true, sessionId: session.id } satisfies ClosePayload;
      }, Semaphore.withPermit(lock));

      return Sessions.of({
        create,
        status,
        diff,
        apply,
        refresh,
        close,
        load,
        idle: idle.await,
        isEmpty: Semaphore.withPermit(
          lock,
          Effect.sync(() => sessions.size === 0),
        ),
      });
    }),
  );
}
