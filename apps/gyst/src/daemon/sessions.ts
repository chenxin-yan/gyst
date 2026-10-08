import {
  applyBatch,
  ApplyEnvelopeSchema,
  BadArgs,
  type BrowserRequest,
  type CapturedIndex,
  type CapturedSide,
  capturedSideKey,
  capturedTargetsOf,
  type CaptureProgress,
  type CodePayload,
  type DeletePayload,
  type FilesPayload,
  GitHubUnavailableReasonSchema,
  InternalError,
  type DiffPayload,
  type ListPayload,
  NoSession,
  type OpenPayload,
  pageBytes,
  type PullRequest,
  type PullRequestContext,
  pullRequestStatusOf,
  pinnedSnapshotIds,
  recordedRefresh,
  refresh as refreshOnto,
  type RefreshPayload,
  type Request,
  setViewed,
  type Scope,
  type Session,
  type SessionVersion,
  type SnapshotLines,
  type SnapshotManifest,
  snapshotIdOf,
  type SourceUnavailable,
  StaleRevision,
  type SourceCheckPayload,
  type StackPayload,
  type StatusPayload,
  type SubscribeRequest,
  type SubscriptionEvent,
  statusOf,
  summaryOf,
  ValidationFailed,
  type ViewedPayload,
} from "@gyst/core";
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Latch,
  Layer,
  type PlatformError,
  Queue,
  Schema,
  type Scope as EffectScope,
  Semaphore,
  Stream,
} from "effect";
import { createHash } from "node:crypto";
import { CapturedContent, codePage } from "./content.ts";
import { Git } from "./git.ts";
import { GitHub, type StackDiscovery } from "./github.ts";
import { type DeleteReceipt, SessionStore } from "./store.ts";
type SourceCheck = Omit<SourceCheckPayload, "sessionId" | "snapshotId" | "revision">;
type Operation = Request | BrowserRequest;
type Input<C extends Operation["command"]> = Extract<Operation, { readonly command: C }>;
/** An open's reply before the daemon adds its viewer link, which only the daemon's port names. */
export type Opened = Omit<OpenPayload, "link">;
type OnProgress = (progress: CaptureProgress) => Effect.Effect<void>;
/** What a subscriber hears after its `ready` version: one committed change of its session. */
export type SessionChange = Extract<SubscriptionEvent, { readonly kind: "changed" | "deleted" }>;

/**
 * A session's version among `sessions`. A PR session's `context` covers what its status reports
 * apart from its own review state, which its revision already versions.
 */
const versionOf = (session: Session, sessions: Iterable<Session>): SessionVersion => {
  const status = pullRequestStatusOf(session, sessions);
  const version = {
    sessionId: session.id,
    snapshotId: session.snapshotId,
    revision: session.revision,
  };
  if (!status) return version;
  const others = status.sessions.filter(({ sessionId }) => sessionId !== session.id);
  const context = createHash("sha256")
    .update(JSON.stringify({ ...status, sessions: others }))
    .digest("hex");
  return { ...version, context };
};

const sameScope = (a: Scope, b: Scope) =>
  a.kind === "range"
    ? b.kind === "range" && a.range === b.range
    : a.kind === "pr"
      ? b.kind === "pr" && a.repository === b.repository && a.number === b.number
      : a.kind === b.kind;
/** A PR is one session whichever checkout opens it; local scopes belong to their repository. */
const identifies = (session: Session, root: string, scope: Scope) =>
  sameScope(session.scope, scope) && (scope.kind === "pr" || session.repoRoot === root);

const contextOf = (
  pullRequest: PullRequest,
  discovery: StackDiscovery,
  at: string,
): PullRequestContext => ({
  pullRequest,
  stack: discovery.ok ? { verifiedAt: at, ...discovery.membership } : null,
  unavailable: discovery.ok ? null : { at, reason: discovery.reason },
});

