import { BadArgs, type Scope } from "@gyst/core";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Presentation config (color.ui, diff.relative) must not reach the parser: parsed filenames stay
// root-relative. Configured external diff and textconv programs never run on reviewed content.
const patchFlags = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative"];

/** `base..head` or `base...head`, either side defaulting to HEAD as in Git. */
const rangePattern = /^(?<base>[^\s]*?)(?<dots>\.\.\.?)(?<head>[^\s.][^\s]*|)$/u;

export class Git extends Context.Service<
  Git,
  {
    /** The real path of the repository containing a trusted caller's directory. */
    repoRoot(cwd: string): Effect.Effect<string, BadArgs>;
    /** The whole recorded scope as one unified diff, with endpoints resolved at this capture. */
    capture(root: string, scope: Scope): Effect.Effect<string, BadArgs>;
  }
>()("gyst/daemon/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;

      const run = Effect.fn("Git.run")(
        function* (cwd: string, ...args: string[]) {
          // Timeout interruption must also terminate Git wrappers that ignore SIGTERM.
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", args, { cwd, stdin: "ignore", forceKillAfter: "500 millis" }),
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

      // `--end-of-options` keeps a caller's revision from ever being read as an option.
      const commit = Effect.fn("Git.commit")(function* (root: string, revision: string) {
        const resolved = yield* run(
          root,
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${revision}^{commit}`,
        );
        if (resolved.exitCode !== 0)
          return yield* new BadArgs({ message: `unknown revision in range: ${revision}` });
        return resolved.stdout.trim();
      });

      const diff = Effect.fn("Git.diff")(function* (root: string, ...commits: string[]) {
        const result = yield* run(root, "diff", ...patchFlags, ...commits, "--");
        if (result.exitCode !== 0)
          return yield* new BadArgs({ message: result.stderr.trim() || "git diff failed" });
        return result.stdout;
      });

      const range = Effect.fn("Git.range")(function* (root: string, recorded: string) {
        const parsed = rangePattern.exec(recorded)?.groups;
        if (!parsed || parsed.base!.startsWith("-") || parsed.head!.startsWith("-"))
          return yield* new BadArgs({
            message: "expected a Git range such as main...feature or main..feature",
            detail: recorded,
          });
        const base = yield* commit(root, parsed.base || "HEAD");
        const head = yield* commit(root, parsed.head || "HEAD");
        if (parsed.dots === "..") return yield* diff(root, base, head);
        // A three-dot range diffs from the merge base, as `git diff A...B` does.
        const mergeBase = yield* run(root, "merge-base", base, head);
        if (mergeBase.exitCode !== 0)
          return yield* new BadArgs({ message: `range has no merge base: ${recorded}` });
        return yield* diff(root, mergeBase.stdout.trim(), head);
      });

      const uncommitted = Effect.fn("Git.uncommitted")(function* (root: string) {
        const head = yield* run(root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
        let base = head.stdout.trim();
        if (head.exitCode !== 0) {
          const emptyTree = yield* run(root, "hash-object", "-t", "tree", "/dev/null");
          if (emptyTree.exitCode !== 0)
            return yield* new BadArgs({ message: "could not derive the empty git tree" });
          base = emptyTree.stdout.trim();
        }
        let text = yield* diff(root, base);
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

      const capture = (root: string, scope: Scope) =>
        scope.kind === "range" ? range(root, scope.range) : uncommitted(root);

      return Git.of({ repoRoot, capture });
    }),
  );
}
