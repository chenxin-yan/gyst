import { type Session, SessionSchema } from "@gyst/core";
import {
  Array,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Schema,
} from "effect";
import { Paths } from "./paths.ts";

const decodeSessionFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSchema), {
  onExcessProperty: "error",
});

// Compare the exact persisted bytes again after the old daemon stops admitting commands.
export const inspectSavedSessions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths;
  const names = (yield* fs.readDirectory(paths.dataDir)).filter((name) => name.endsWith(".json"));
  const hash = new Bun.CryptoHasher("sha256");
  const incompatible: string[] = [];
  for (const name of names.sort()) {
    const content = yield* fs.readFile(paths.sessionFile(name.slice(0, -5)));
    hash.update(JSON.stringify([name, content.byteLength]));
    hash.update(content);
    if (Option.isNone(yield* Effect.option(decodeSessionFile(new TextDecoder().decode(content)))))
      incompatible.push(name);
  }
  return { fingerprint: hash.digest("hex"), incompatible };
});

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** Undecodable files are skipped: a corrupt or older session must not block valid ones. */
    readonly loadAll: Effect.Effect<Array<Session>, PlatformError.PlatformError>;
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
        const sessions = yield* Effect.forEach(
          files.filter((file) => file.endsWith(".json")),
          (file) =>
            fs
              .readFileString(paths.sessionFile(file.slice(0, -".json".length)))
              .pipe(Effect.flatMap((content) => Effect.option(decodeSessionFile(content)))),
        );
        return Array.getSomes(sessions);
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
