import {
  type AddonDiscovery,
  addonStateOf,
  BadArgs,
  type IdentifiersPayload,
  InternalError,
  type ManifestFile,
  type NavigationGap,
  type NavigationLocation,
  type NavigationResultPayload,
  type NavigationSideState,
  type NavigationStatusPayload,
  type NavigationUnavailable,
  type NoSession,
  type Request,
  type SnapshotManifest,
  type TextPoint,
  type TextRange,
  ValidationFailed,
} from "@gyst/core";
import {
  Cause,
  Context,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handshakeAddon } from "./addon-handshake.ts";
import { CapturedContent } from "./content.ts";
import {
  type Engine,
  type EngineFailure,
  fromLspPosition,
  type LspPosition,
  lspLanguageId,
  startEngine,
  toLspPosition,
} from "./lsp.ts";
import { materializeSide } from "./navigation-inputs.ts";
import { Paths } from "./paths.ts";
import { daemonVersion } from "./protocol.ts";
import { Sessions } from "./sessions.ts";

type Input<C extends Request["command"]> = Extract<Request, { readonly command: C }>;
type Target = Input<"definition" | "references" | "identifiers">;
type Available = Extract<AddonDiscovery, { readonly kind: "available" }>;
type Side = "old" | "new";
type NavigationSymbol = { readonly text: string; readonly range: TextRange };

/** Navigation cannot answer this request; the reason becomes the reply's `unavailable` outcome. */
class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly reason: NavigationUnavailable;
}> {}
/** The analysis was retired or shut down before or while it served this request. */
class Stopped extends Data.TaggedError("Stopped") {}

const unavailable = (reason: NavigationUnavailable) => ({ kind: "unavailable", reason }) as const;
const engineProblem = (message: string) => new Unavailable({ reason: { kind: "engine", message } });

/**
 * How many engines may exist across the daemon (from materialization to teardown), how long one may
 * sit with no active query before it stops, and how long one query may wait for its engine and
 * answer before that engine is stopped.
 */
export interface NavigationPolicy {
  readonly engines: number;
  readonly idle: Duration.Input;
  readonly query: Duration.Input;
}
export const navigationPolicy = {
  engines: 2,
  idle: "60 seconds",
  query: "2 minutes",
} as const satisfies NavigationPolicy;
/** The policy `Navigation.layer` runs under: `navigationPolicy` unless a test provides another. */
export const NavigationPolicy = Context.Reference<NavigationPolicy>(
  "gyst/daemon/NavigationPolicy",
  {
    defaultValue: () => navigationPolicy,
  },
);

/** The add-on discovery a query can run, or why navigation cannot use it. */
const usableAddon = (
  addon: AddonDiscovery,
): Available | Extract<NavigationUnavailable, { kind: "addon" }> =>
  addon.kind === "available" && addon.version === daemonVersion
    ? addon
    : {
        kind: "addon",
        addon: addonStateOf(
          addon.kind === "available" ? { kind: "mismatched", found: addon.version } : addon,
          daemonVersion,
        ),
      };
const analysisKey = (sessionId: string, snapshotId: string, side: Side, addon: Available) =>
  JSON.stringify([sessionId, snapshotId, side, addon.entry, addon.version]);

