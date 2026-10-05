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
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
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
type NavigationSymbol = { readonly text: string; readonly range: TextRange };

/** Navigation cannot answer this request; the reason becomes the reply's `unavailable` outcome. */
class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly reason: NavigationUnavailable;
}> {}
/** The analysis was retired or shut down before or while it served this request. */
class Stopped extends Data.TaggedError("Stopped") {}

const unavailable = (reason: NavigationUnavailable) => ({ kind: "unavailable", reason }) as const;
const engineProblem = (message: string) => new Unavailable({ reason: { kind: "engine", message } });

/** An ECMAScript identifier-shaped word, `#private` names included. */
const identifierPattern =
  /(?<![\p{ID_Continue}$\u200C\u200D])[\p{ID_Start}$_#][\p{ID_Continue}$\u200C\u200D]*/gu;

/**
 * Words that are never a name in module code. The engine still resolves some of them (`return` to
 * its function, `this` to its class), so they are not offered or queried as symbols. Contextual
 * keywords (`as`, `from`, `type`, `async`, ...) can be names and are left to the engine.
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
  [...(lines[line - 1] ?? "").matchAll(identifierPattern)]
    .filter(([word]) => !reservedWords.has(word))
    .map(({ 0: word, index }) => ({
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
  }
>()("gyst/daemon/Navigation") {
  /**
   * Engines start only on a navigation request, one per session, snapshot, side and add-on, each
   * over its own disposable copy of that side's captured files under `dataDir/navigation/`.
   * Closing the layer stops every engine and removes its copy.
   */
  static readonly layer = Layer.effect(
    Navigation,
    Effect.gen(function* () {
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
      }
      interface Analysis {
        readonly key: string;
        readonly sessionId: string;
        readonly snapshotId: string;
        readonly scope: Scope.Closeable;
        readonly prepared: Deferred.Deferred<Prepared, Unavailable | Stopped>;
        readonly opened: Set<string>;
        readonly openLock: Semaphore.Semaphore;
        fiber?: Fiber.Fiber<void>;
      }
      const analyses = new Map<string, Analysis>();
      /** Per retired session, the one snapshot still allowed to start analysis (none once deleted). */
      const allowed = new Map<string, string | undefined>();
      let shutDown = false;
      const lock = Semaphore.withPermit(yield* Semaphore.make(1));

      const close = (analysis: Analysis) =>
        Deferred.fail(analysis.prepared, new Stopped()).pipe(
          Effect.andThen(analysis.fiber ? Fiber.interrupt(analysis.fiber) : Effect.void),
          Effect.andThen(Scope.close(analysis.scope, Exit.void)),
          Effect.uninterruptible,
        );
      const closeAll = (stale: ReadonlyArray<Analysis>) =>
        Effect.forEach(stale, close, { concurrency: "unbounded", discard: true });
      /** Unregisters an analysis, unless it was already retired or replaced. */
      const forget = (analysis: Analysis) =>
        lock(
          Effect.sync(() => {
            const current = analyses.get(analysis.key) === analysis;
            if (current) analyses.delete(analysis.key);
            return current;
          }),
        );
      /** Stops an analysis whose engine failed, so the next request starts a fresh one. */
      const discard = (analysis: Analysis) =>
        forget(analysis).pipe(
          Effect.flatMap((current) => (current ? close(analysis) : Effect.void)),
        );

      const readText = (file: string, blob: string, size: number) =>
        content.readBlob(blob, { offset: 0, length: size }).pipe(
          Stream.runFold(
            () => [] as Array<Uint8Array>,
            (chunks, chunk) => {
              chunks.push(chunk);
              return chunks;
            },
          ),
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

      const prepare = (manifest: SnapshotManifest, side: "old" | "new", addon: Available) =>
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
          return { engine, project, gaps: inputs.gaps } satisfies Prepared;
        }).pipe(
          Effect.catchTags({
            PlatformError: () =>
              Effect.fail(engineProblem("the captured inputs could not be laid out")),
            bad_args: () => Effect.fail(engineProblem("the captured inputs could not be read")),
            internal_error: () =>
              Effect.fail(engineProblem("the captured inputs could not be read")),
          }),
        );

      /** The analysis for this key, starting its preparation in the background if there is none. */
      const acquire = (
        request: Target,
        manifest: SnapshotManifest,
        addon: Available,
      ): Effect.Effect<Analysis, Stopped> =>
        lock(
          Effect.suspend(() => {
            const key = JSON.stringify([
              request.session,
              request.snapshotId,
              request.side,
              addon.entry,
              addon.version,
            ]);
            const existing = analyses.get(key);
            if (existing) return Effect.succeed(existing);
            const keep = allowed.get(request.session);
            if (shutDown || (allowed.has(request.session) && keep !== request.snapshotId))
              return Effect.fail(new Stopped());
            const analysis: Analysis = {
              key,
              sessionId: request.session,
              snapshotId: request.snapshotId,
              scope: Scope.makeUnsafe(),
              prepared: Deferred.makeUnsafe(),
              opened: new Set(),
              openLock: Semaphore.makeUnsafe(1),
            };
            analyses.set(key, analysis);
            // Preparation runs in its own fiber and scope, so closing the analysis cancels it at any
            // point and a slow preparation never holds up anything else.
            return prepare(manifest, request.side, addon).pipe(
              Scope.provide(analysis.scope),
              Effect.catchDefect(() => Effect.fail(engineProblem("navigation could not start"))),
              Effect.onExit((exit) =>
                Deferred.done(
                  analysis.prepared,
                  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                    ? Exit.fail(new Stopped())
                    : exit,
                ).pipe(
                  // A failed preparation is not kept: the next request tries again. Its own fiber
                  // is ending, so only its scope is closed here.
                  Effect.andThen(
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : forget(analysis).pipe(
                          Effect.andThen(Scope.close(analysis.scope, Exit.void)),
                        ),
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
          }),
        );

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
        const { addon } = request;
        if (addon.kind !== "available" || addon.version !== daemonVersion)
          return yield* new Unavailable({
            reason: {
              kind: "addon",
              addon: addonStateOf(
                addon.kind === "available" ? { kind: "mismatched", found: addon.version } : addon,
                daemonVersion,
              ),
            },
          });
        const text = yield* readText(request.file, captured.blob, captured.size);
        return { manifest, text, addon };
      });

      /**
       * Runs `use` on the ready engine for the request's key. Whatever happens, nothing is returned
       * unless the snapshot is still the session's current one once the engine has answered.
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
          const result = yield* Effect.gen(function* () {
            const analysis = yield* acquire(request, manifest, addon);
            const prepared = yield* Deferred.await(analysis.prepared);
            return yield* use(prepared, analysis).pipe(
              Effect.catchTag("EngineFailure", (failure) =>
                discard(analysis).pipe(Effect.andThen(Effect.fail(engineProblem(failure.message)))),
              ),
            );
          }).pipe(
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

      /**
       * Imports in the queried file the engine could not resolve: missing generated, ignored or
       * installed sources. The message quotes only the captured specifier, never the engine's text,
       * which can name host paths.
       */
      const unresolvedImports = (engine: Engine, uri: string, file: string, text: string) =>
        engine.request("textDocument/diagnostic", { textDocument: { uri } }).pipe(
          Effect.map((result): Array<NavigationGap> => {
            const report = decodeDiagnostics(result);
            if (report._tag === "None") return [];
            const lines = text.split("\n");
            return (report.value.items ?? []).flatMap(({ code, range }) => {
              if (typeof code !== "number" || !unresolvedCodes.has(code)) return [];
              const start = fromLspPosition(text, range.start);
              const end = fromLspPosition(text, range.end);
              const line = start ? (lines[start.line - 1] ?? "") : "";
              const quoted =
                start && end
                  ? line.slice(start.character, end.line === start.line ? end.character : undefined)
                  : "";
              return [
                {
                  kind: "unresolved-import",
                  file,
                  message: `cannot resolve ${quoted.slice(0, 200)} (TS${code})`,
                },
              ];
            });
          }),
        );

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
                const result = yield* prepared.engine.request(`textDocument/${query}`, {
                  textDocument: { uri },
                  position,
                  ...(query === "references" ? { context: { includeDeclaration: true } } : {}),
                });
                const fenced = yield* fence(manifest, request.side, prepared.project, result);
                const gaps = yield* unresolvedImports(prepared.engine, uri, request.file, text);
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
              // word inside a module specifier or a keyword the engine maps elsewhere is not.
              const named = yield* Effect.forEach(
                candidates,
                Effect.fnUntraced(function* ({ range }) {
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
              const gaps = yield* unresolvedImports(prepared.engine, uri, request.file, text);
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
            const stale = [...analyses.values()].filter(
              (analysis) => analysis.sessionId === sessionId && analysis.snapshotId !== keep,
            );
            for (const analysis of stale) analyses.delete(analysis.key);
            return stale;
          }),
        ).pipe(Effect.flatMap(closeAll), Effect.withSpan("Navigation.retire"));

      yield* Effect.addFinalizer(() =>
        lock(
          Effect.sync(() => {
            shutDown = true;
            const all = [...analyses.values()];
            analyses.clear();
            return all;
          }),
        ).pipe(Effect.flatMap(closeAll)),
      );

      return Navigation.of({
        definition: located("definition"),
        references: located("references"),
        identifiers,
        retire,
      });
    }),
  );
}
