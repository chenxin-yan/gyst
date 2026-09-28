import {
  applyBatch,
  ApplyEnvelopeSchema,
  BadArgs,
  type DeletePayload,
  type DiffPayload,
  type ListPayload,
  NoSession,
  type OpenPayload,
  parseSnapshot,
  refreshSession,
  type Request,
  type Scope,
  type Session,
  StaleRevision,
  type SourceCheckPayload,
  type StatusPayload,
  statusOf,
  summaryOf,
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
import { createHash } from "node:crypto";
import { Git } from "./git.ts";
import { type DeleteReceipt, SessionStore } from "./store.ts";

const snapshotIdOf = (patch: string) => createHash("sha256").update(patch).digest("hex");
type SourceCheck = Omit<SourceCheckPayload, "sessionId" | "revision">;
type Input<C extends Request["command"]> = Extract<Request, { readonly command: C }>;

const sameScope = (a: Scope, b: Scope) =>
  a.kind === "range" ? b.kind === "range" && a.range === b.range : a.kind === b.kind;

const opened = (session: Session, created: boolean): OpenPayload => ({
  session: summaryOf(session),
  created,
  launch: { argv: ["gyst", "--session", session.id] },
});

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ApplyEnvelopeSchema), {
  onExcessProperty: "error",
});