/** An ECMAScript identifier-shaped word, `#private` names included. */
const identifierPattern =
  /(?<![\p{ID_Continue}$\u200C\u200D])[\p{ID_Start}$_#][\p{ID_Continue}$\u200C\u200D]*/gu;

/**
 * Words that are keywords in module code except as a property or method name (`map.delete`,
 * `{ default: 1 }`). The engine still resolves some keywords (`return` to its function, `this` to
 * its class), so one of these is a name only where the engine classifies it as one. Contextual
 * keywords (`as`, `from`, `type`, `async`, ...) can be any name and are left to the engine.
 */
const reservedWords = new Set(
  (
    "await break case catch class const continue debugger default delete do else enum export " +
    "extends false finally for function if implements import in instanceof interface let new " +
    "null package private protected public return static super switch this throw true try " +
    "typeof var void while with yield"
  ).split(" "),
);

/** The engine's codes for an import, reference or type package it could not find. */
const unresolvedCodes = new Set([2307, 2688, 2792, 6053, 7016]);

const LspRangeSchema = Schema.Struct({
  start: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
  end: Schema.Struct({ line: Schema.Number, character: Schema.Number }),
});
const LocationSchema = Schema.Struct({ uri: Schema.String, range: LspRangeSchema });
const LocationLinkSchema = Schema.Struct({
  targetUri: Schema.String,
  targetSelectionRange: LspRangeSchema,
});
const decodeLocations = Schema.decodeUnknownOption(
  Schema.NullOr(
    Schema.Union([
      LocationSchema,
      Schema.Array(Schema.Union([LocationSchema, LocationLinkSchema])),
    ]),
  ),
);
const decodeHighlights = Schema.decodeUnknownOption(
  Schema.NullOr(Schema.Array(Schema.Struct({ range: LspRangeSchema }))),
);
const decodeTokens = Schema.decodeUnknownOption(
  Schema.NullOr(Schema.Struct({ data: Schema.Array(Schema.Number) })),
);
const decodeDiagnostics = Schema.decodeUnknownOption(
  Schema.Struct({
    items: Schema.optional(
      Schema.Array(
        Schema.Struct({
          code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
          range: LspRangeSchema,
        }),
      ),
    ),
  }),
);

/** Every location a definition or references result names, as engine URIs and ranges. */
const locationsOf = (result: unknown) => {
  const decoded = decodeLocations(result);
  if (decoded._tag === "None" || decoded.value === null) return [];
  const all = Array.isArray(decoded.value) ? decoded.value : [decoded.value];
  return all.map((location) =>
    "targetUri" in location
      ? { uri: location.targetUri, range: location.targetSelectionRange }
      : location,
  );
};

const sameLspPosition = (a: LspPosition, b: LspPosition | undefined) =>
  b !== undefined && a.line === b.line && a.character === b.character;

/** The gyst lines of a captured text: LF-delimited, a final LF ending the last line. */
const linesOf = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const candidatesOn = (lines: ReadonlyArray<string>, line: number): Array<NavigationSymbol> =>
  [...(lines[line - 1] ?? "").matchAll(identifierPattern)].map(({ 0: word, index }) => ({
    text: word,
    range: {
      start: { line, character: index },
      end: { line, character: index + word.length },
    },
  }));

/** The identifier the point is in or just after, which is what a reader points at. */
const symbolAt = (text: string, point: TextPoint) =>
  candidatesOn(linesOf(text), point.line).find(
    ({ range }) =>
      range.start.character <= point.character && point.character <= range.end.character,
  );

/**
 * Whether a candidate is a name rather than a keyword: any word but a reserved one, which is a name
 * only where one of the engine's semantic tokens spans exactly it.
 */
const isName = (engine: Engine, uri: string, text: string, candidate: NavigationSymbol) => {
  if (!reservedWords.has(candidate.text)) return Effect.succeed(true);
  const start = toLspPosition(text, candidate.range.start)!;
  const end = toLspPosition(text, candidate.range.end)!;
  return engine
    .request("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start, end },
    })
    .pipe(
      Effect.map((result) => {
        const decoded = decodeTokens(result);
        if (decoded._tag === "None" || decoded.value === null) return false;
        const { data } = decoded.value;
        // Five numbers per token: its line and start relative to the previous token's, its length.
        for (let index = 0, line = 0, character = 0; index + 4 < data.length; index += 5) {
          character = data[index] === 0 ? character + data[index + 1]! : data[index + 1]!;
          line += data[index]!;
          if (
            line === start.line &&
            character === start.character &&
            data[index + 2] === end.character - start.character
          )
            return true;
        }
        return false;
      }),
    );
};

