import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type CaptureProgress,
  type ContentSide,
  type SnapshotManifest,
  snapshotIdOf,
} from "@gyst/core";
import { ConfigProvider, Effect, Fiber, Layer, PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapturedContent } from "./content.ts";
import { Git, type LocalScope, nulFraming } from "./git.ts";
import { Paths } from "./paths.ts";
import { githubOrigin, githubRepository, privateRefs, refState } from "../../tests/github.ts";

let root: string;
let dataDir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function repo(name: string, commit = true): Promise<string> {
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@gyst.invalid");
  git(cwd, "config", "user.name", "Gyst Test");
  if (commit) {
    await writeFile(join(cwd, "tracked.txt"), "one\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial");
  }
  return cwd;
}

type ContentService = (typeof CapturedContent)["Service"];
/** Real capture over a private data dir; `wrap` may replace content operations to inject faults. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Git | CapturedContent>,
  wrap: (real: ContentService) => ContentService = (real) => real,
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = NodeServices.layer,
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Git.layer.pipe(
        Layer.provideMerge(
          Layer.effect(CapturedContent, Effect.map(CapturedContent, wrap)).pipe(
            Layer.provide(CapturedContent.layer),
          ),
        ),
        Layer.provide(spawner),
        Layer.provide(Paths.layer),
        Layer.provide(NodeServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir }))),
      ),
    ),
  );
/** Captures and publishes, so every manifest a test inspects also passed strict publication. */
const capture = (cwd: string, scope: LocalScope = { kind: "uncommitted" }) =>
  run(
    Effect.gen(function* () {
      const manifest = yield* Git.use((g) => g.capture(cwd, scope));
      expect(yield* CapturedContent.use((c) => c.putManifest(manifest))).toBe(
        snapshotIdOf(manifest),
      );
      return manifest;
    }),
  );
const captureError = (
  cwd: string,
  scope: LocalScope = { kind: "uncommitted" },
  wrap?: (real: ContentService) => ContentService,
) => run(Effect.flip(Git.use((g) => g.capture(cwd, scope))), wrap);

const fileOf = (manifest: SnapshotManifest, path: string) =>
  manifest.files.find((file) => file.path === path);
const bytesOf = (side: ContentSide | undefined) => {
  if (side?.kind !== "text") throw new Error(`not text: ${JSON.stringify(side)}`);
  return readFile(join(dataDir, "content", "blobs", side.blob));
};
const hunkFiles = (manifest: SnapshotManifest) => [...new Set(manifest.hunks.map((h) => h.file))];
const blobs = () => readdir(join(dataDir, "content", "blobs"));
const staging = () => readdir(join(dataDir, "content", "staging"));

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "gyst-git-")));
  dataDir = join(root, "data");
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("Git", () => {
  it("resolves the real repository root and rejects directories outside a repository", async () => {
    const cwd = await repo("root");
    await mkdir(join(cwd, "nested", "deep"), { recursive: true });
    expect(await run(Git.use((g) => g.repoRoot(join(cwd, "nested", "deep"))))).toBe(cwd);
    const outside = await mkdtemp(join(tmpdir(), "gyst-not-a-repo-"));
    const error = await run(Effect.flip(Git.use((g) => g.repoRoot(outside))));
    expect(error._tag).toBe("bad_args");
    await rm(outside, { recursive: true, force: true });
  });
});

