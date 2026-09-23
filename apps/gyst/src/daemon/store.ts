import { type Session, SessionSchema, SESSION_FORMAT_VERSION } from "@gyst/core";
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Schema } from "effect";
import { isAbsolute, normalize } from "node:path";
import { Paths } from "./paths.ts";

const decodeSessionFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSchema), {
  onExcessProperty: "error",
});
const decodeIdentity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String.check(Schema.makeFilter((id) => /^[a-zA-Z0-9_-]+$/.test(id))),
      repoRoot: Schema.String.check(
        Schema.makeFilter(
          (root) =>
            // eslint-disable-next-line no-control-regex -- Identity paths must be safe to report.
            isAbsolute(root) && normalize(root) === root && !/[\x00-\x1f\x7f-\x9f]/.test(root),
        ),
      ),
      formatVersion: Schema.optional(Schema.Unknown),
    }),
  ),
);
export type IncompatibleSession = {
  id: string;
  repoRoot: string;
  path: string;
  formatVersion: string | number | null;
};
export type StoredSessions = { sessions: Session[]; incompatible: IncompatibleSession[] };

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** Corrupt files are skipped; recognizable incompatible identities remain reserved. */
    readonly loadAll: Effect.Effect<StoredSessions, PlatformError.PlatformError>;
    save(session: Session): Effect.Effect<void, PlatformError.PlatformError>;
    remove(id: string): Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("gyst/daemon/SessionStore") {
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      yield* fs.makeDirectory(paths.dataDir, { recursive: true, mode: 0o700 });

      const loadAll = Effect.gen(function* () {
        const files = yield* fs.readDirectory(paths.dataDir);
        const result: StoredSessions = { sessions: [], incompatible: [] };
        for (const file of files.filter((name) => name.endsWith(".json"))) {
          const path = paths.sessionFile(file.slice(0, -".json".length));
          const content = yield* fs.readFileString(path);
          const identity = yield* Effect.option(decodeIdentity(content));
          if (Option.isSome(identity) && identity.value.formatVersion !== SESSION_FORMAT_VERSION) {
            const { id, repoRoot, formatVersion } = identity.value;
            result.incompatible.push({
              id,
              repoRoot,
              path,
              formatVersion:
                typeof formatVersion === "number" || typeof formatVersion === "string"
                  ? formatVersion
                  : null,
            });
            continue;
          }
          const session = yield* Effect.option(decodeSessionFile(content));
          if (Option.isSome(session)) result.sessions.push(session.value);
        }
        return result;
      }).pipe(Effect.withSpan("SessionStore.loadAll"));

      // Temp + rename: a reader never sees a half-written session. The scope removes the temp
      // directory whether or not the file was renamed out of it, so a failed write leaves nothing.
      const save = Effect.fn("SessionStore.save")(function* (session: Session) {
        const temporary = yield* fs.makeTempFileScoped({ directory: paths.dataDir });
        yield* fs.chmod(temporary, 0o600);
        yield* fs.writeFileString(temporary, `${JSON.stringify(session)}\n`);
        yield* fs.rename(temporary, paths.sessionFile(session.id));
      }, Effect.scoped);

      const remove = Effect.fn("SessionStore.remove")((id: string) =>
        fs.remove(paths.sessionFile(id), { force: true }),
      );

      return SessionStore.of({ loadAll, save, remove });
    }),
  );
}