/** A quoted module specifier after `from`, `import`, `import(` or `require(`. */
const specifierPattern = /\b(?:from|import|require)\s*\(?\s*((["'])[^"'\\\n]+\2)/g;

export class Navigation extends Context.Service<
  Navigation,
  {
    /**
     * Native definitions of the symbol at `position` on one side of the session's current
     * snapshot, read from an engine over that side's captured files only. Only locations in that
     * side's captured text are named; every other result is counted in `outside`.
     */
    definition(
      request: Input<"definition">,
    ): Effect.Effect<
      NavigationResultPayload,
      BadArgs | NoSession | ValidationFailed | InternalError
    >;
    /** Native references to the symbol at `position`, declarations included; see `definition`. */
    references(
      request: Input<"references">,
    ): Effect.Effect<
      NavigationResultPayload,
      BadArgs | NoSession | ValidationFailed | InternalError
    >;
    /**
     * The identifiers on one line the engine resolves to a definition, declaration parameters and
     * import aliases included: what a reader can query from that line.
     */
    identifiers(
      request: Input<"identifiers">,
    ): Effect.Effect<IdentifiersPayload, BadArgs | NoSession | ValidationFailed | InternalError>;
    /**
     * Stops the session's analysis of every snapshot but `keep` (all of it once the session is
     * deleted) and keeps any preparation still racing for them from starting an engine. Resolves
     * once their engines are stopped and their materializations removed.
     */
    retire(sessionId: string, keep?: string): Effect.Effect<void>;
    /**
     * The add-on and each side's tracked analysis for the session's current snapshot, as a query
     * with `addon` would find them. Never starts, waits for or materializes anything; a snapshot
     * that is not current is historical on both sides.
     */
    status(
      request: Input<"navigation">,
    ): Effect.Effect<NavigationStatusPayload, NoSession | InternalError>;
  }
>()("gyst/daemon/Navigation") {
  /**
   * Engines start only on a navigation request, one per session, snapshot, side and add-on, each
   * over its own disposable copy of that side's captured files under `dataDir/navigation/`. At most
   * `policy.engines` exist across the daemon: a query needing another stops the least recently used
   * engine with no active query, or waits (queued) while every engine is busy. Closing the layer
   * stops every engine and removes its copy.
   */
  static readonly layer = Layer.effect(
    Navigation,
    Effect.gen(function* () {
      const policy = yield* NavigationPolicy;
      const sessions = yield* Sessions;
      const content = yield* CapturedContent;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = path.join((yield* Paths).dataDir, "navigation");
      const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(CapturedContent, content),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      // Only the daemon that owns the socket serves requests, so leftovers of a crashed daemon are
      // removed on first use rather than when this layer is built: a contender that loses the
      // socket must not remove the live daemon's materializations.
      const ready = yield* Effect.cached(
        fs.remove(root, { recursive: true, force: true }).pipe(
          Effect.andThen(fs.makeDirectory(root, { recursive: true, mode: 0o700 })),
          Effect.mapError(() => engineProblem("the navigation directory could not be prepared")),
        ),
      );

      interface Prepared {
        readonly engine: Engine;
        readonly project: string;
        readonly gaps: ReadonlyArray<NavigationGap>;
        readonly files: number;
        readonly bytes: number;
      }
      interface Analysis {
        readonly key: string;
        readonly sessionId: string;
        readonly snapshotId: string;
        readonly scope: Scope.Closeable;
        readonly prepared: Deferred.Deferred<Prepared, Unavailable | Stopped>;
        readonly opened: Set<string>;
        readonly openLock: Semaphore.Semaphore;
        state: Extract<NavigationSideState, { kind: "preparing" | "ready" }>;
        /** Queries holding this analysis, from acquiring it to answering. */
        active: number;
        /** When it was last acquired or released, for least-recently-used eviction. */
        used: number;
        /** Holds its engine slot until its teardown finishes. */
        holdsSlot: boolean;
        fiber?: Fiber.Fiber<void>;
        idleTimer: Fiber.Fiber<void> | undefined;
      }
      const analyses = new Map<string, Analysis>();
      /** Per retired session, the one snapshot still allowed to start analysis (none once deleted). */
      const allowed = new Map<string, string | undefined>();
      /** Analyses from their creation until their teardown has finished: running engines. */
      let slots = 0;
      /** Queries waiting for an engine slot, per key. */
      const queued = new Map<string, number>();
      /** The last failure per key, reported until the next query for that key retries it. */
      const failures = new Map<
        string,
        {
          readonly sessionId: string;
          readonly snapshotId: string;
          readonly reason: NavigationUnavailable;
        }
      >();
      let uses = 0;
      /**
       * Completed (then replaced) whenever a waiting query should look again: a slot freed, an
       * analysis went idle, or a retirement or shutdown stopped what it waits for.
       */
      let changed = Deferred.makeUnsafe<void>();
      const wake = () => {
        Deferred.doneUnsafe(changed, Exit.void);
        changed = Deferred.makeUnsafe();
      };
      let shutDown = false;
      const lock = Semaphore.withPermit(yield* Semaphore.make(1));

      /** Stops the engine and removes the materialization, then frees the engine slot once. */
      const teardown = (analysis: Analysis) =>
        Scope.close(analysis.scope, Exit.void).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!analysis.holdsSlot) return;
              analysis.holdsSlot = false;
              slots--;
              wake();
            }),
          ),
        );
      const close = (analysis: Analysis) =>
        Effect.sync(() => {
          analysis.idleTimer?.interruptUnsafe();
          analysis.idleTimer = undefined;
        }).pipe(
          Effect.andThen(Deferred.fail(analysis.prepared, new Stopped())),
          Effect.andThen(analysis.fiber ? Fiber.interrupt(analysis.fiber) : Effect.void),
          Effect.andThen(teardown(analysis)),
          Effect.uninterruptible,
        );
      const closeAll = (stale: ReadonlyArray<Analysis>) =>
        Effect.forEach(stale, close, { concurrency: "unbounded", discard: true });
      /** Unregisters an analysis, unless it was already retired or replaced. */
      const forget = (analysis: Analysis, failure?: NavigationUnavailable) =>
        lock(
          Effect.sync(() => {
            const current = analyses.get(analysis.key) === analysis;
            if (!current) return false;
            analyses.delete(analysis.key);
            if (failure)
              failures.set(analysis.key, {
                sessionId: analysis.sessionId,
                snapshotId: analysis.snapshotId,
                reason: failure,
              });
            return true;
          }),
        );
      /** Stops an analysis whose engine failed, so the next request starts a fresh one. */
      const discard = (analysis: Analysis, failure: NavigationUnavailable) =>
        forget(analysis, failure).pipe(
          Effect.flatMap((current) => (current ? close(analysis) : Effect.void)),
        );

      const readText = (file: string, blob: string, size: number) =>
        content.readBlob(blob, { offset: 0, length: size }).pipe(
          Stream.runCollect,
          // `toString` keeps a BOM, which the engine counts as a code unit too.
          Effect.map((chunks) => Buffer.concat(chunks).toString("utf8")),
          Effect.mapError(
            () => new InternalError({ message: "captured content is unreadable", detail: file }),
          ),
        );

      /** Why an engine from `addon` failed to start, when the add-on itself is the reason. */
      const addonProblem = (addon: Available) =>
        services(handshakeAddon(addon.entry, daemonVersion)).pipe(
          Effect.map((found) =>
            found.kind === "available" && found.version === addon.version
              ? undefined
              : new Unavailable({
                  reason: { kind: "addon", addon: addonStateOf(found, daemonVersion) },
                }),
          ),
        );

      const prepare = (manifest: SnapshotManifest, side: Side, addon: Available) =>
        Effect.gen(function* () {
          yield* ready;
          const dir = yield* fs.makeTempDirectoryScoped({ directory: root });
          const home = path.join(dir, "home");
          yield* fs.makeDirectory(home, { mode: 0o700 });
          const inputs = yield* services(materializeSide(manifest, side, dir));
          // The engine reports real paths; fencing compares against the same spelling.
          const project = yield* fs.realPath(inputs.project);
          const engine = yield* services(
            startEngine({ entry: addon.entry, version: addon.version, project, home }),
          ).pipe(
            Effect.catchTag("EngineFailure", (failure) =>
              Effect.flatMap(addonProblem(addon), (problem) =>
                Effect.fail(problem ?? engineProblem(failure.message)),
              ),
            ),
          );
          return {
            engine,
            project,
            gaps: inputs.gaps,
            files: inputs.files,
            bytes: inputs.bytes,
          } satisfies Prepared;
        }).pipe(
          Effect.catchTags({
            PlatformError: () =>
              Effect.fail(engineProblem("the captured inputs could not be laid out")),
            bad_args: () => Effect.fail(engineProblem("the captured inputs could not be read")),
            internal_error: () =>
              Effect.fail(engineProblem("the captured inputs could not be read")),
          }),
        );

      /** Counts one more query on an analysis, which cancels its idle expiry. */
      const claim = (analysis: Analysis) => {
        analysis.active++;
        analysis.used = ++uses;
        analysis.idleTimer?.interruptUnsafe();
        analysis.idleTimer = undefined;
        return analysis;
      };

      /**
       * Ends one query on an analysis. The last one starts its idle expiry, which stops it unless a
       * query acquires it first, and lets a queued query evict it.
       */
      const release = (analysis: Analysis) =>
        lock(
          Effect.suspend(() => {
            analysis.active--;
            analysis.used = ++uses;
            if (analysis.active > 0 || analyses.get(analysis.key) !== analysis) return Effect.void;
            wake();
            return Effect.sleep(policy.idle).pipe(
              Effect.andThen(
                lock(
                  Effect.sync(() => {
                    const expired =
                      analyses.get(analysis.key) === analysis && analysis.active === 0;
                    if (expired) {
                      analyses.delete(analysis.key);
                      analysis.idleTimer = undefined;
                    }
                    return expired;
                  }),
                ),
              ),
              Effect.flatMap((expired) => (expired ? close(analysis) : Effect.void)),
              Effect.forkDetach,
              Effect.map((fiber) => {
                analysis.idleTimer = fiber;
              }),
            );
          }),
        );

      /**
       * Prepares an analysis in its own fiber and scope, so closing the analysis cancels it at any
       * point and a slow preparation never holds up anything else.
       */
      const startPreparing = (
        analysis: Analysis,
        manifest: SnapshotManifest,
        side: Side,
        addon: Available,
      ) =>
        prepare(manifest, side, addon).pipe(
          Scope.provide(analysis.scope),
          Effect.catchDefect(() => Effect.fail(engineProblem("navigation could not start"))),
          Effect.onExit((exit) =>
            Deferred.done(
              analysis.prepared,
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                ? Exit.fail(new Stopped())
                : exit,
            ).pipe(
              // A failed preparation is not kept: the next request tries again. Its own fiber is
              // ending, so only its scope is closed here.
              Effect.andThen(
                Exit.isSuccess(exit)
                  ? Effect.sync(() => {
                      const { files, bytes, gaps } = exit.value;
                      analysis.state = { kind: "ready", files, bytes, gaps };
                    })
                  : forget(
                      analysis,
                      Exit.findErrorOption(exit).pipe(
                        Option.filter((error) => error._tag === "Unavailable"),
                        Option.map(({ reason }) => reason),
                        Option.getOrUndefined,
                      ),
                    ).pipe(Effect.andThen(teardown(analysis))),
              ),
            ),
          ),
          Effect.ignore,
          Effect.forkDetach,
          Effect.map((fiber) => {
            analysis.fiber = fiber;
            return analysis;
          }),
        );

      /**
       * The analysis for this key, claimed for one query, starting its preparation in the background
       * if there is none. At capacity it first stops the least recently used analysis no query
       * holds, or waits (queued) until a slot frees or an analysis goes idle.
       */
      const acquire = (
        request: Target,
        manifest: SnapshotManifest,
        addon: Available,
      ): Effect.Effect<Analysis, Stopped> => {
        const key = analysisKey(request.session, request.snapshotId, request.side, addon);
        let waiting = false;
        const setWaiting = (next: boolean) => {
          if (waiting === next) return;
          waiting = next;
          const count = (queued.get(key) ?? 0) + (next ? 1 : -1);
          if (count === 0) queued.delete(key);
          else queued.set(key, count);
        };
        type Step = { readonly analysis: Analysis } | { readonly retryAfter: Effect.Effect<void> };
        const attempt: Effect.Effect<Analysis, Stopped> = lock(
          Effect.suspend((): Effect.Effect<Step, Stopped> => {
            const existing = analyses.get(key);
            if (existing) {
              setWaiting(false);
              return Effect.succeed({ analysis: claim(existing) });
            }
            const keep = allowed.get(request.session);
            if (shutDown || (allowed.has(request.session) && keep !== request.snapshotId))
              return Effect.fail(new Stopped());
            if (slots < policy.engines) {
              setWaiting(false);
              slots++;
              failures.delete(key);
              const analysis: Analysis = {
                key,
                sessionId: request.session,
                snapshotId: request.snapshotId,
                scope: Scope.makeUnsafe(),
                prepared: Deferred.makeUnsafe(),
                opened: new Set(),
                openLock: Semaphore.makeUnsafe(1),
                state: { kind: "preparing" },
                active: 0,
                used: 0,
                holdsSlot: true,
                idleTimer: undefined,
              };
              analyses.set(key, claim(analysis));
              return Effect.map(
                startPreparing(analysis, manifest, request.side, addon),
                (started) => ({
                  analysis: started,
                }),
              );
            }
            let victim: Analysis | undefined;
            for (const analysis of analyses.values())
              if (analysis.active === 0 && (victim === undefined || analysis.used < victim.used))
                victim = analysis;
            if (victim !== undefined) {
              analyses.delete(victim.key);
              // Closing waits for its preparation fiber, whose exit takes this lock: close outside.
              return Effect.succeed({ retryAfter: close(victim) });
            }
            setWaiting(true);
            return Effect.succeed({ retryAfter: Effect.interruptible(Deferred.await(changed)) });
          }),
        ).pipe(
          Effect.flatMap((step: Step) =>
            "analysis" in step
              ? Effect.succeed(step.analysis)
              : Effect.andThen(step.retryAfter, attempt),
          ),
        );
        return attempt.pipe(Effect.ensuring(Effect.sync(() => setWaiting(false))));
      };

      /** NoSession when deleted, and `historical` once the snapshot is no longer current. */
      const stillCurrent = (request: Target) =>
        sessions.snapshot(request).pipe(
          Effect.asVoid,
          Effect.catchTag("stale_revision", () =>
            Effect.fail(new Unavailable({ reason: { kind: "historical" } })),
          ),
        );

      /** The request's captured source text, or why it cannot be analysed. */
      const select = Effect.fnUntraced(function* (request: Target) {
        const { manifest } = yield* sessions
          .snapshot(request)
          .pipe(
            Effect.catchTag("stale_revision", () =>
              Effect.fail(new Unavailable({ reason: { kind: "historical" } })),
            ),
          );
        const file = manifest.files.find(({ path: member }) => member === request.file);
        if (!file)
          return yield* new ValidationFailed({
            message: "file is not in this snapshot",
            detail: { file: request.file },
          });
        const captured = file[request.side];
        if (captured.kind !== "text")
          return yield* new Unavailable({
            reason: {
              kind: "not-source",
              detail:
                captured.kind === "absent"
                  ? `${request.file} has no ${request.side} side`
                  : `the ${request.side} side of ${request.file} was not captured as text (${captured.reason})`,
            },
          });
        if (lspLanguageId(request.file) === undefined)
          return yield* new Unavailable({
            reason: {
              kind: "not-source",
              detail: `${request.file} is not a TypeScript or JavaScript source`,
            },
          });
        const addon = usableAddon(request.addon);
        if (addon.kind !== "available") return yield* new Unavailable({ reason: addon });
        const text = yield* readText(request.file, captured.blob, captured.size);
        return { manifest, text, addon };
      });

      /**
       * Runs `use` on the ready engine for the request's key, waiting for its preparation and answer
       * at most `policy.query`. Whatever happens, nothing is returned unless the snapshot is still
       * the session's current one once the engine has answered.
       */
      const analysed = <A>(
        request: Target,
        manifest: SnapshotManifest,
        addon: Available,
        use: (
          prepared: Prepared,
          analysis: Analysis,
        ) => Effect.Effect<A, EngineFailure | InternalError>,
      ) =>
        Effect.gen(function* () {
          const stop = (analysis: Analysis, reason: NavigationUnavailable) =>
            discard(analysis, reason).pipe(
              Effect.andThen(Effect.fail(new Unavailable({ reason }))),
            );
          const result = yield* Effect.acquireUseRelease(
            acquire(request, manifest, addon),
            (analysis) =>
              Deferred.await(analysis.prepared).pipe(
                Effect.flatMap((prepared) => use(prepared, analysis)),
                Effect.catchTag("EngineFailure", ({ message }) =>
                  stop(analysis, { kind: "engine", message }),
                ),
                // A stuck engine is stopped rather than left holding its slot.
                Effect.timeoutOrElse({
                  duration: policy.query,
                  orElse: () =>
                    stop(analysis, {
                      kind: "engine",
                      message: "the engine did not answer in time and was stopped",
                    }),
                }),
              ),
            release,
          ).pipe(
            Effect.catchTag("Stopped", () => Effect.fail(engineProblem("navigation was stopped"))),
            Effect.exit,
          );
          yield* stillCurrent(request);
          return yield* result;
        });

      /** Opens a captured file in the engine once, with its exact captured text. */
      const opened = (analysis: Analysis, prepared: Prepared, file: string, text: string) => {
        const uri = pathToFileURL(path.join(prepared.project, ...file.split("/"))).href;
        return Semaphore.withPermit(analysis.openLock)(
          Effect.suspend(() =>
            analysis.opened.has(file)
              ? Effect.void
              : prepared.engine
                  .notify("textDocument/didOpen", {
                    textDocument: { uri, languageId: lspLanguageId(file), version: 1, text },
                  })
                  .pipe(Effect.tap(() => Effect.sync(() => analysis.opened.add(file)))),
          ),
        ).pipe(Effect.as(uri));
      };

      /**
       * Keeps only locations in this side's captured text, with ranges converted through that
       * text. Anything else (the engine's own libraries, host files reached through a relative
       * import, `paths` or an ancestor `node_modules`) is only counted: no path or byte of it is
       * returned.
       */
      const fence = Effect.fnUntraced(function* (
        manifest: SnapshotManifest,
        side: "old" | "new",
        project: string,
        result: unknown,
      ) {
        const members = new Map(manifest.files.map((file) => [file.path, file]));
        const texts = new Map<string, string>();
        const locations: Array<NavigationLocation> = [];
        let outside = 0;
        for (const { uri, range } of locationsOf(result)) {
          let host: string;
          try {
            host = fileURLToPath(uri);
          } catch {
            outside++;
            continue;
          }
          const relative = path.relative(project, host);
          const member: ManifestFile | undefined =
            relative === "" || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)
              ? undefined
              : members.get(relative.split(path.sep).join("/"));
          const captured = member?.[side];
          if (member === undefined || captured?.kind !== "text") {
            outside++;
            continue;
          }
          let text = texts.get(member.path);
          if (text === undefined) {
            text = yield* readText(member.path, captured.blob, captured.size);
            texts.set(member.path, text);
          }
          const start = fromLspPosition(text, range.start);
          const end = fromLspPosition(text, range.end);
          if (start === undefined || end === undefined) {
            outside++;
            continue;
          }
          locations.push({ file: member.path, range: { start, end } });
        }
        return { locations, outside };
      });

      /** Whether an engine location is a file this side captured as text, or a host file. */
      const resolvesTo = (manifest: SnapshotManifest, side: Side, project: string, uri: string) => {
        let host: string;
        try {
          host = fileURLToPath(uri);
        } catch {
          return false;
        }
        const relative = path.relative(project, host);
        if (relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) return true;
        const logical = relative.split(path.sep).join("/");
        return manifest.files.some((file) => file.path === logical && file[side].kind === "text");
      };

      /**
       * Imports in the queried file that are missing: generated, ignored or installed sources. The
       * engine reports them for type-checked files. It reports none in JavaScript without
       * `checkJs`, so there each specifier's definition is asked as well: nothing (a missing
       * package) or a file that was never captured (it names one either way) is missing, while a
       * string that is not a specifier answers null. Messages quote only the captured specifier,
       * never the engine's text, which can name host paths.
       */
      const missingImports = Effect.fnUntraced(function* (
        engine: Engine,
        uri: string,
        request: Target,
        manifest: SnapshotManifest,
        project: string,
        text: string,
      ) {
        const file = request.file;
        const report = decodeDiagnostics(
          yield* engine.request("textDocument/diagnostic", { textDocument: { uri } }),
        );
        const lines = text.split("\n");
        const reported = (report._tag === "None" ? [] : (report.value.items ?? [])).flatMap(
          ({ code, range }) => {
            if (typeof code !== "number" || !unresolvedCodes.has(code)) return [];
            const start = fromLspPosition(text, range.start);
            const end = fromLspPosition(text, range.end);
            const line = start ? (lines[start.line - 1] ?? "") : "";
            const quoted =
              start && end
                ? line.slice(start.character, end.line === start.line ? end.character : undefined)
                : "";
            return [{ quoted, code }];
          },
        );
        const gaps: Array<NavigationGap> = reported.map(({ quoted, code }) => ({
          kind: "unresolved-import",
          file,
          message: `cannot resolve ${quoted.slice(0, 200)} (TS${code})`,
        }));
        if (!lspLanguageId(file)?.startsWith("javascript")) return gaps;
        const known = new Set(reported.map(({ quoted }) => quoted));
        const specifiers = linesOf(text).flatMap((lineText, index) =>
          [...lineText.matchAll(specifierPattern)].flatMap(({ 0: match, 1: quoted, index: at }) =>
            quoted === undefined || known.has(quoted)
              ? []
              : [
                  {
                    quoted,
                    point: { line: index + 1, character: at + match.length - quoted.length + 1 },
                  },
                ],
          ),
        );
        const probed = yield* Effect.forEach(
          specifiers,
          ({ quoted, point }) =>
            engine
              .request("textDocument/definition", {
                textDocument: { uri },
                position: toLspPosition(text, point)!,
              })
              .pipe(
                Effect.map((result): Array<NavigationGap> =>
                  result === null ||
                  locationsOf(result).some((location) =>
                    resolvesTo(manifest, request.side, project, location.uri),
                  )
                    ? []
                    : [
                        {
                          kind: "unresolved-import",
                          file,
                          message: `cannot resolve ${quoted.slice(0, 200)}`,
                        },
                      ],
                ),
              ),
          { concurrency: 8 },
        );
        return [...gaps, ...probed.flat()];
      });

      const located = (query: "definition" | "references") =>
        Effect.fn(`Navigation.${query}`)(function* (request: Input<typeof query>) {
          const outcome: NavigationResultPayload["outcome"] = yield* Effect.gen(function* () {
            const { manifest, text, addon } = yield* select(request);
            const position = toLspPosition(text, request.position);
            if (position === undefined)
              return yield* new BadArgs({
                message: "position is outside the captured file",
                detail: { position: request.position },
              });
            const symbol = symbolAt(text, request.position);
            if (symbol === undefined) return { kind: "no-symbol" } as const;
            return yield* analysed(request, manifest, addon, (prepared, analysis) =>
              Effect.gen(function* () {
                const uri = yield* opened(analysis, prepared, request.file, text);
                if (!(yield* isName(prepared.engine, uri, text, symbol)))
                  return { kind: "no-symbol" } as const;
                const result = yield* prepared.engine.request(`textDocument/${query}`, {
                  textDocument: { uri },
                  position,
                  ...(query === "references" ? { context: { includeDeclaration: true } } : {}),
                });
                const fenced = yield* fence(manifest, request.side, prepared.project, result);
                const gaps = yield* missingImports(
                  prepared.engine,
                  uri,
                  request,
                  manifest,
                  prepared.project,
                  text,
                );
                return {
                  kind: "locations",
                  symbol,
                  ...fenced,
                  gaps: [...prepared.gaps, ...gaps],
                } as const;
              }),
            );
          }).pipe(
            Effect.catchTag("Unavailable", ({ reason }) => Effect.succeed(unavailable(reason))),
          );
          return {
            sessionId: request.session,
            snapshotId: request.snapshotId,
            side: request.side,
            file: request.file,
            query,
            position: request.position,
            outcome,
          } satisfies NavigationResultPayload;
        });

      const identifiers = Effect.fn("Navigation.identifiers")(function* (
        request: Input<"identifiers">,
      ) {
        const outcome: IdentifiersPayload["outcome"] = yield* Effect.gen(function* () {
          const { manifest, text, addon } = yield* select(request);
          const lines = linesOf(text);
          if (request.line > lines.length)
            return yield* new BadArgs({
              message: "line is past the end of the captured file",
              detail: { line: request.line, lines: lines.length },
            });
          const candidates = candidatesOn(lines, request.line);
          return yield* analysed(request, manifest, addon, (prepared, analysis) =>
            Effect.gen(function* () {
              const uri = yield* opened(analysis, prepared, request.file, text);
              // A name resolves to a definition and is one of its own highlighted occurrences; a
              // word inside a module specifier or a contextual keyword the engine maps elsewhere
              // is not.
              const named = yield* Effect.forEach(
                candidates,
                Effect.fnUntraced(function* (candidate) {
                  if (!(yield* isName(prepared.engine, uri, text, candidate))) return false;
                  const { range } = candidate;
                  const start = toLspPosition(text, range.start)!;
                  const end = toLspPosition(text, range.end);
                  const at = { textDocument: { uri }, position: start };
                  const [definitions, highlights] = yield* Effect.all(
                    [
                      prepared.engine.request("textDocument/definition", at),
                      prepared.engine.request("textDocument/documentHighlight", at),
                    ],
                    { concurrency: 2 },
                  );
                  if (locationsOf(definitions).length === 0) return false;
                  const own = decodeHighlights(highlights);
                  return (
                    own._tag === "Some" &&
                    (own.value ?? []).some(
                      (highlight) =>
                        sameLspPosition(highlight.range.start, start) &&
                        sameLspPosition(highlight.range.end, end),
                    )
                  );
                }),
                { concurrency: 8 },
              );
              const gaps = yield* missingImports(
                prepared.engine,
                uri,
                request,
                manifest,
                prepared.project,
                text,
              );
              return {
                kind: "identifiers",
                identifiers: candidates.filter((_, index) => named[index]),
                gaps: [...prepared.gaps, ...gaps],
              } as const;
            }),
          );
        }).pipe(
          Effect.catchTag("Unavailable", ({ reason }) => Effect.succeed(unavailable(reason))),
        );
        return {
          sessionId: request.session,
          snapshotId: request.snapshotId,
          side: request.side,
          file: request.file,
          line: request.line,
          outcome,
        } satisfies IdentifiersPayload;
      });

      const retire = (sessionId: string, keep?: string) =>
        lock(
          Effect.sync(() => {
            allowed.set(sessionId, keep);
            const retired = (owner: { sessionId: string; snapshotId: string }) =>
              owner.sessionId === sessionId && owner.snapshotId !== keep;
            const stale = [...analyses.values()].filter(retired);
            for (const analysis of stale) analyses.delete(analysis.key);
            for (const [key, failure] of failures) if (retired(failure)) failures.delete(key);
            // Queued queries for a retired snapshot stop waiting.
            wake();
            return stale;
          }),
        ).pipe(Effect.flatMap(closeAll), Effect.withSpan("Navigation.retire"));

      const status = Effect.fn("Navigation.status")(function* (request: Input<"navigation">) {
        const current = yield* sessions.snapshot(request).pipe(
          Effect.as(true),
          Effect.catchTag("stale_revision", () => Effect.succeed(false)),
        );
        const addon = usableAddon(request.addon);
        const sideState = (side: Side): NavigationSideState => {
          if (!current) return unavailable({ kind: "historical" });
          if (addon.kind !== "available") return unavailable(addon);
          const key = analysisKey(request.session, request.snapshotId, side, addon);
          const analysis = analyses.get(key);
          if (analysis) return analysis.state;
          if (queued.has(key)) return { kind: "queued" };
          const failure = failures.get(key);
          return failure ? unavailable(failure.reason) : { kind: "stopped" };
        };
        return {
          sessionId: request.session,
          snapshotId: request.snapshotId,
          addon: addon.kind === "available" ? addonStateOf(addon, daemonVersion) : addon.addon,
          sides: { old: sideState("old"), new: sideState("new") },
        } satisfies NavigationStatusPayload;
      });

      /** Resolves once every engine slot is free: no teardown (idle, evicted, failed) is running. */
      const drained: Effect.Effect<void> = Effect.suspend(() =>
        slots === 0 ? Effect.void : Effect.andThen(Deferred.await(changed), drained),
      );
      yield* Effect.addFinalizer(() =>
        lock(
          Effect.sync(() => {
            shutDown = true;
            wake();
            const all = [...analyses.values()];
            analyses.clear();
            return all;
          }),
        ).pipe(Effect.flatMap(closeAll), Effect.andThen(drained)),
      );

      return Navigation.of({
        definition: located("definition"),
        references: located("references"),
        identifiers,
        retire,
        status,
      });
    }),
  );
}