describe("Git.capture", () => {
  it("captures every eligible input of HEAD against the working tree, running no configured programs", async () => {
    const cwd = await repo("uncommitted");
    await writeFile(join(cwd, "helper.ts"), "export const helper = 1;\n");
    await writeFile(join(cwd, "package-lock.json"), "{}\n");
    await writeFile(join(cwd, "notes.weird-extension"), "plain text\n");
    await writeFile(join(cwd, ".gitignore"), "ignored-*\n");
    await writeFile(join(cwd, "ignored-but-tracked.txt"), "tracked anyway\n");
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "tracked.js"), "vendored\n");
    git(cwd, "add", "-f", ".");
    git(cwd, "commit", "-qm", "supporting files");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    const head = git(cwd, "rev-parse", "HEAD").trim();

    // Only after the last fixture Git command: every configurable program leaves a marker.
    const marker = join(root, "uncommitted-ran");
    const script = join(root, "record.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat "$@"\n`, { mode: 0o755 });
    const hooks = join(root, "hooks");
    await mkdir(hooks);
    for (const hook of [
      "post-index-change",
      "pre-commit",
      "post-checkout",
      "reference-transaction",
    ])
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const [key, value] of [
      ["color.ui", "always"],
      ["diff.external", script],
      ["diff.recorded.textconv", script],
      ["filter.spy.clean", script],
      ["filter.spy.smudge", script],
      ["core.fsmonitor", script],
      ["core.hooksPath", hooks],
      ["diff.relative", "true"],
    ])
      git(cwd, "config", key!, value!);
    await writeFile(join(cwd, ".gitattributes"), "* diff=recorded filter=spy\n");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "tracked.txt"), "colored\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    await writeFile(join(cwd, "sub", "inner.txt"), "inner\n");
    await writeFile(join(cwd, "ignored-untracked.txt"), "never captured\n");
    await mkdir(join(cwd, "node_modules", "pkg"));
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "never captured\n");

    const manifest = await capture(cwd);
    expect(existsSync(marker)).toBe(false);
    expect(manifest.provenance).toEqual({ kind: "uncommitted", head });
    expect(manifest.files.map((file) => file.path)).toEqual([
      ".gitattributes",
      ".gitignore",
      "helper.ts",
      "ignored-but-tracked.txt",
      "notes.weird-extension",
      "package-lock.json",
      "staged.txt",
      "sub/inner.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    const helper = fileOf(manifest, "helper.ts")!;
    expect(helper.new).toEqual(helper.old);
    expect(helper.old).toMatchObject({ kind: "text", blob: sha256("export const helper = 1;\n") });
    expect(String(await bytesOf(fileOf(manifest, "tracked.txt")!.old))).toBe("one\n");
    expect(String(await bytesOf(fileOf(manifest, "tracked.txt")!.new))).toBe("colored\n");
    expect(fileOf(manifest, "staged.txt")!.old).toEqual({ kind: "absent" });
    expect(hunkFiles(manifest)).toEqual([
      ".gitattributes",
      "staged.txt",
      "sub/inner.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    const tracked = manifest.hunks.find((hunk) => hunk.file === "tracked.txt")!;
    expect(tracked.patch).toBe("@@ -1 +1 @@\n-one\n+colored");
    expect(JSON.stringify(manifest)).not.toContain("\u001b[");
    expect(await staging()).toEqual([]);
  });

  it("keeps a normalized LF object distinct from its CRLF checkout and preserves exact bytes", async () => {
    const cwd = await repo("bytes");
    await writeFile(join(cwd, ".gitattributes"), "*.crlf text eol=crlf\n");
    await writeFile(join(cwd, "lines.crlf"), "a\nb\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "normalized");
    await rm(join(cwd, "lines.crlf"));
    git(cwd, "checkout", "--", "lines.crlf");
    const bom = "\uFEFFfirst\r\nsecond";
    await writeFile(join(cwd, "bom.txt"), bom);
    // 64 KiB chunks split the two-byte "é" at the first boundary.
    const split = `a${"é".repeat(40_000)}`;
    await writeFile(join(cwd, "split.txt"), split);

    const manifest = await capture(cwd);
    const lines = fileOf(manifest, "lines.crlf")!;
    // Tree sides are raw Git object bytes; the working side is the raw checkout.
    expect(String(await bytesOf(lines.old))).toBe("a\nb\n");
    expect(String(await bytesOf(lines.new))).toBe("a\r\nb\r\n");
    expect(manifest.hunks.find((hunk) => hunk.file === "lines.crlf")!.patch).toBe(
      "@@ -1,2 +1,2 @@\n-a\n-b\n+a\r\n+b\r",
    );
    expect(await bytesOf(fileOf(manifest, "bom.txt")!.new)).toEqual(Buffer.from(bom));
    expect(fileOf(manifest, "split.txt")!.new).toMatchObject({
      kind: "text",
      size: Buffer.byteLength(split),
    });
    expect(String(await bytesOf(fileOf(manifest, "split.txt")!.new))).toBe(split);
    const range = await capture(cwd, { kind: "range", range: "HEAD~1..HEAD" });
    expect(String(await bytesOf(fileOf(range, "lines.crlf")!.new))).toBe("a\nb\n");
  });

  it("reports binary and undecodable content unavailable, never storing it, beside text hunks", async () => {
    const cwd = await repo("binary");
    await writeFile(join(cwd, "image.bin"), Buffer.from([1, 0, 2]));
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "binary");
    const nul = Buffer.from([1, 0, 3]);
    const latin1 = Buffer.from("caf\xe9\n", "latin1");
    await writeFile(join(cwd, "image.bin"), nul);
    await writeFile(join(cwd, "latin1.txt"), latin1);
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    const manifest = await capture(cwd);
    expect(fileOf(manifest, "image.bin")).toEqual({
      path: "image.bin",
      old: { kind: "unavailable", reason: "binary" },
      new: { kind: "unavailable", reason: "binary" },
    });
    expect(fileOf(manifest, "latin1.txt")!.new).toEqual({
      kind: "unavailable",
      reason: "unsupported-encoding",
    });
    expect(hunkFiles(manifest)).toEqual(["tracked.txt"]);
    // Uncaptured bytes carry no identity: a binary edit leaves the manifest as it was, which is
    // why a source check cannot call such a snapshot unchanged.
    await writeFile(join(cwd, "image.bin"), Buffer.from([1, 0, 4]));
    expect(snapshotIdOf(await capture(cwd))).toBe(snapshotIdOf(manifest));
    const stored = await blobs();
    for (const bytes of [nul, latin1, Buffer.from([1, 0, 2])])
      expect(stored).not.toContain(sha256(bytes));
    expect(await staging()).toEqual([]);
  });

  it("records mode changes and byte-identical renames as unreviewed metadata, keeping text edits", async () => {
    const cwd = await repo("metadata");
    await writeFile(join(cwd, "script.sh"), "echo one\n");
    await writeFile(join(cwd, "old-name.txt"), "moved\n");
    await writeFile(join(cwd, "edited-old.txt"), "before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "metadata");
    await chmod(join(cwd, "tracked.txt"), 0o755);
    await writeFile(join(cwd, "script.sh"), "echo two\n");
    await chmod(join(cwd, "script.sh"), 0o755);
    git(cwd, "mv", "old-name.txt", "new-name.txt");
    // A rename with an edit is a genuine text change: it stays a reviewed delete and add.
    git(cwd, "mv", "edited-old.txt", "edited-new.txt");
    await writeFile(join(cwd, "edited-new.txt"), "after\n");
    for (const manifest of [
      await capture(cwd),
      await (async () => {
        git(cwd, "add", "-A");
        git(cwd, "commit", "-qm", "renames");
        return capture(cwd, { kind: "range", range: "HEAD~1..HEAD" });
      })(),
    ]) {
      const modeOnly = fileOf(manifest, "tracked.txt")!;
      expect(modeOnly.modeChange).toEqual({ old: "100644", new: "100755" });
      expect(modeOnly.new).toEqual(modeOnly.old);
      expect(fileOf(manifest, "script.sh")!.modeChange).toEqual({ old: "100644", new: "100755" });
      // Both paths keep their captured bytes; the pair is metadata, not review hunks.
      expect(fileOf(manifest, "old-name.txt")!.new).toEqual({ kind: "absent" });
      const renamed = fileOf(manifest, "new-name.txt")!;
      expect(renamed).toEqual({
        path: "new-name.txt",
        old: { kind: "absent" },
        new: fileOf(manifest, "old-name.txt")!.old,
        renamedFrom: "old-name.txt",
      });
      expect(String(await bytesOf(renamed.new))).toBe("moved\n");
      expect(fileOf(manifest, "edited-new.txt")!.renamedFrom).toBeUndefined();
      expect(manifest.hunks.map(({ file, patch }) => [file, patch])).toEqual([
        ["edited-new.txt", "@@ -0,0 +1 @@\n+after"],
        ["edited-old.txt", "@@ -1 +0,0 @@\n-before"],
        ["script.sh", "@@ -1 +1 @@\n-echo one\n+echo two"],
      ]);
    }
  });

  it("records a same-bytes rename that changes mode as paired metadata with no hunks", async () => {
    const cwd = await repo("rename-chmod");
    await writeFile(join(cwd, "old.txt"), "same bytes\n");
    await writeFile(join(cwd, "tool.sh"), "run\n", { mode: 0o755 });
    // Three deletions and additions of one content pair in path order.
    for (const name of ["dup-a", "dup-b", "dup-c"]) await writeFile(join(cwd, name), "dup\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "sources");
    git(cwd, "mv", "old.txt", "new.txt");
    await chmod(join(cwd, "new.txt"), 0o755);
    git(cwd, "mv", "tool.sh", "tool.txt");
    await chmod(join(cwd, "tool.txt"), 0o644);
    for (const name of ["dup-a", "dup-b", "dup-c"]) git(cwd, "mv", name, `${name}-moved`);
    for (const manifest of [
      await capture(cwd),
      await (async () => {
        git(cwd, "add", "-A");
        git(cwd, "commit", "-qm", "renames with mode changes");
        return capture(cwd, { kind: "range", range: "HEAD~1..HEAD" });
      })(),
    ]) {
      expect(manifest.hunks).toEqual([]);
      const pairs = manifest.files.flatMap((file) =>
        file.renamedFrom ? [[file.renamedFrom, file.path, file.modeChange]] : [],
      );
      expect(pairs).toEqual([
        ["dup-a", "dup-a-moved", undefined],
        ["dup-b", "dup-b-moved", undefined],
        ["dup-c", "dup-c-moved", undefined],
        ["old.txt", "new.txt", { old: "100644", new: "100755" }],
        ["tool.sh", "tool.txt", { old: "100755", new: "100644" }],
      ]);
      expect(fileOf(manifest, "old.txt")).toEqual({
        path: "old.txt",
        old: fileOf(manifest, "new.txt")!.new,
        new: { kind: "absent" },
      });
      expect(String(await bytesOf(fileOf(manifest, "new.txt")!.new))).toBe("same bytes\n");
    }
  });

  it("keeps a BOM-prefixed filename distinct from the same name without it", async () => {
    const cwd = await repo("bom-names");
    await writeFile(join(cwd, "\uFEFFhelper.ts"), "prefixed\n");
    await writeFile(join(cwd, "helper.ts"), "plain\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "both names");
    await writeFile(join(cwd, "\uFEFFhelper.ts"), "prefixed edit\n");
    const manifest = await capture(cwd);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "helper.ts",
      "tracked.txt",
      "\uFEFFhelper.ts",
    ]);
    expect(String(await bytesOf(fileOf(manifest, "helper.ts")!.new))).toBe("plain\n");
    expect(String(await bytesOf(fileOf(manifest, "\uFEFFhelper.ts")!.old))).toBe("prefixed\n");
    expect(String(await bytesOf(fileOf(manifest, "\uFEFFhelper.ts")!.new))).toBe("prefixed edit\n");
    expect(hunkFiles(manifest)).toEqual(["\uFEFFhelper.ts"]);
    const range = await capture(cwd, { kind: "range", range: "HEAD~1..HEAD" });
    expect(range.files.map((file) => file.path)).toEqual([
      "helper.ts",
      "tracked.txt",
      "\uFEFFhelper.ts",
    ]);
    expect(String(await bytesOf(fileOf(range, "\uFEFFhelper.ts")!.new))).toBe("prefixed\n");
  });

  it("stops at a gitlink that replaced a directory, keeping old text and reading no submodule file", async () => {
    const cwd = await repo("conversion");
    await mkdir(join(cwd, "module"));
    await writeFile(join(cwd, "module", "helper.ts"), "project helper\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "module directory");
    git(cwd, "rm", "-rq", "--cached", "module");
    await rm(join(cwd, "module"), { recursive: true });
    const nested = await repo("conversion/module");
    await writeFile(join(nested, "helper.ts"), "submodule secret\n");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "submodule");
    const moduleHead = git(nested, "rev-parse", "HEAD").trim();
    git(cwd, "update-index", "--add", "--cacheinfo", `160000,${moduleHead},module`);
    const manifest = await capture(cwd);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "module",
      "module/helper.ts",
      "tracked.txt",
    ]);
    expect(fileOf(manifest, "module")).toMatchObject({
      old: { kind: "absent" },
      new: { kind: "unavailable", reason: "submodule" },
    });
    const helper = fileOf(manifest, "module/helper.ts")!;
    expect(String(await bytesOf(helper.old))).toBe("project helper\n");
    expect(helper.new).toEqual({ kind: "absent" });
    expect(await blobs()).not.toContain(sha256("submodule secret\n"));
  });

  it("captures sparse-checkout omissions as unchanged, beside a real edit in the checkout", async () => {
    const cwd = await repo("sparse");
    await mkdir(join(cwd, "visible"));
    await mkdir(join(cwd, "hidden"));
    await writeFile(join(cwd, "visible", "app.txt"), "app\n");
    await writeFile(join(cwd, "hidden", "helper.txt"), "unchanged helper\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "sparse fixture");
    git(cwd, "sparse-checkout", "init", "--cone");
    git(cwd, "sparse-checkout", "set", "visible");
    expect(existsSync(join(cwd, "hidden"))).toBe(false);
    await writeFile(join(cwd, "visible", "app.txt"), "app edited\n");
    const manifest = await capture(cwd);
    const helper = fileOf(manifest, "hidden/helper.txt")!;
    expect(helper.new).toEqual(helper.old);
    expect(String(await bytesOf(helper.new))).toBe("unchanged helper\n");
    expect(manifest.hunks.map(({ file, patch }) => [file, patch])).toEqual([
      ["visible/app.txt", "@@ -1 +1 @@\n-app\n+app edited"],
    ]);
  });

  it("captures a skip-worktree file from the index without reading its path, rechecking the bit", async () => {
    const cwd = await repo("skip-worktree");
    await writeFile(join(cwd, "gone.txt"), "gone\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "skip fixture");
    git(cwd, "update-index", "--skip-worktree", "gone.txt", "tracked.txt");
    await rm(join(cwd, "gone.txt"));
    // As `git diff HEAD` does, the index entry stands for the path whatever the checkout holds.
    await writeFile(join(cwd, "tracked.txt"), "local override\n");
    expect(git(cwd, "diff", "HEAD")).toBe("");
    const manifest = await capture(cwd);
    expect(String(await bytesOf(fileOf(manifest, "gone.txt")!.new))).toBe("gone\n");
    expect(String(await bytesOf(fileOf(manifest, "tracked.txt")!.new))).toBe("one\n");
    expect(manifest.hunks).toEqual([]);
    expect(await blobs()).not.toContain(sha256("local override\n"));

    let cleared = false;
    const error = await captureError(cwd, undefined, (real) => ({
      ...real,
      putBlob: (bytes) =>
        real.putBlob(bytes).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!cleared) git(cwd, "update-index", "--no-skip-worktree", "gone.txt");
              cleared = true;
            }),
          ),
        ),
    }));
    expect(error).toMatchObject({
      _tag: "bad_args",
      message: expect.stringContaining("changed while it was being captured"),
      detail: { path: "gone.txt" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "drains or discards object-read diagnostics, so a noisy Git cannot stall capture",
    async () => {
      const cwd = await repo("noisy-cat-file");
      const pids: number[] = [];
      // Replace only `cat-file`: 1 MiB of stderr (far beyond a pipe's capacity) before stdout.
      const noisy = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const live = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) =>
            command._tag === "StandardCommand" && command.args.includes("cat-file")
              ? live
                  .spawn(
                    ChildProcess.make(
                      process.execPath,
                      [
                        "-e",
                        "process.stderr.write('x'.repeat(1 << 20)); process.stdout.write('noisy object\\n');",
                      ],
                      command.options,
                    ),
                  )
                  .pipe(Effect.tap((handle) => Effect.sync(() => pids.push(handle.pid))))
              : live.spawn(command),
          );
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const manifest = await run(
        Git.use((g) => g.capture(cwd, { kind: "uncommitted" })).pipe(Effect.timeout("5 seconds")),
        undefined,
        noisy,
      );
      expect(String(await bytesOf(fileOf(manifest, "tracked.txt")!.old))).toBe("noisy object\n");
      expect(pids.length).toBeGreaterThan(0);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow("ESRCH");
    },
    15_000,
  );

  it("frames NUL-separated inventory records across chunk boundaries", () => {
    const framing = nulFraming();
    const chunks = ["a\0b", "c\0", "\0d\0e"].map((chunk) => new TextEncoder().encode(chunk));
    const records = chunks
      .flatMap((chunk) => framing.push(chunk))
      .map((record) => String(Buffer.from(record)));
    expect(records).toEqual(["a", "bc", "", "d"]);
    expect(framing.pending).toBe(1);
  });

  it("filters a large inventory while streaming it", async () => {
    const cwd = await repo("large-inventory");
    const vendored = join(cwd, "node_modules", "pkg");
    await mkdir(vendored, { recursive: true });
    // About 250 KiB of untracked inventory, so records cross many stdout chunks.
    for (let index = 0; index < 2000; index++)
      await writeFile(
        join(vendored, `${String(index).padStart(4, "0")}-${"n".repeat(100)}.js`),
        "",
      );
    await writeFile(join(cwd, "zz.txt"), "after the vendored paths\n");
    const manifest = await capture(cwd);
    expect(manifest.files.map((file) => file.path)).toEqual(["tracked.txt", "zz.txt"]);
    expect(hunkFiles(manifest)).toEqual(["zz.txt"]);
  });

  it("captures against an empty baseline in a repository without HEAD", async () => {
    const cwd = await repo("unborn", false);
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");
    await writeFile(join(cwd, "empty.txt"), "");
    const manifest = await capture(cwd);
    expect(manifest.provenance).toEqual({ kind: "uncommitted", head: null });
    expect(manifest.files.every((file) => file.old.kind === "absent")).toBe(true);
    expect(fileOf(manifest, "empty.txt")!.new).toMatchObject({ kind: "text", size: 0 });
    expect(hunkFiles(manifest)).toEqual(["staged.txt", "untracked.txt"]);
  });

  it("resolves two- and three-dot ranges once, from commits only", async () => {
    const cwd = await repo("range");
    git(cwd, "branch", "-M", "main");
    git(cwd, "switch", "-qc", "feature");
    await writeFile(join(cwd, "feature.txt"), "feature\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "feature");
    git(cwd, "switch", "-q", "main");
    await writeFile(join(cwd, "tracked.txt"), "main moved\n");
    git(cwd, "commit", "-qam", "main");
    await writeFile(join(cwd, "tracked.txt"), "uncommitted\n");
    const [main, feature] = ["main", "feature"].map((ref) => git(cwd, "rev-parse", ref).trim());
    const mergeBase = git(cwd, "merge-base", "main", "feature").trim();
    const threeDot = await capture(cwd, { kind: "range", range: "main...feature" });
    expect(threeDot.provenance).toEqual({ kind: "range", base: main, head: feature, mergeBase });
    expect(hunkFiles(threeDot)).toEqual(["feature.txt"]);
    // The unchanged file is captured too, from the merge base and the head commit.
    expect(String(await bytesOf(fileOf(threeDot, "tracked.txt")!.new))).toBe("one\n");
    const twoDot = await capture(cwd, { kind: "range", range: "main..feature" });
    expect(twoDot.provenance).toEqual({
      kind: "range",
      base: main,
      head: feature,
      mergeBase: null,
    });
    expect(hunkFiles(twoDot)).toEqual(["feature.txt", "tracked.txt"]);
    // An omitted endpoint is HEAD, as in Git.
    expect(hunkFiles(await capture(cwd, { kind: "range", range: "feature..." }))).toEqual([
      "tracked.txt",
    ]);
  });

  it("keeps the endpoints it resolved when a ref moves mid-capture", async () => {
    const cwd = await repo("moving-ref");
    const initial = git(cwd, "rev-parse", "HEAD").trim();
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    git(cwd, "commit", "-qam", "two");
    const tip = git(cwd, "rev-parse", "HEAD").trim();
    let moved = false;
    const manifest = await run(
      Git.use((g) => g.capture(cwd, { kind: "range", range: `${initial}..HEAD` })),
      (real) => ({
        ...real,
        putBlob: (bytes) =>
          real.putBlob(bytes).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (!moved) git(cwd, "reset", "-q", "--hard", initial);
                moved = true;
              }),
            ),
          ),
      }),
    );
    expect(moved).toBe(true);
    expect(manifest.provenance).toEqual({
      kind: "range",
      base: initial,
      head: tip,
      mergeBase: null,
    });
    expect(String(await bytesOf(fileOf(manifest, "tracked.txt")!.new))).toBe("two\n");
  });

  it("ignores an inherited GIT_DIR that names another repository", async () => {
    const cwd = await repo("inherited-env");
    const other = await repo("inherited-env-other");
    await writeFile(join(other, "tracked.txt"), "other\n");
    git(other, "commit", "-qam", "other");
    await writeFile(join(cwd, "mine.txt"), "mine\n");
    process.env.GIT_DIR = join(other, ".git");
    try {
      expect(hunkFiles(await capture(cwd))).toEqual(["mine.txt"]);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it("diffs captured text as text above a configured core.bigFileThreshold", async () => {
    const cwd = await repo("big-file-threshold");
    await writeFile(join(cwd, ".gitattributes"), "*.txt diff\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "attributes");
    // Sides of different sizes: Git 2.55 left an equal-sized pair as text despite the threshold.
    await writeFile(join(cwd, "tracked.txt"), "one\nmore\n");
    const config = join(root, "big-file-threshold.gitconfig");
    await writeFile(config, "[core]\n\tbigFileThreshold = 1\n");
    const inherited = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      expect(git(cwd, "diff", "--no-color", "HEAD")).toContain("@@ -1 +1,2 @@\n one\n+more\n");
      const manifest = await capture(cwd);
      expect(manifest.hunks.map(({ file, patch }) => [file, patch])).toEqual([
        ["tracked.txt", "@@ -1 +1,2 @@\n one\n+more"],
      ]);
    } finally {
      if (inherited === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = inherited;
    }
  });

  it("rejects ranges that are not ranges, name unknown revisions, or look like options", async () => {
    const cwd = await repo("range-input");
    const written = join(root, "range-output");
    for (const [range, message] of [
      ["HEAD", "expected a Git range"],
      ["HEAD..HEAD -- tracked.txt", "expected a Git range"],
      [`--output=${written}..HEAD`, "expected a Git range"],
      [`HEAD..--output=${written}`, "expected a Git range"],
      ["HEAD..no-such-rev", "unknown revision in range: no-such-rev"],
      ["HEAD:tracked.txt..HEAD", "unknown revision in range: HEAD:tracked.txt"],
    ] as const) {
      const error = await captureError(cwd, { kind: "range", range });
      expect(error).toMatchObject({ _tag: "bad_args", message: expect.stringContaining(message) });
    }
    expect(existsSync(written)).toBe(false);
  });

  it("names hunks by logical path, including quotes and newlines, and rejects undecodable names", async () => {
    const cwd = await repo("names");
    const names = ["a b.txt", 'quo"te.txt', "new\nline.txt", "tab\there.txt", "ü.txt"];
    for (const name of names) await writeFile(join(cwd, name), `${name}\n`);
    const manifest = await capture(cwd);
    expect(hunkFiles(manifest)).toEqual([...names].sort());
    await writeFile(Buffer.concat([Buffer.from(`${cwd}/bad-`), Buffer.from([0xff])]), "x\n");
    expect(await captureError(cwd)).toMatchObject({
      _tag: "bad_args",
      message: "a repository path is not valid UTF-8 and cannot be captured",
    });
  });

  it("never follows links or enters submodules, and rejects a path under a linked directory", async () => {
    const cwd = await repo("links");
    const outside = join(root, "links-outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside secret\n");
    await symlink("tracked.txt", join(cwd, "link"));
    const nested = await repo("links/module");
    const moduleHead = git(nested, "rev-parse", "HEAD").trim();
    git(cwd, "update-index", "--add", "--cacheinfo", `160000,${moduleHead},module`);
    git(cwd, "add", "link");
    git(cwd, "commit", "-qm", "link and submodule");
    await symlink(join(outside, "secret.txt"), join(cwd, "leak"));
    const manifest = await capture(cwd);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "leak",
      "link",
      "module",
      "tracked.txt",
    ]);
    expect(fileOf(manifest, "leak")!.new).toEqual({ kind: "unavailable", reason: "symlink" });
    expect(fileOf(manifest, "link")!.old).toEqual({ kind: "unavailable", reason: "symlink" });
    expect(fileOf(manifest, "module")).toMatchObject({
      old: { kind: "unavailable", reason: "submodule" },
      new: { kind: "unavailable", reason: "submodule" },
    });
    expect(await blobs()).not.toContain(sha256("outside secret\n"));

    await mkdir(join(cwd, "dir"));
    await writeFile(join(cwd, "dir", "secret.txt"), "inside\n");
    git(cwd, "add", "dir");
    git(cwd, "commit", "-qm", "dir");
    await rm(join(cwd, "dir"), { recursive: true });
    await symlink(outside, join(cwd, "dir"));
    expect(await captureError(cwd)).toMatchObject({
      _tag: "bad_args",
      message: "a captured path crosses a symbolic link; captures never follow links",
      detail: { path: "dir/secret.txt" },
    });
  });

  it("fails on a missing object instead of fetching it from a promisor remote", async () => {
    const origin = await repo("promisor-origin");
    const clone = join(root, "promisor-clone");
    git(root, "clone", "-q", "--no-hardlinks", origin, clone);
    const blob = git(clone, "rev-parse", "HEAD:tracked.txt").trim();
    await rm(join(clone, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    git(clone, "config", "core.repositoryformatversion", "1");
    git(clone, "config", "extensions.partialClone", "origin");
    git(clone, "config", "remote.origin.promisor", "true");
    expect(await captureError(clone)).toMatchObject({
      _tag: "bad_args",
      message: "a Git object is missing or unreadable; capture never fetches it",
    });
    const present = () => {
      try {
        execFileSync("git", ["--no-lazy-fetch", "cat-file", "-e", blob], { cwd: clone });
        return true;
      } catch {
        return false;
      }
    };
    expect(present()).toBe(false);
    // Control: the fixture is a real promisor, so an ordinary read would have fetched the object.
    git(clone, "cat-file", "-p", blob);
    expect(present()).toBe(true);
  });

  it("refuses to publish when the working tree changes during capture", async () => {
    const cwd = await repo("race");
    await writeFile(join(cwd, "tracked.txt"), "edited\n");
    let puts = 0;
    // Puts run old side then new side per path: the second is tracked.txt's working bytes.
    const edits = {
      "before its read": (real: ContentService): ContentService => ({
        ...real,
        putBlob: (bytes) =>
          ++puts === 2
            ? Effect.promise(() => appendFile(join(cwd, "tracked.txt"), "more\n")).pipe(
                Effect.andThen(real.putBlob(bytes)),
              )
            : real.putBlob(bytes),
      }),
      "after its read": (real: ContentService): ContentService => ({
        ...real,
        putBlob: (bytes) =>
          real
            .putBlob(bytes)
            .pipe(
              Effect.tap(() =>
                ++puts === 2
                  ? Effect.promise(() => appendFile(join(cwd, "tracked.txt"), "more\n"))
                  : Effect.void,
              ),
            ),
      }),
      "by a new untracked file": (real: ContentService): ContentService => ({
        ...real,
        putBlob: (bytes) =>
          real
            .putBlob(bytes)
            .pipe(
              Effect.tap(() =>
                ++puts === 1
                  ? Effect.promise(() => writeFile(join(cwd, "new.txt"), "x\n"))
                  : Effect.void,
              ),
            ),
      }),
    };
    for (const [edit, wrap] of Object.entries(edits)) {
      puts = 0;
      const error = await captureError(cwd, undefined, wrap);
      expect(error, edit).toMatchObject({
        _tag: "bad_args",
        message: expect.stringContaining("changed while it was being captured"),
      });
      await rm(join(cwd, "new.txt"), { force: true });
    }
    expect(await staging()).toEqual([]);
  });

  it("stores each distinct content once and serves it after the checkout is gone", async () => {
    const cwd = await repo("dedup");
    await writeFile(join(cwd, "copy.txt"), "one\n");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    const before = await blobs();
    const manifest = await capture(cwd);
    expect(fileOf(manifest, "copy.txt")!.new).toEqual(fileOf(manifest, "tracked.txt")!.old);
    expect((await blobs()).filter((blob) => !before.includes(blob)).sort()).toEqual(
      [sha256("one\n"), sha256("two\n")].filter((blob) => !before.includes(blob)).sort(),
    );
    await rm(cwd, { recursive: true, force: true });
    const side = fileOf(manifest, "tracked.txt")!.new;
    const bytes = await run(
      CapturedContent.use((content) =>
        side.kind === "text"
          ? Stream.mkUint8Array(content.readBlob(side.blob, { offset: 0, length: side.size }))
          : Effect.die("not text"),
      ),
    );
    expect(new TextDecoder().decode(bytes)).toBe("two\n");
  });

  it("reports real, monotonic progress for uncommitted and range captures", async () => {
    const cwd = await repo("progress");
    await writeFile(join(cwd, "helper.txt"), "helper\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "helper");
    git(cwd, "branch", "-M", "main");
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    const heard = (scope: LocalScope) =>
      run(
        Effect.gen(function* () {
          const progress: CaptureProgress[] = [];
          const manifest = yield* Git.use((g) =>
            g.capture(cwd, scope, (event) => Effect.sync(() => void progress.push(event))),
          );
          return { manifest, progress };
        }),
      );
    const { manifest, progress } = await heard({ kind: "uncommitted" });
    const captured = progress.filter(({ phase }) => phase === "capture");
    const diffed = progress.filter(({ phase }) => phase === "diff");
    // Every event is a real count: capture then diff, each from 0 to its own total.
    expect(progress).toEqual([...captured, ...diffed]);
    expect(captured[0]).toEqual({ phase: "capture", done: 0, total: 3, bytes: 0 });
    // Bytes actually read: helper.txt from HEAD and from the working tree, both sides of
    // tracked.txt and untracked.txt.
    const bytes = ["helper\n", "helper\n", "one\n", "changed\n", "new\n"].join("").length;
    expect(captured.at(-1)).toEqual({ phase: "capture", done: 3, total: 3, bytes });
    // Between each phase's first and last event, at most one per 100 ms.
    expect([diffed[0], diffed.at(-1)]).toEqual([
      { phase: "diff", done: 0, total: 2, bytes },
      { phase: "diff", done: 2, total: 2, bytes },
    ]);
    expect(new Set(manifest.hunks.map((hunk) => hunk.file)).size).toBe(2);
    for (const [index, event] of progress.entries())
      if (index > 0 && progress[index - 1]!.phase === event.phase)
        expect(event.done).toBeGreaterThanOrEqual(progress[index - 1]!.done);

    const range = await heard({ kind: "range", range: "main~1..main" });
    expect(range.progress.at(0)).toMatchObject({ phase: "capture", done: 0, total: 2 });
    expect(range.progress.at(-1)).toMatchObject({ phase: "diff", done: 1, total: 1 });
  });

  it("reports a failed content write as an actionable error and leaves no staging", async () => {
    const cwd = await repo("write-failure");
    const error = await captureError(cwd, undefined, (real) => ({
      ...real,
      putBlob: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "writeFile",
            description: "no space left on device",
          }),
        ),
    }));
    expect(error).toMatchObject({
      _tag: "internal_error",
      message: "could not store captured content",
      detail: expect.stringContaining("no space left on device"),
    });
    expect(await staging()).toEqual([]);
  });
});