const isGitHubReason = Schema.is(GitHubUnavailableReasonSchema);

const opened = (session: Session, created: boolean): Opened => ({
  session: summaryOf(session),
  created,
});

/**
 * An equal manifest proves an unchanged source only where every side is identified. Commits
 * identify both sides of a range and the old side of uncommitted work, but a working-tree side
 * that was not captured (binary, undecodable, a link or a submodule) could have changed unseen.
 */
const uncaptured = (manifest: SnapshotManifest) => {
  if (manifest.scope.kind !== "uncommitted") return undefined;
  const sides = manifest.files.flatMap(({ path, new: side }) =>
    side.kind === "unavailable" ? [{ path, reason: side.reason }] : [],
  );
  if (sides.length === 0) return undefined;
  const reasons = [...new Set(sides.map(({ reason }) => reason))].sort().join(", ");
  return {
    state: "unavailable" as const,
    message: `the working tree has ${reasons} inputs that gyst does not capture, so it cannot tell whether they changed (first: ${sides[0]!.path})`,
  };
};

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ApplyEnvelopeSchema), {
  onExcessProperty: "error",
});

export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Returns the saved session for this repository and recorded scope (for a PR, its repository
     * and number alone) as it is, else captures and persists a new one, with a PR's attempted stack
     * discovery. Opens are serialized, so concurrent opens of one scope return one session.
     */
    open(
      request: Input<"open">,
      onProgress?: OnProgress,
    ): Effect.Effect<Opened, BadArgs | NoSession | SourceUnavailable | InternalError>;
    readonly list: Effect.Effect<ListPayload>;
    /** A PR session's status also carries its stack context and its opened layers' sessions. */
    status(request: Input<"status">): Effect.Effect<StatusPayload, NoSession>;
    check(request: Input<"check">): Effect.Effect<SourceCheckPayload, NoSession>;
    /**
     * Rechecks a PR session's native stack metadata. Success replaces the PR and stack metadata
     * and clears `unavailable`; a failure records `unavailable` and keeps the last verified stack.
     * The snapshot, revision, review state, receipts and `updatedAt` never change, and no session
     * is created or removed; subscribers hear the new context at the same revision.
     */
    stack(request: Input<"stack">): Effect.Effect<StackPayload, BadArgs | NoSession>;
    /**
     * Opens one layer of the PR session's known stack from that session's checkout, or returns its
     * saved session as it is. A number outside the known stack is `validation_failed`.
     */
    layer(
      request: Input<"layer">,
      onProgress?: OnProgress,
    ): Effect.Effect<
      Opened,
      BadArgs | NoSession | SourceUnavailable | ValidationFailed | InternalError
    >;
    diff(
      request: Input<"diff">,
    ): Effect.Effect<DiffPayload, BadArgs | NoSession | ValidationFailed>;
    /**
     * Reads name the session's current snapshot, or an earlier one its guidance still pins
     * (`pinnedSnapshotIds`): any other id is `stale_revision` carrying the current one. Everything
     * is read from captured content, never a checkout, and a read that has selected its snapshot
     * finishes against it even if a refresh replaces it meanwhile.
     */
    files(
      request: Input<"files">,
    ): Effect.Effect<FilesPayload, NoSession | StaleRevision | ValidationFailed | InternalError>;
    code(
      request: Input<"code">,
    ): Effect.Effect<
      CodePayload,
      BadArgs | NoSession | StaleRevision | ValidationFailed | InternalError
    >;
    /**
     * The named current snapshot and its manifest, selected once: nothing after this reads the
     * session again. Another snapshot id is `stale_revision` carrying the current one.
     */
    snapshot(request: { readonly session: string; readonly snapshotId: string }): Effect.Effect<
      {
        readonly sessionId: string;
        readonly snapshotId: string;
        readonly manifest: SnapshotManifest;
      },
      NoSession | StaleRevision | InternalError
    >;
    /** One schema-validated `request.batch`: all ops or none, replays answered by receipt. */
    apply(
      request: Input<"apply">,
    ): Effect.Effect<StatusPayload, NoSession | StaleRevision | ValidationFailed | InternalError>;
    /**
     * Marks exactly `request.hunkIds` Viewed or not, all or none, against the observed snapshot and
     * revision. The receipt is saved with the effect, so a retry with the same `requestId` returns
     * the recorded result even after a restart; the same `requestId` with another payload fails.
     */
    viewed(
      request: Input<"viewed">,
    ): Effect.Effect<ViewedPayload, BadArgs | NoSession | StaleRevision | ValidationFailed>;
    /**
     * Re-captures the recorded scope outside the review-state lock, then, under it, checks the
     * observed snapshot is still current and commits the new snapshot, the reconciled review state
     * (`refresh` in core) and the receipt in one save. An identical capture changes nothing but the
     * receipt; a failed capture changes nothing. A retry with the same `requestId` returns the
     * recorded result, even after a restart; the same `requestId` with another payload fails.
     */
    refresh(
      request: Input<"refresh">,
      onProgress?: OnProgress,
    ): Effect.Effect<
      RefreshPayload,
      BadArgs | NoSession | SourceUnavailable | StaleRevision | ValidationFailed | InternalError
    >;
    /**
     * Removes one saved session. A retry with the same `requestId` and session returns the recorded
     * result, even after a restart; the same `requestId` for another session fails.
     */
    delete(
      request: Input<"delete">,
    ): Effect.Effect<DeletePayload, BadArgs | NoSession | ValidationFailed>;
    /**
     * Registers for one session's committed changes and returns its version at registration, both
     * under the state lock, so no commit falls between them. Each subscriber keeps only its newest
     * undelivered change; `deleted` is the last. Closing the scope unregisters.
     */
    subscribe(
      request: SubscribeRequest,
    ): Effect.Effect<
      { readonly version: SessionVersion; readonly events: Queue.Dequeue<SessionChange> },
      NoSession,
      EffectScope.Scope
    >;
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
      const github = yield* GitHub;
      const content = yield* CapturedContent;
      const store = yield* SessionStore;
      const { randomUUIDv4 } = yield* Crypto.Crypto;
      const sessions = new Map<string, Session>();
      const deleteReceipts = new Map<string, DeleteReceipt>();
      const sourceChecks = new Map<string, Effect.Effect<SourceCheck>>();
      // Server handlers run concurrently; one permit keeps state changes from interleaving.
      const lock = yield* Semaphore.make(1);
      const idle = yield* Latch.make(false);
      const subscribers = new Map<string, Set<Queue.Queue<SessionChange>>>();
      // Called synchronously right after memory changes, so a subscriber never hears of a state
      // that is not saved, nor misses one that is.
      const announce = (sessionId: string, change: SessionChange) => {
        for (const events of subscribers.get(sessionId) ?? []) Queue.offerUnsafe(events, change);
      };
      const announceChanged = (session: Session) =>
        announce(session.id, { kind: "changed", ...versionOf(session, sessions.values()) });
      // A PR session's status counts its stack's layer sessions, so a layer opened, read, refreshed
      // or deleted changes the context of its repository's other PR sessions too. One whose context
      // did not change hears its version again, which a subscriber already shows.
      const announceLayers = (changed: Session) => {
        if (changed.scope.kind !== "pr") return;
        const { repository } = changed.scope;
        for (const sessionId of subscribers.keys()) {
          const other = sessions.get(sessionId);
          if (
            other?.scope.kind === "pr" &&
            other.scope.repository === repository &&
            other.id !== changed.id
          )
            announceChanged(other);
        }
      };

      // The manifest and every blob it names are committed before any session points at it.
      const publish = (manifest: SnapshotManifest) =>
        content.putManifest(manifest).pipe(
          Effect.mapError((error) =>
            error._tag === "internal_error"
              ? error
              : new InternalError({
                  message: "could not publish the captured snapshot",
                  detail: error.message,
                }),
          ),
        );

      const selected = Effect.fn("Sessions.selected")(function* (request: {
        readonly session: string;
      }) {
        const session = sessions.get(request.session);
        if (!session)
          return yield* new NoSession({ message: `no session with id ${request.session}` });
        return session;
      });

      // Capture and content staging run outside `lock`, so other sessions stay readable and
      // writable meanwhile; `sourceLock` keeps captures one at a time, which also dedups opens.
      // Only the final publication takes `lock`, against the session as it is by then.
      const sourceLock = yield* Semaphore.make(1);
      const underLock = Semaphore.withPermit(lock);

      /** The recorded scope's manifest; a PR's range comes from what GitHub reports now. */
      const acquire = Effect.fn("Sessions.acquire")(function* (
        root: string,
        scope: Scope,
        onProgress?: OnProgress,
      ) {
        if (scope.kind !== "pr")
          return { manifest: yield* git.capture(root, scope, onProgress), pullRequest: undefined };
        const { pullRequest, headRefOid } = yield* github.pullRequest(scope);
        const manifest = yield* git.capturePullRequest(
          root,
          scope,
          { baseRefName: pullRequest.baseRefName, headRefOid },
          onProgress,
        );
        return { manifest, pullRequest };
      });

      /** Reuses the saved session as it is, with no capture or GitHub call; run under `sourceLock`. */
      const openScope = Effect.fn("Sessions.openScope")(function* (
        root: string,
        scope: Scope,
        onProgress?: OnProgress,
      ) {
        const saved = () =>
          [...sessions.values()].find((session) => identifies(session, root, scope));
        const reused = yield* underLock(Effect.sync(saved));
        if (reused) return opened(reused, false);
        const { manifest, pullRequest } = yield* acquire(root, scope, onProgress);
        // Discovery never blocks the PR's own review: a failure is recorded, not raised.
        const context =
          scope.kind === "pr" && pullRequest
            ? contextOf(
                pullRequest,
                yield* github.stack(scope),
                DateTime.formatIso(yield* DateTime.now),
              )
            : undefined;
        const snapshotId = yield* publish(manifest);
        return yield* underLock(
          Effect.gen(function* () {
            // A `load` during the capture may have brought this scope's session in.
            const loaded = saved();
            if (loaded) return opened(loaded, false);
            const now = DateTime.formatIso(yield* DateTime.now);
            // Like persistence, an id source that cannot produce randomness is an operational defect.
            const id = yield* Effect.orDie(randomUUIDv4);
            const session: Session = {
              id,
              repoRoot: root,
              scope,
              snapshotId,
              createdAt: now,
              updatedAt: now,
              revision: 0,
              hunks: manifest.hunks,
              overview: null,
              groups: [],
              viewedHunkIds: [],
              receiptTexts: [],
              applyReceipts: [],
              viewedReceipts: [],
              refreshReceipts: [],
              ...(context && { pullRequest: context }),
            };
            yield* store.save(session).pipe(Effect.orDie);
            sessions.set(session.id, session);
            announceLayers(session);
            yield* idle.close;
            return opened(session, true);
          }),
        );
      });

      const open = Effect.fn("Sessions.open")(function* (
        request: Input<"open">,
        onProgress?: OnProgress,
      ) {
        if (!("cwd" in request)) return opened(yield* underLock(selected(request)), false);
        return yield* openScope(yield* git.repoRoot(request.cwd), request.scope, onProgress);
      }, Semaphore.withPermit(sourceLock));

      const list = Effect.sync(() => ({
        sessions: [...sessions.values()]
          .map(summaryOf)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      })).pipe(Semaphore.withPermit(lock), Effect.withSpan("Sessions.list"));

      const status = Effect.fn("Sessions.status")(function* (request: Input<"status">) {
        const session = yield* selected(request);
        const pullRequest = pullRequestStatusOf(session, sessions.values());
        return { ...statusOf(session), ...(pullRequest && { pullRequest }) };
      }, Semaphore.withPermit(lock));

      // GitHub reads run outside `lock`; `stackLock` keeps one recheck at a time.
      const stackLock = yield* Semaphore.make(1);
      const stack = Effect.fn("Sessions.stack")(function* (request: Input<"stack">) {
        const { scope } = yield* underLock(selected(request));
        if (scope.kind !== "pr")
          return yield* new BadArgs({
            message: "only a GitHub PR session has a native stack to recheck",
          });
        const read = yield* github.pullRequest(scope).pipe(
          Effect.map(({ pullRequest }) => ({ ok: true as const, pullRequest })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              reason: isGitHubReason(error.detail.reason) ? error.detail.reason : "github_failed",
            }),
          ),
        );
        const discovery: StackDiscovery = read.ok ? yield* github.stack(scope) : read;
        const at = DateTime.formatIso(yield* DateTime.now);
        return yield* underLock(
          Effect.gen(function* () {
            // Merge into the session as it is now; a deletion meanwhile wins.
            const session = yield* selected(request);
            const context = session.pullRequest!;
            const rechecked: Session = {
              ...session,
              pullRequest: {
                pullRequest: read.ok ? read.pullRequest : context.pullRequest,
                stack: discovery.ok ? { verifiedAt: at, ...discovery.membership } : context.stack,
                unavailable: discovery.ok ? null : { at, reason: discovery.reason },
              },
            };
            yield* store.save(rechecked).pipe(Effect.orDie);
            sessions.set(session.id, rechecked);
            // Metadata only: the revision stays, and the announced context tells open viewers.
            announceChanged(rechecked);
            return {
              sessionId: session.id,
              pullRequest: pullRequestStatusOf(rechecked, sessions.values())!,
            } satisfies StackPayload;
          }),
        );
      }, Semaphore.withPermit(stackLock));

      const layer = Effect.fn("Sessions.layer")(function* (
        request: Input<"layer">,
        onProgress?: OnProgress,
      ) {
        const { repoRoot, scope, pullRequest: context } = yield* underLock(selected(request));
        if (scope.kind !== "pr")
          return yield* new BadArgs({ message: "only a GitHub PR session has stack layers" });
        const known =
          context?.stack?.membership === "stacked" &&
          context.stack.layers.some((entry) => entry.pullRequest.number === request.number);
        if (!known)
          return yield* new ValidationFailed({
            message: `#${request.number} is not a layer of this session's known stack; recheck the stack first`,
            detail: { number: request.number },
          });
        return yield* openScope(
          repoRoot,
          { kind: "pr", repository: scope.repository, number: request.number },
          onProgress,
        );
      }, Semaphore.withPermit(sourceLock));

      const check = Effect.fn("Sessions.check")(function* (request: Input<"check">) {
        const target = yield* Effect.gen(function* () {
          const session = yield* selected(request);
          let cached = sourceChecks.get(session.id);
          if (!cached) {
            const { scope, repoRoot, snapshotId } = session;
            cached = yield* Effect.cachedWithTTL(
              Effect.gen(function* () {
                const result = yield* acquire(repoRoot, scope).pipe(
                  Effect.timeout("2 seconds"),
                  // Every captured input counts, so a changed helper is a changed source.
                  Effect.map(({ manifest }) =>
                    snapshotIdOf(manifest) !== snapshotId
                      ? { state: "changed" as const }
                      : (uncaptured(manifest) ?? { state: "unchanged" as const }),
                  ),
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
        // ponytail: re-captures every input (committing new blobs, publishing no manifest) within the
        // two-second bound; cheaper fingerprints if large scopes then report unavailable.
        return {
          sessionId: target.session.id,
          snapshotId: target.session.snapshotId,
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
          snapshotId: session.snapshotId,
          revision: session.revision,
          hunks,
        } satisfies DiffPayload;
      }, Semaphore.withPermit(lock));

      // Manifests are immutable, so the last one read serves every page of a browsing session.
      // ponytail: one entry; key more if several sessions are read at once and reloads show up.
      let lastManifest: { readonly id: string; readonly manifest: SnapshotManifest } | undefined;
      const manifestOf = Effect.fn("Sessions.manifestOf")(function* (snapshotId: string) {
        if (lastManifest?.id === snapshotId) return lastManifest.manifest;
        const manifest = yield* content.loadManifest(snapshotId).pipe(
          Effect.mapError((error) =>
            error._tag === "internal_error"
              ? error
              : new InternalError({
                  message: "the session's captured snapshot is unreadable",
                  detail: error.message,
                }),
          ),
        );
        lastManifest = { id: snapshotId, manifest };
        return manifest;
      });
      const blobOf = (blob: string, size: number) =>
        content.readBlob(blob, { offset: 0, length: size }).pipe(
          Stream.mapError(
            (error) =>
              new InternalError({
                message: "the snapshot's captured content is unreadable",
                detail: error.message,
              }),
          ),
        );
      /** The named current snapshot, selected once: nothing after this reads the session again. */
      const snapshot = Effect.fn("Sessions.snapshot")(function* (request: {
        readonly session: string;
        readonly snapshotId: string;
      }) {
        const session = yield* underLock(selected(request));
        if (session.snapshotId !== request.snapshotId)
          return yield* new StaleRevision({
            message: `snapshot ${request.snapshotId} is not the current snapshot of session ${session.id}; read the session again`,
            detail: { snapshotId: session.snapshotId },
          });
        const manifest = yield* manifestOf(session.snapshotId);
        return { sessionId: session.id, snapshotId: session.snapshotId, manifest };
      });

      /** Like `snapshot`, but also an earlier snapshot the session's guidance still pins. */
      const pinned = Effect.fn("Sessions.pinned")(function* (request: {
        readonly session: string;
        readonly snapshotId: string;
      }) {
        const session = yield* underLock(selected(request));
        if (!pinnedSnapshotIds(session).includes(request.snapshotId))
          return yield* new StaleRevision({
            message: `snapshot ${request.snapshotId} is neither the current snapshot of session ${session.id} nor one its guidance pins; read the session again`,
            detail: { snapshotId: session.snapshotId },
          });
        const manifest = yield* manifestOf(request.snapshotId);
        return { sessionId: session.id, snapshotId: request.snapshotId, manifest };
      });

      const files = Effect.fn("Sessions.files")(function* (request: Input<"files">) {
        const { sessionId, snapshotId, manifest } = yield* pinned(request);
        let first = 0;
        if (request.after !== undefined) {
          const index = manifest.files.findIndex(({ path }) => path === request.after);
          if (index === -1)
            return yield* new ValidationFailed({
              message: "the files cursor names no file in this snapshot",
              detail: { after: request.after },
            });
          first = index + 1;
        }
        const page = [];
        let bytes = 0;
        for (let index = first; index < manifest.files.length; index++) {
          const file = manifest.files[index]!;
          bytes += Buffer.byteLength(JSON.stringify(file));
          if (page.length > 0 && bytes > pageBytes) break;
          page.push(file);
        }
        const last = first + page.length;
        return {
          sessionId,
          snapshotId,
          total: manifest.files.length,
          files: page,
          next: last < manifest.files.length ? page.at(-1)!.path : null,
        } satisfies FilesPayload;
      });

      const code = Effect.fn("Sessions.code")(function* (request: Input<"code">) {
        const { sessionId, snapshotId, manifest } = yield* pinned(request);
        // Membership is the manifest's, so unchanged supporting files are readable too.
        const file = manifest.files.find(({ path }) => path === request.file);
        if (!file)
          return yield* new ValidationFailed({
            message: "file is not in this snapshot",
            detail: { file: request.file },
          });
        const side = file[request.side];
        const identity = { sessionId, snapshotId, file: file.path, side: request.side };
        if (side.kind !== "text") return { ...identity, content: side } satisfies CodePayload;
        const page = yield* codePage(blobOf(side.blob, side.size), side.size, request);
        return {
          ...identity,
          content: { kind: "text", size: side.size, ...page },
        } satisfies CodePayload;
      });

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

      /** The line counts of the named sides of a snapshot, counted like `code` pages count them. */
      const capturedIndexOf = Effect.fn("Sessions.capturedIndexOf")(function* (
        snapshotId: string,
        targets: ReturnType<typeof capturedTargetsOf>,
      ) {
        const sides = new Map<string, CapturedSide>();
        if (targets.length === 0) return { snapshotId, sides } satisfies CapturedIndex;
        const manifest = yield* manifestOf(snapshotId);
        for (const { path, side: name } of targets) {
          const side = manifest.files.find((file) => file.path === path)?.[name];
          if (side?.kind !== "text") {
            sides.set(capturedSideKey(name, path), side ?? { kind: "missing" });
            continue;
          }
          const { lfs, last } = yield* Stream.runFold(
            blobOf(side.blob, side.size),
            () => ({ lfs: 0, last: undefined as number | undefined }),
            (state, chunk) => ({
              lfs: chunk.reduce((count, byte) => (byte === 10 ? count + 1 : count), state.lfs),
              last: chunk.at(-1) ?? state.last,
            }),
          );
          // A final LF ends the last line rather than starting another.
          const lines = lfs + (last !== undefined && last !== 10 ? 1 : 0);
          sides.set(capturedSideKey(name, path), { kind: "text", lines });
        }
        return { snapshotId, sides } satisfies CapturedIndex;
      });

      const apply = Effect.fn("Sessions.apply")(function* (request: Input<"apply">) {
        const before = yield* underLock(selected(request));
        const envelope = yield* decodeEnvelope(request.batch).pipe(
          Effect.mapError(
            (error) =>
              new ValidationFailed({
                message: "invalid apply envelope",
                detail: [{ opIndex: -1, message: error.message }],
              }),
          ),
        );
        // Content is read outside the review-state lock. A replay or a stale batch needs none, and
        // `applyBatch` rejects an index of a snapshot the session has since left.
        const captured =
          before.snapshotId !== envelope.snapshotId ||
          before.applyReceipts.some(({ key }) => key === envelope.idempotencyKey)
            ? ({ snapshotId: before.snapshotId, sides: new Map() } satisfies CapturedIndex)
            : yield* capturedIndexOf(before.snapshotId, capturedTargetsOf(envelope, before));
        return yield* underLock(
          Effect.gen(function* () {
            const session = yield* selected(request);
            const now = DateTime.formatIso(yield* DateTime.now);
            const outcome = yield* Effect.fromResult(applyBatch(session, envelope, captured, now));
            if (outcome.session) {
              yield* store.save(outcome.session).pipe(Effect.orDie);
              sessions.set(session.id, outcome.session);
              announceChanged(outcome.session);
            }
            return outcome.status;
          }),
        );
      });

      const viewed = Effect.fn("Sessions.viewed")(function* (request: Input<"viewed">) {
        const session = yield* selected(request);
        const now = DateTime.formatIso(yield* DateTime.now);
        const outcome = yield* Effect.fromResult(setViewed(session, request, now));
        // Effect and receipt are one file: saved before memory changes, so a failed write leaves both.
        if (outcome.session) {
          yield* store.save(outcome.session).pipe(Effect.orDie);
          sessions.set(session.id, outcome.session);
          announceChanged(outcome.session);
          announceLayers(outcome.session);
        }
        return outcome.result;
      }, Semaphore.withPermit(lock));

      /**
       * The lines of every snapshot `session` pins, read from captured content. A pinned snapshot
       * that cannot be read is left out, so the guidance pinning it cannot be verified.
       */
      const pinnedLinesOf = Effect.fn("Sessions.pinnedLinesOf")(function* (session: Session) {
        const lines = new Map<string, SnapshotLines>();
        for (const snapshotId of pinnedSnapshotIds(session)) {
          const manifest = yield* content.loadManifest(snapshotId).pipe(Effect.option);
          if (manifest._tag === "Some") lines.set(snapshotId, manifest.value);
        }
        return lines;
      });

      const refresh = Effect.fn("Sessions.refresh")(function* (
        request: Input<"refresh">,
        onProgress?: OnProgress,
      ) {
        const observed = yield* underLock(selected(request));
        // A recorded or stale request captures nothing.
        const recorded = yield* Effect.fromResult(recordedRefresh(observed, request));
        if (recorded) return recorded;
        // A PR re-reads only its range; its stack context changes on an explicit recheck alone.
        const { manifest } = yield* acquire(observed.repoRoot, observed.scope, onProgress);
        const snapshotId =
          snapshotIdOf(manifest) === observed.snapshotId
            ? observed.snapshotId
            : yield* publish(manifest);
        const retained = yield* pinnedLinesOf(observed);
        return yield* underLock(
          Effect.gen(function* () {
            // The session as it is now: work saved during the capture is reconciled too, and a
            // deletion during it wins (the published manifest stays, unreferenced, until #93).
            const session = yield* selected(request);
            const outcome = yield* Effect.fromResult(
              refreshOnto(
                session,
                request,
                { snapshotId, snapshot: manifest },
                retained,
                DateTime.formatIso(yield* DateTime.now),
              ),
            );
            if (outcome.session) {
              // Effect and receipt are one file: saved before memory changes.
              yield* store.save(outcome.session).pipe(Effect.orDie);
              sessions.set(session.id, outcome.session);
              // This capture is newer than any cached check, replaced snapshot or not.
              sourceChecks.delete(session.id);
              if (outcome.result.replaced) {
                announceChanged(outcome.session);
                announceLayers(outcome.session);
              }
            }
            return outcome.result;
          }),
        );
      }, Semaphore.withPermit(sourceLock));

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
          // A daemon started only to answer this retry has nothing left to serve.
          if (sessions.size === 0) yield* idle.open;
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
                announce(session.id, { kind: "deleted", sessionId: session.id });
                subscribers.delete(session.id);
                announceLayers(session);
              }),
            ),
          ),
        );
        // Only cleanup remains: the next load removes a file this could not.
        yield* store.remove(session.id).pipe(Effect.ignore);
        if (sessions.size === 0) yield* idle.open;
        return { deleted: true, sessionId: session.id } satisfies DeletePayload;
      }, Semaphore.withPermit(lock));

      const subscribe = Effect.fn("Sessions.subscribe")(function* (request: SubscribeRequest) {
        return yield* Effect.acquireRelease(
          underLock(
            Effect.gen(function* () {
              const session = yield* selected(request);
              const events = yield* Queue.sliding<SessionChange>(1);
              let registered = subscribers.get(session.id);
              if (!registered) subscribers.set(session.id, (registered = new Set()));
              registered.add(events);
              return { version: versionOf(session, sessions.values()), events };
            }),
          ),
          ({ version, events }) =>
            Effect.suspend(() => {
              const registered = subscribers.get(version.sessionId);
              registered?.delete(events);
              if (registered?.size === 0) subscribers.delete(version.sessionId);
              return Queue.shutdown(events);
            }),
        );
      });

      return Sessions.of({
        open,
        list,
        status,
        check,
        stack,
        layer,
        diff,
        files,
        code,
        snapshot,
        apply,
        viewed,
        refresh,
        delete: remove,
        subscribe,
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