export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Returns the saved session for this repository and recorded scope as it is, else captures and
     * persists a new one. Opens are serialized, so concurrent opens of one scope return one session.
     */
    open(request: Input<"open">): Effect.Effect<OpenPayload, BadArgs | NoSession>;
    readonly list: Effect.Effect<ListPayload>;
    status(request: Input<"status">): Effect.Effect<StatusPayload, NoSession>;
    check(request: Input<"check">): Effect.Effect<SourceCheckPayload, NoSession>;
    diff(
      request: Input<"diff">,
    ): Effect.Effect<DiffPayload, BadArgs | NoSession | ValidationFailed>;
    /** One schema-validated `request.batch`: all ops or none, replays answered by receipt. */
    apply(
      request: Input<"apply">,
    ): Effect.Effect<StatusPayload, NoSession | StaleRevision | ValidationFailed>;
    /** Re-captures the recorded scope; unchanged hunks keep their group and verdict. */
    refresh(
      request: Input<"refresh">,
    ): Effect.Effect<StatusPayload, BadArgs | NoSession | ValidationFailed>;
    /**
     * Removes one saved session. A retry with the same `requestId` and session returns the recorded
     * result, even after a restart; the same `requestId` for another session fails.
     */
    delete(
      request: Input<"delete">,
    ): Effect.Effect<DeletePayload, BadArgs | NoSession | ValidationFailed>;
    /**
     * Replaces the in-memory sessions with the persisted ones. The daemon calls it once it owns
     * the socket: a contender that loaded earlier would otherwise serve a map a rival has since
     * changed on disk.
     */
    readonly load: Effect.Effect<void, PlatformError.PlatformError>;
    /** Resolves once a delete has removed the last session; a later open arms it again. */
    readonly idle: Effect.Effect<void>;
    /** Waits for in-flight mutations, so an open racing the idle check is counted. */
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
      const deleteReceipts = new Map<string, DeleteReceipt>();
      const sourceChecks = new Map<string, Effect.Effect<SourceCheck>>();
      // Server handlers run concurrently; one permit keeps state changes from interleaving.
      const lock = yield* Semaphore.make(1);
      const idle = yield* Latch.make(false);

      const selected = Effect.fn("Sessions.selected")(function* (request: {
        readonly session: string;
      }) {
        const session = sessions.get(request.session);
        if (!session)
          return yield* new NoSession({ message: `no session with id ${request.session}` });
        return session;
      });

      const open = Effect.fn("Sessions.open")(function* (request: Input<"open">) {
        if (!("cwd" in request)) return opened(yield* selected(request), false);
        const root = yield* git.repoRoot(request.cwd);
        const saved = [...sessions.values()].find(
          (session) => session.repoRoot === root && sameScope(session.scope, request.scope),
        );
        if (saved) return opened(saved, false);
        const patch = yield* git.capture(root, request.scope);
        const hunks = yield* Effect.fromResult(parseSnapshot(patch));
        const now = DateTime.formatIso(yield* DateTime.now);
        // Like persistence, an id source that cannot produce randomness is an operational defect.
        const id = yield* Effect.orDie(randomUUIDv4);
        const session: Session = {
          id,
          repoRoot: root,
          scope: request.scope,
          snapshotId: snapshotIdOf(patch),
          createdAt: now,
          updatedAt: now,
          revision: 0,
          seq: 0,
          cursor: { itemId: null, pane: "queue" },
          hunks,
          groups: [],
          queue: [],
          queueSet: false,
          acceptHistory: [],
          receiptNoteTexts: [],
          applyReceipts: [],
        };
        yield* store.save(session).pipe(Effect.orDie);
        sessions.set(session.id, session);
        yield* idle.close;
        return opened(session, true);
      }, Semaphore.withPermit(lock));

      const list = Effect.sync(() => ({
        sessions: [...sessions.values()]
          .map(summaryOf)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      })).pipe(Semaphore.withPermit(lock), Effect.withSpan("Sessions.list"));

      const status = Effect.fn("Sessions.status")(function* (request: Input<"status">) {
        return statusOf(yield* selected(request));
      }, Semaphore.withPermit(lock));

      const check = Effect.fn("Sessions.check")(function* (request: Input<"check">) {
        const target = yield* Effect.gen(function* () {
          const session = yield* selected(request);
          let cached = sourceChecks.get(session.id);
          if (!cached) {
            const { scope, repoRoot, snapshotId } = session;
            cached = yield* Effect.cachedWithTTL(
              Effect.gen(function* () {
                const result = yield* git.capture(repoRoot, scope).pipe(
                  Effect.timeout("2 seconds"),
                  Effect.map((patch) => ({
                    state:
                      snapshotIdOf(patch) === snapshotId
                        ? ("unchanged" as const)
                        : ("changed" as const),
                  })),
                  Effect.catch((error) =>
                    Effect.succeed({ state: "unavailable" as const, message: error.message }),
                  ),
                );
                return { ...result, checkedAt: DateTime.formatIso(yield* DateTime.now) };
              }),
              "5 seconds",
            );
            sourceChecks.set(session.id, cached);
          }
          return { session, cached };
        }).pipe(Semaphore.withPermit(lock));
        // Slow Git reads share a cached computation, outside the review-state lock.
        // ponytail: replay the full scoped patch; use cheaper fingerprints if large-scope checks become costly.
        return {
          sessionId: target.session.id,
          revision: target.session.revision,
          ...(yield* target.cached),
        };
      });

      const diff = Effect.fn("Sessions.diff")(function* (request: Input<"diff">) {
        const session = yield* selected(request);
        const selectors = [request.hunk, request.group, request.file].filter(Boolean);
        if (selectors.length > 1)
          return yield* new BadArgs({ message: "choose only one diff selector" });
        let hunks = [...session.hunks];
        if (request.hunk) hunks = hunks.filter((hunk) => hunk.id === request.hunk);
        if (request.group) {
          const group = session.groups.find((candidate) => candidate.id === request.group);
          if (!group)
            return yield* new ValidationFailed({
              message: "group selector does not exist",
              detail: { groupId: request.group },
            });
          const byId = new Map(hunks.map((hunk) => [hunk.id, hunk]));
          hunks = group.hunkIds.flatMap((id) => byId.get(id) ?? []);
        }
        if (request.file) hunks = hunks.filter((hunk) => hunk.file === request.file);
        if (selectors.length && hunks.length === 0)
          return yield* new ValidationFailed({ message: "diff selector matched nothing" });
        return {
          sessionId: session.id,
          revision: session.revision,
          hunks,
        } satisfies DiffPayload;
      }, Semaphore.withPermit(lock));

      const load = Effect.gen(function* () {
        const receipts = yield* store.loadDeleteReceipts;
        const persisted = yield* store.loadAll;
        sessions.clear();
        deleteReceipts.clear();
        sourceChecks.clear();
        for (const receipt of receipts) deleteReceipts.set(receipt.requestId, receipt);
        const deleted = new Set(receipts.map(({ sessionId }) => sessionId));
        for (const session of persisted) {
          // A receipt is the commit point: finish a removal that failed or was cut off after it.
          if (deleted.has(session.id)) yield* store.remove(session.id).pipe(Effect.ignore);
          else sessions.set(session.id, session);
        }
      }).pipe(Semaphore.withPermit(lock), Effect.withSpan("Sessions.load"));

      const apply = Effect.fn("Sessions.apply")(function* (request: Input<"apply">) {
        const session = yield* selected(request);
        const envelope = yield* decodeEnvelope(request.batch).pipe(
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

      const refresh = Effect.fn("Sessions.refresh")(function* (request: Input<"refresh">) {
        const session = yield* selected(request);
        const patch = yield* git.capture(session.repoRoot, session.scope);
        const refreshed = refreshSession(
          { ...session, snapshotId: snapshotIdOf(patch) },
          yield* Effect.fromResult(parseSnapshot(patch)),
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* store.save(refreshed).pipe(Effect.orDie);
        sessions.set(session.id, refreshed);
        sourceChecks.delete(session.id);
        return statusOf(refreshed);
      }, Semaphore.withPermit(lock));

      const remove = Effect.fn("Sessions.delete")(function* (request: Input<"delete">) {
        const { requestId } = request;
        if (!requestId) return yield* new BadArgs({ message: "delete needs a request id" });
        // Receipts answer first: after the deletion the session's absence is not a new request.
        const receipt = deleteReceipts.get(requestId);
        if (receipt) {
          if (receipt.sessionId !== request.session)
            return yield* new ValidationFailed({
              message: "request id reused with a different payload",
              detail: { requestId, sessionId: receipt.sessionId },
            });
          return { deleted: true, sessionId: receipt.sessionId } satisfies DeletePayload;
        }
        const session = yield* selected(request);
        const committed = { requestId, sessionId: session.id };
        // The durable receipt commits the deletion before memory changes; a failed write leaves the
        // session and every receipt as they were.
        yield* Effect.uninterruptible(
          store.saveDeleteReceipts([...deleteReceipts.values(), committed]).pipe(
            Effect.orDie,
            Effect.andThen(
              Effect.sync(() => {
                deleteReceipts.set(requestId, committed);
                sessions.delete(session.id);
                sourceChecks.delete(session.id);
              }),
            ),
          ),
        );
        // Only cleanup remains: the next load removes a file this could not.
        yield* store.remove(session.id).pipe(Effect.ignore);
        if (sessions.size === 0) yield* idle.open;
        return { deleted: true, sessionId: session.id } satisfies DeletePayload;
      }, Semaphore.withPermit(lock));

      return Sessions.of({
        open,
        list,
        status,
        check,
        diff,
        apply,
        refresh,
        delete: remove,
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