const generatedOf = (manifest: SnapshotManifest) =>
  manifest.files.filter((file) => file.generated).map(({ path }) => path);

describe("Git.capture Generated files", () => {
  it("marks changed files Git's attributes set generated or vendored, as Git resolves them", async () => {
    const cwd = await repo("generated-resolution");
    await writeFile(
      join(cwd, ".gitattributes"),
      [
        "[attr]bundled linguist-vendored",
        "*.gen linguist-generated",
        "on.txt linguist-generated=true",
        "off.gen linguist-generated=false",
        "unset.gen -linguist-generated",
        "lib/** bundled",
        "",
      ].join("\n"),
    );
    await mkdir(join(cwd, "lib"));
    await mkdir(join(cwd, "sub"));
    await writeFile(
      join(cwd, "sub", ".gitattributes"),
      "*.out linguist-vendored\nkept.gen -linguist-generated\n",
    );
    const edited = [
      "a.gen",
      "lib/x.js",
      "off.gen",
      "on.txt",
      "plain.txt",
      "sub/kept.gen",
      "sub/y.out",
      "unset.gen",
    ];
    for (const path of [...edited, "mode.gen", "stable.gen"])
      await writeFile(join(cwd, path), "before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "attributes");
    for (const path of edited) await writeFile(join(cwd, path), "after\n");
    await chmod(join(cwd, "mode.gen"), 0o755);

    const manifest = await capture(cwd);
    // Unchanged `stable.gen` is supporting source, not a Generated change.
    expect(generatedOf(manifest)).toEqual(["a.gen", "lib/x.js", "mode.gen", "on.txt", "sub/y.out"]);
    expect(fileOf(manifest, "a.gen")).toEqual({
      path: "a.gen",
      old: { kind: "text", blob: sha256("before\n"), size: 7 },
      new: { kind: "text", blob: sha256("after\n"), size: 6 },
      generated: true,
    });
    expect(hunkFiles(manifest)).toEqual([...edited]);
  });

  it("reads an uncommitted change's attributes from the working tree and a deletion's from HEAD", async () => {
    const cwd = await repo("generated-uncommitted");
    await writeFile(join(cwd, ".gitattributes"), "dist/** linguist-generated\n");
    await mkdir(join(cwd, "dist"));
    await writeFile(join(cwd, "dist", "old.js"), "old\n");
    await writeFile(join(cwd, "dist", "kept.js"), "kept\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "dist");
    await writeFile(join(cwd, ".gitattributes"), "new/** linguist-generated\n");
    await rm(join(cwd, "dist", "old.js"));
    await writeFile(join(cwd, "dist", "kept.js"), "kept, edited\n");
    await mkdir(join(cwd, "new"));
    await writeFile(join(cwd, "new", "added.js"), "added\n");

    expect(generatedOf(await capture(cwd))).toEqual(["dist/old.js", "new/added.js"]);
  });

  it("reads uncommitted attributes from the captured attributes files only, not the index or attr.tree", async () => {
    const cwd = await repo("generated-captured-attributes");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, ".gitattributes"), "b.js linguist-vendored\n");
    await writeFile(join(cwd, "sub", ".gitattributes"), "a.js linguist-generated\n");
    for (const path of ["sub/a.js", "b.js", "c.js"]) await writeFile(join(cwd, path), "before\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "attributes");
    // Deleted without staging: Git alone would fall back to the index copy.
    await rm(join(cwd, "sub", ".gitattributes"));
    await writeFile(join(cwd, ".gitattributes"), "c.js linguist-vendored\n");
    await mkdir(join(cwd, "new"));
    await writeFile(join(cwd, "new", ".gitattributes"), "d.js linguist-generated\n");
    for (const path of ["sub/a.js", "b.js", "c.js", "new/d.js"])
      await writeFile(join(cwd, path), "after\n");

    expect(generatedOf(await capture(cwd))).toEqual(["c.js", "new/d.js"]);
    git(cwd, "config", "attr.tree", "HEAD");
    // The tree of captured attributes files never writes into the repository.
    git(cwd, "config", "core.splitIndex", "true");
    const before = await readdir(join(cwd, ".git"));
    expect(generatedOf(await capture(cwd))).toEqual(["c.js", "new/d.js"]);
    expect(await readdir(join(cwd, ".git"))).toEqual(before);
  });

  it("reads a range's attributes from its commits, while uncommitted work reads the checkout's", async () => {
    const cwd = await repo("generated-range");
    await writeFile(join(cwd, ".gitattributes"), "gone.js linguist-vendored\n");
    await writeFile(join(cwd, "gone.js"), "vendored\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "base");
    const base = git(cwd, "rev-parse", "HEAD").trim();
    await writeFile(join(cwd, ".gitattributes"), "gen.js linguist-generated\n");
    await rm(join(cwd, "gone.js"));
    await writeFile(join(cwd, "gen.js"), "generated\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "head");
    // The checkout now unmarks everything; committed sides never read it.
    await writeFile(join(cwd, ".gitattributes"), "* -linguist-generated -linguist-vendored\n");
    await writeFile(join(cwd, "gen.js"), "generated, edited\n");

    for (const range of [`${base}..HEAD`, `${base}...HEAD`])
      expect(generatedOf(await capture(cwd, { kind: "range", range }))).toEqual([
        "gen.js",
        "gone.js",
      ]);
    expect(generatedOf(await capture(cwd))).toEqual([]);
  });
});

const pullRequestScope = (number: number) =>
  ({ kind: "pr", repository: githubRepository, number }) as const;
/**
 * main m1 <- layer-a (PR 1) <- layer-b (PR 2), and feature (PR 4) branched from m1 before main
 * moved on to m2 without restacking it.
 */
async function stacked(name: string) {
  const github = await githubOrigin(join(root, name));
  const m1 = git(github.author, "rev-parse", "main");
  const a1 = await github.commit("layer-a", { "a.txt": "layer a\n" }, { from: "main" });
  github.publish("layer-a", 1);
  const b1 = await github.commit("layer-b", { "b.txt": "layer b\n" }, { from: "layer-a" });
  github.publish("layer-b", 2);
  const f1 = await github.commit("feature", { "f.txt": "feature\n" }, { from: "main" });
  github.publish("feature", 4);
  const m2 = await github.commit("main", { "README.md": "widgets, moved on\n" });
  github.publish("main");
  return { ...github, m1: m1.trim(), m2, a1, b1, f1 };
}

describe("Git.pullRequestRange", () => {
  const range = (cwd: string, number: number, baseRefName: string, headRefOid: string) =>
    run(
      Git.use((g) =>
        g.pullRequestRange(cwd, pullRequestScope(number), { baseRefName, headRefOid }),
      ),
    );
  const rangeError = (cwd: string, number: number, baseRefName: string, headRefOid: string) =>
    run(
      Effect.flip(
        Git.use((g) =>
          g.pullRequestRange(cwd, pullRequestScope(number), { baseRefName, headRefOid }),
        ),
      ),
    );

  it("resolves a stacked layer against its own base branch, never the stack base", async () => {
    const github = await stacked("pr-stacked");
    expect(await range(github.checkout, 2, "layer-a", github.b1)).toEqual({
      base: github.a1,
      head: github.b1,
      mergeBase: github.a1,
    });
    expect(await range(github.checkout, 1, "main", github.a1)).toEqual({
      base: github.m2,
      head: github.a1,
      mergeBase: github.m1,
    });
  });

  it("uses a non-restacked PR's true merge base, not its base branch's newer tip", async () => {
    const github = await stacked("pr-not-restacked");
    const resolved = await range(github.checkout, 4, "main", github.f1);
    expect(resolved).toEqual({ base: github.m2, head: github.f1, mergeBase: github.m1 });
    expect(resolved.mergeBase).not.toBe(github.m2);
  });

  it("fetches only into private refs: HEAD, branches, remote refs, index, worktree and FETCH_HEAD stay", async () => {
    const github = await stacked("pr-no-mutation");
    const { checkout } = github;
    git(checkout, "switch", "-q", "-c", "local-work");
    await writeFile(join(checkout, "staged.txt"), "staged\n");
    git(checkout, "add", "staged.txt");
    await writeFile(join(checkout, "README.md"), "edited in the worktree\n");
    await writeFile(join(checkout, "untracked.txt"), "untracked\n");
    const marker = join(root, "pr-no-mutation-hook-ran");
    await writeFile(
      join(checkout, ".git", "hooks", "reference-transaction"),
      `#!/bin/sh\ntouch '${marker}'\n`,
    );
    await chmod(join(checkout, ".git", "hooks", "reference-transaction"), 0o755);
    const before = refState(checkout);

    await range(checkout, 2, "layer-a", github.b1);

    expect(refState(checkout)).toEqual(before);
    expect(before.fetchHead).toBeNull();
    expect(privateRefs(checkout)).toEqual([
      `refs/gyst/github/acme/widgets/pull/2/base ${github.a1}`,
      `refs/gyst/github/acme/widgets/pull/2/head ${github.b1}`,
    ]);
    expect(existsSync(marker)).toBe(false);
    // Again after the PR moved: the private refs are overwritten, nothing else changes.
    const b2 = await github.commit("layer-b", { "b.txt": "layer b, again\n" });
    github.publish("layer-b", 2);
    expect((await range(checkout, 2, "layer-a", b2)).head).toBe(b2);
    expect(refState(checkout)).toEqual(before);
  });

  it("reports PR objects the remote does not have as objects_missing", async () => {
    const github = await stacked("pr-missing-objects");
    const error = await rangeError(github.checkout, 5, "main", github.f1);
    expect(error).toMatchObject({
      _tag: "source_unavailable",
      message: expect.stringContaining("could not fetch https://github.com/acme/widgets/pull/5"),
      detail: {
        reason: "objects_missing",
        diagnostic: expect.stringContaining("refs/pull/5/head"),
      },
    });
    const deletedBase = await rangeError(github.checkout, 2, "gone", github.b1);
    expect(deletedBase).toMatchObject({ detail: { reason: "objects_missing" } });
    expect(privateRefs(github.checkout)).toEqual([]);
  });

  it("refuses a head that moved since GitHub reported it, retryably", async () => {
    const github = await stacked("pr-head-moved");
    const error = await rangeError(github.checkout, 2, "layer-a", github.a1);
    expect(error).toMatchObject({
      _tag: "source_unavailable",
      message: expect.stringContaining("open it again"),
      detail: { reason: "head_moved" },
    });
  });

  it("requires a checkout with a remote whose raw URL names the repository", async () => {
    const github = await stacked("pr-checkout");
    const elsewhere = await repo("pr-checkout-elsewhere");
    git(elsewhere, "remote", "add", "origin", "https://github.com/acme/other.git");
    git(elsewhere, "config", `url.${github.origin}.insteadOf`, "https://github.com/acme/other.git");
    for (const cwd of [elsewhere, await repo("pr-checkout-no-remote")])
      expect(await rangeError(cwd, 2, "layer-a", github.b1)).toMatchObject({
        _tag: "source_unavailable",
        message: expect.stringContaining("no remote for github.com/acme/widgets"),
        detail: { reason: "checkout_mismatch" },
      });

    // Any spelling of the repository's URL matches, on whichever remote carries it.
    git(elsewhere, "remote", "add", "upstream", "https://github.com/acme/elsewhere.git");
    for (const url of [
      "git@github.com:Acme/Widgets.git",
      "ssh://git@github.com/acme/widgets",
      "https://github.com/acme/widgets/",
    ]) {
      git(elsewhere, "remote", "set-url", "upstream", url);
      git(elsewhere, "config", `url.${github.origin}.insteadOf`, url);
      expect((await range(elsewhere, 2, "layer-a", github.b1)).head, url).toBe(github.b1);
    }
  });

  it("keeps a concurrent acquisition's fetch from landing between another's head and base reads", async () => {
    const github = await stacked("pr-concurrent");
    let fetches = 0;
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    // Holds the first acquisition after it read its head and before it reads its base.
    const pausing = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const live = yield* ChildProcessSpawner.ChildProcessSpawner;
        let held = false;
        return ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return live.spawn(command);
          if (command.args.includes("fetch")) fetches += 1;
          if (held || !command.args.some((arg) => arg.endsWith("/pull/2/base^{commit}")))
            return live.spawn(command);
          held = true;
          paused.resolve();
          return Effect.andThen(
            Effect.promise(() => resume.promise),
            live.spawn(command),
          );
        });
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const acquire = (headRefOid: string) =>
      Git.use((g) =>
        g.pullRequestRange(github.checkout, pullRequestScope(2), {
          baseRefName: "layer-a",
          headRefOid,
        }),
      );
    const { first, second, fetchesWhileHeld, a2, b2 } = await run(
      Effect.gen(function* () {
        const firstFiber = yield* Effect.forkChild(acquire(github.b1));
        yield* Effect.promise(() => paused.promise);
        // A restack moves both refs while the first acquisition is between its reads.
        const a2 = yield* Effect.promise(() => github.commit("layer-a", { "a.txt": "a, again\n" }));
        github.publish("layer-a", 1);
        git(github.author, "rebase", "-q", "--onto", "layer-a", github.a1, "layer-b");
        const b2 = github.publish("layer-b", 2);
        const secondFiber = yield* Effect.forkChild(acquire(b2));
        yield* Effect.sleep("500 millis");
        const fetchesWhileHeld = fetches;
        resume.resolve();
        return {
          first: yield* Fiber.join(firstFiber),
          second: yield* Fiber.join(secondFiber),
          fetchesWhileHeld,
          a2,
          b2,
        };
      }),
      undefined,
      pausing,
    );
    expect(fetchesWhileHeld).toBe(1);
    expect(first).toEqual({ base: github.a1, head: github.b1, mergeBase: github.a1 });
    expect(second).toEqual({ base: a2, head: b2, mergeBase: a2 });
  });

  it("fetches a repository whose name is not a valid ref component into escaped private refs", async () => {
    const github = await stacked("pr-dot-repository");
    const url = "https://github.com/acme/.github.git";
    git(github.checkout, "remote", "add", "dotgithub", url);
    git(github.checkout, "config", `url.${github.origin}.insteadOf`, url);
    const scope = { kind: "pr", repository: "acme/.github", number: 2 } as const;
    const resolved = await run(
      Git.use((g) =>
        g.pullRequestRange(github.checkout, scope, {
          baseRefName: "layer-a",
          headRefOid: github.b1,
        }),
      ),
    );
    expect(resolved).toEqual({ base: github.a1, head: github.b1, mergeBase: github.a1 });
    expect(privateRefs(github.checkout)).toEqual([
      `refs/gyst/github/acme/%2egithub/pull/2/base ${github.a1}`,
      `refs/gyst/github/acme/%2egithub/pull/2/head ${github.b1}`,
    ]);
  });

  it("rejects a base branch name Git would not accept before fetching", async () => {
    const github = await stacked("pr-bad-base");
    for (const name of ["-x", "a..b", "x:y", "has space", ""])
      expect(await rangeError(github.checkout, 2, name, github.b1), name).toMatchObject({
        _tag: "source_unavailable",
        detail: { reason: "github_failed", diagnostic: name },
      });
    expect(privateRefs(github.checkout)).toEqual([]);
  });
});

describe("Git.capturePullRequest", () => {
  /** Captures a PR at the head GitHub reported and publishes it, like `capture`. */
  const capturePullRequest = (cwd: string, number: number, baseRefName: string, head: string) =>
    run(
      Effect.gen(function* () {
        const manifest = yield* Git.use((g) =>
          g.capturePullRequest(cwd, pullRequestScope(number), {
            baseRefName,
            headRefOid: head,
          }),
        );
        expect(yield* CapturedContent.use((c) => c.putManifest(manifest))).toBe(
          snapshotIdOf(manifest),
        );
        return manifest;
      }),
    );

  it("captures only a layer's own hunks, with inherited source readable unchanged", async () => {
    const github = await stacked("capture-pr-layer");
    const manifest = await capturePullRequest(github.checkout, 2, "layer-a", github.b1);
    expect(manifest.scope).toEqual(pullRequestScope(2));
    expect(manifest.provenance).toEqual({
      kind: "pr",
      base: github.a1,
      head: github.b1,
      mergeBase: github.a1,
    });
    expect(hunkFiles(manifest)).toEqual(["b.txt"]);
    // Layer A's file is the selected snapshot's unchanged supporting source.
    const inherited = fileOf(manifest, "a.txt");
    expect(inherited?.old).toEqual(inherited?.new);
    expect(await bytesOf(inherited?.new)).toEqual(Buffer.from("layer a\n"));
    expect(manifest.files.map(({ path }) => path)).toEqual(["README.md", "a.txt", "b.txt"]);
  });

  it("diffs a non-restacked PR from its true merge base, excluding its base branch's later change", async () => {
    const github = await stacked("capture-pr-not-restacked");
    const manifest = await capturePullRequest(github.checkout, 4, "main", github.f1);
    expect(manifest.provenance).toMatchObject({
      kind: "pr",
      base: github.m2,
      mergeBase: github.m1,
    });
    expect(hunkFiles(manifest)).toEqual(["f.txt"]);
    const readme = fileOf(manifest, "README.md");
    expect(readme?.old).toEqual(readme?.new);
    expect(await bytesOf(readme?.new)).toEqual(Buffer.from("widgets\n"));
  });

  it("reads a PR's attributes from its fetched head, not the checkout", async () => {
    const github = await githubOrigin(join(root, "capture-pr-generated"));
    const head = await github.commit(
      "generated",
      { ".gitattributes": "gen.txt linguist-generated\n", "gen.txt": "generated\n" },
      { from: "main" },
    );
    github.publish("generated", 6);
    const manifest = await capturePullRequest(github.checkout, 6, "main", head);
    expect(generatedOf(manifest)).toEqual(["gen.txt"]);
    expect(existsSync(join(github.checkout, ".gitattributes"))).toBe(false);
  });

  it("captures nothing when the PR range cannot be resolved", async () => {
    const github = await stacked("capture-pr-missing");
    expect(
      await run(
        Effect.flip(
          Git.use((g) =>
            g.capturePullRequest(github.checkout, pullRequestScope(5), {
              baseRefName: "main",
              headRefOid: github.f1,
            }),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "source_unavailable", detail: { reason: "objects_missing" } });
  });
});
