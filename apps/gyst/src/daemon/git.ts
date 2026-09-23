import { BadArgs } from "@gyst/core";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// Presentation config (color.ui, diff.external, diff.relative) must not reach the parser: parsed
// filenames become editor targets, so they must stay root-relative even when run from a subdirectory.
const patchFlags = ["--no-color", "--no-ext-diff", "--no-relative"];

export class Git extends Context.Service<
  Git,
  {
    repoRoot(cwd: string): Effect.Effect<string, BadArgs>;
    /** Empty `args` diff against HEAD, or the empty tree in a repository without commits. */
    patch(
      root: string,
      cwd: string,
      args: ReadonlyArray<string>,
      includeUntracked: boolean,
    ): Effect.Effect<string, BadArgs>;
  }
>()("gyst/daemon/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;

      const run = Effect.fn("Git.run")(
        function* (cwd: string, ...args: string[]) {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", args, { cwd, stdin: "ignore" }),
          );
          const text = (stream: typeof handle.stdout) =>
            stream.pipe(Stream.decodeText(), Stream.mkString);
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [text(handle.stdout), text(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return { exitCode, stdout, stderr };
        },
        Effect.scoped,
        Effect.mapError(
          (error) => new BadArgs({ message: "git could not be run", detail: error.message }),
        ),
      );

      const repoRoot = Effect.fn("Git.repoRoot")(function* (cwd: string) {
        const command = yield* run(cwd, "rev-parse", "--show-toplevel");
        if (command.exitCode !== 0)
          return yield* new BadArgs({
            message: "current directory is not inside a git repository",
          });
        return yield* fs.realPath(command.stdout.replace(/\n$/, "")).pipe(
          Effect.mapError(
            (error) =>
              new BadArgs({
                message: "could not resolve the repository root",
                detail: error.message,
              }),
          ),
        );
      });

      const defaultArgs = Effect.fn("Git.defaultArgs")(function* (root: string) {
        const head = yield* run(root, "rev-parse", "--verify", "HEAD");
        if (head.exitCode === 0) return ["HEAD"];
        const emptyTree = yield* run(root, "hash-object", "-t", "tree", "/dev/null");
        if (emptyTree.exitCode !== 0)
          return yield* new BadArgs({ message: "could not derive the empty git tree" });
        return [emptyTree.stdout.trim()];
      });

      const patch = Effect.fn("Git.patch")(function* (
        root: string,
        cwd: string,
        args: ReadonlyArray<string>,
        includeUntracked: boolean,
      ) {
        const bare = args.length === 0;
        const diffArgs = bare ? yield* defaultArgs(root) : args;
        // A bare snapshot covers the whole repository; explicit pathspecs resolve from the caller.
        const diff = yield* run(bare ? root : cwd, "diff", ...patchFlags, ...diffArgs);
        if (diff.exitCode !== 0)
          return yield* new BadArgs({ message: diff.stderr.trim() || "git diff failed" });
        let text = diff.stdout;
        if (!includeUntracked) return text;
        const listed = yield* run(root, "ls-files", "--others", "--exclude-standard", "-z");
        if (listed.exitCode !== 0)
          return yield* new BadArgs({ message: "could not list untracked files" });
        for (const file of listed.stdout.split("\0").filter(Boolean)) {
          const added = yield* run(
            root,
            "diff",
            ...patchFlags,
            "--no-index",
            "--",
            "/dev/null",
            file,
          );
          if (added.exitCode !== 0 && added.exitCode !== 1)
            return yield* new BadArgs({ message: added.stderr.trim() || `could not diff ${file}` });
          text += added.stdout;
        }
        return text;
      });

      return Git.of({ repoRoot, patch });
    }),
  );
}
