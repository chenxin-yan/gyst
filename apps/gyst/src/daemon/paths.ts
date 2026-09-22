import { Config, Context, Effect, Layer, Path } from "effect";
import { homedir } from "node:os";

export class Paths extends Context.Service<
  Paths,
  {
    readonly dataDir: string;
    readonly socketPath: string;
    readonly pidPath: string;
    sessionFile(id: string): string;
  }
>()("gyst/daemon/Paths") {
  /** `GYST_DATA_DIR`, else `$XDG_DATA_HOME/gyst`, else `~/.local/share/gyst`; injectable via `ConfigProvider`. */
  static readonly layer = Layer.effect(
    Paths,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const xdgDataHome = yield* Config.String("XDG_DATA_HOME").pipe(
        Config.withDefault(path.join(homedir(), ".local", "share")),
      );
      const dataDir = yield* Config.String("GYST_DATA_DIR").pipe(
        Config.withDefault(path.join(xdgDataHome, "gyst")),
      );
      return Paths.of({
        dataDir,
        socketPath: path.join(dataDir, "daemon.sock"),
        pidPath: path.join(dataDir, "daemon.pid"),
        sessionFile: (id) => path.join(dataDir, `${id}.json`),
      });
    }),
  );
}
