import { type Session, SessionSchema } from "@gyst/core";
import { Array, Context, Effect, FileSystem, Layer, type PlatformError, Schema } from "effect";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Paths } from "./paths.ts";

const decodeSessionFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSchema), {
  onExcessProperty: "error",
});

/** A committed deletion: the answer to every retry of `requestId`, kept after the session file is gone. */
const DeleteReceiptSchema = Schema.Struct({ requestId: Schema.String, sessionId: Schema.String });
export type DeleteReceipt = typeof DeleteReceiptSchema.Type;
const DeleteReceiptsFileSchema = Schema.fromJsonString(Schema.Array(DeleteReceiptSchema));
const decodeDeleteReceipts = Schema.decodeUnknownEffect(DeleteReceiptsFileSchema, {
  onExcessProperty: "error",
});
/** Session id to the `PATH` of the latest CLI invocation that opened it. */
export type LaunchPaths = Readonly<Record<string, string>>;
const decodeLaunchPaths = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

// Temp + rename: a reader never sees a half-written file, and a writer killed midway leaves the old
// one. The scope removes the temp directory whether or not the file was renamed out of it, so a
// failed write leaves nothing.
export const writeAtomically = Effect.fn("writeAtomically")(function* (
  path: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempFileScoped({ directory: dirname(path) });
  yield* fs.chmod(temporary, 0o600);
  yield* fs.writeFileString(temporary, content);
  yield* fs.rename(temporary, path);
}, Effect.scoped);

// Compare the exact persisted bytes again after the old daemon stops admitting commands.
export const inspectSavedSessions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths;
  const names = (yield* fs.readDirectory(paths.dataDir)).filter((name) => name.endsWith(".json"));
  const hash = createHash("sha256");
  const incompatible: string[] = [];
  for (const name of names.sort()) {
    const content = yield* fs.readFile(paths.sessionFile(name.slice(0, -5)));
    hash.update(JSON.stringify([name, content.byteLength]));
    hash.update(content);
    if (yield* Effect.isFailure(decodeSessionFile(new TextDecoder().decode(content))))
      incompatible.push(name);
  }
  return { fingerprint: hash.digest("hex"), incompatible };
});

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** Undecodable files are skipped: a corrupt or older session must not block valid ones. */
    readonly loadAll: Effect.Effect<Array<Session>, PlatformError.PlatformError>;
    /** The text of every session file `loadAll` skips, which reclaiming content must still respect. */
    readonly loadUndecodable: Effect.Effect<Array<string>, PlatformError.PlatformError>;
    save(session: Session): Effect.Effect<void, PlatformError.PlatformError>;
    remove(id: string): Effect.Effect<void, PlatformError.PlatformError>;
    /** Empty until the first deletion; an unreadable receipt file is a defect, never an empty list. */
    readonly loadDeleteReceipts: Effect.Effect<
      ReadonlyArray<DeleteReceipt>,
      PlatformError.PlatformError
    >;
    /** Replaces every receipt atomically, like a session save. */
    saveDeleteReceipts(
      receipts: ReadonlyArray<DeleteReceipt>,
    ): Effect.Effect<void, PlatformError.PlatformError>;
    /**
     * Empty when absent or unreadable: losing them costs only navigation, until the CLI opens the
     * session again.
     */
    readonly loadLaunchPaths: Effect.Effect<LaunchPaths>;
    /** Replaces every session's `PATH` atomically, like a session save. */
    saveLaunchPaths(launchPaths: LaunchPaths): Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("gyst/daemon/SessionStore") {
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      yield* fs.makeDirectory(paths.dataDir, { recursive: true, mode: 0o700 });

      const readAll = Effect.gen(function* () {
        const files = yield* fs.readDirectory(paths.dataDir);
        return yield* Effect.forEach(
          files.filter((file) => file.endsWith(".json")),
          (file) =>
            fs.readFileString(paths.sessionFile(file.slice(0, -".json".length))).pipe(
              Effect.flatMap((content) =>
                Effect.map(Effect.option(decodeSessionFile(content)), (session) => ({
                  content,
                  session,
                })),
              ),
            ),
        );
      });
      const loadAll = readAll.pipe(
        Effect.map((read) => Array.getSomes(read.map(({ session }) => session))),
        Effect.withSpan("SessionStore.loadAll"),
      );
      const loadUndecodable = readAll.pipe(
        Effect.map((read) =>
          read.flatMap(({ content, session }) => (session._tag === "None" ? [content] : [])),
        ),
        Effect.withSpan("SessionStore.loadUndecodable"),
      );

      const write = (path: string, content: string) =>
        writeAtomically(path, content).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const save = (session: Session) =>
        write(paths.sessionFile(session.id), `${JSON.stringify(session)}\n`);

      const remove = Effect.fn("SessionStore.remove")((id: string) =>
        fs.remove(paths.sessionFile(id), { force: true }),
      );

      const loadDeleteReceipts = Effect.gen(function* () {
        if (!(yield* fs.exists(paths.deleteReceiptsPath))) return [];
        const content = yield* fs.readFileString(paths.deleteReceiptsPath);
        return yield* Effect.orDie(decodeDeleteReceipts(content));
      }).pipe(Effect.withSpan("SessionStore.loadDeleteReceipts"));

      // ponytail: rewrites every receipt per deletion; an append-only log if deletions number thousands.
      const saveDeleteReceipts = (receipts: ReadonlyArray<DeleteReceipt>) =>
        write(paths.deleteReceiptsPath, `${JSON.stringify(receipts)}\n`);

      const loadLaunchPaths = fs.readFileString(paths.launchPathsPath).pipe(
        Effect.flatMap(decodeLaunchPaths),
        Effect.orElseSucceed((): LaunchPaths => ({})),
        Effect.withSpan("SessionStore.loadLaunchPaths"),
      );
      const saveLaunchPaths = (launchPaths: LaunchPaths) =>
        write(paths.launchPathsPath, `${JSON.stringify(launchPaths)}\n`);

      return SessionStore.of({
        loadAll,
        loadUndecodable,
        save,
        remove,
        loadDeleteReceipts,
        saveDeleteReceipts,
        loadLaunchPaths,
        saveLaunchPaths,
      });
    }),
  );
}
