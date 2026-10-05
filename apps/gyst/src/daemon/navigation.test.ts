import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AddonDiscovery,
  type ByteRange,
  navigationInstallCommand,
  type Request,
  type TextPoint,
} from "@gyst/core";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  cp,
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
import { fileURLToPath } from "node:url";
import { CapturedContent } from "./content.ts";
import { Git } from "./git.ts";
import { Navigation } from "./navigation.ts";
import { Paths } from "./paths.ts";
import { daemonVersion } from "./protocol.ts";
import { Sessions } from "./sessions.ts";
import { SessionStore } from "./store.ts";

type Input<C extends Request["command"]> = Extract<Request, { readonly command: C }>;
type Target = Pick<Input<"definition">, "session" | "snapshotId" | "side" | "file">;

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const addonDir = join(repoRoot, "packages", "navigation-typescript");
const addon = {
  kind: "available",
  entry: realpathSync(join(addonDir, "src", "cli.js")),
  version: daemonVersion,
} as const;
const install = navigationInstallCommand(daemonVersion);

let dir: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "gyst-navigation-")));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Every Node process the stack spawned (handshakes and engines), with its arguments. */
const spawned: Array<{ readonly args: ReadonlyArray<string>; readonly pid: number }> = [];
const recordingSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const live = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      live.spawn(command).pipe(
        Effect.tap((handle) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand" && command.command === process.execPath)
              spawned.push({ args: command.args, pid: handle.pid });
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));
const engines = () => spawned.filter(({ args }) => args[1] === "lsp");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** When set, captured-content reads after the first `skip` signal `started` and wait for `release`. */
let readGate:
  | { skip: number; started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  | undefined;
const gatedContent = Layer.effect(
  CapturedContent,
  Effect.map(CapturedContent, (real) => ({
    ...real,
    readBlob: (blob: string, range: ByteRange) => {
      const gate = readGate;
      if (gate === undefined || gate.skip-- > 0) return real.readBlob(blob, range);
      return Stream.unwrap(
        Deferred.succeed(gate.started, undefined).pipe(
          Effect.andThen(Deferred.await(gate.release)),
          Effect.as(real.readBlob(blob, range)),
        ),
      );
    },
  })),
).pipe(Layer.provide(CapturedContent.layer));

/** The daemon's real stack over a private data dir: Git, captured content, store, sessions. */
const stack = (dataDir: string) =>
  Navigation.layer.pipe(
    Layer.provideMerge(Sessions.layer),
    Layer.provide(Layer.mergeAll(Git.layer, SessionStore.layer)),
    Layer.provideMerge(gatedContent),
    Layer.provideMerge(Paths.layer),
    Layer.provide(recordingSpawner),
    Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_DATA_DIR: dataDir }))),
  );

/**
 * Runs `effect` against a fresh stack, then checks what closing the stack (daemon shutdown) must
 * leave behind: no engine process and no materialization.
 */
const runReal = async <A, E>(
  dataDir: string,
  effect: Effect.Effect<A, E, Navigation | Sessions | CapturedContent | Paths>,
) => {
  spawned.length = 0;
  const result = await Effect.runPromise(
    Effect.provide(Sessions.use((s) => s.load).pipe(Effect.andThen(effect)), stack(dataDir)),
  );
  expect(engines().filter(({ pid }) => alive(pid))).toEqual([]);
  const navigation = join(dataDir, "navigation");
  if (existsSync(navigation)) expect(await readdir(navigation)).toEqual([]);
  return result;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repo = async (name: string, files: Record<string, string | Uint8Array>) => {
  const cwd = join(dir, name);
  await mkdir(cwd, { recursive: true });
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@gyst.invalid");
  git(cwd, "config", "user.name", "Gyst Test");
  await write(cwd, files);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "initial");
  return cwd;
};
const write = async (cwd: string, files: Record<string, string | Uint8Array>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
};

/** The point (and range) of the `nth` occurrence of `word` on a 1-based LF-delimited line. */
const span = (text: string, line: number, word: string, nth = 0) => {
  const lineText = text.split("\n")[line - 1]!;
  let character = -1;
  for (let index = 0; index <= nth; index++) character = lineText.indexOf(word, character + 1);
  if (character === -1) throw new Error(`no ${word} on line ${line}`);
  return {
    start: { line, character },
    end: { line, character: character + word.length },
  };
};
const at = (text: string, line: number, word: string, nth = 0): TextPoint =>
  span(text, line, word, nth).start;

const definition = (target: Target, position: TextPoint, discovery: AddonDiscovery = addon) =>
  Navigation.use((n) =>
    n.definition({ command: "definition", ...target, position, addon: discovery }),
  );
const references = (target: Target, position: TextPoint) =>
  Navigation.use((n) => n.references({ command: "references", ...target, position, addon }));
const identifiers = (target: Target, line: number) =>
  Navigation.use((n) => n.identifiers({ command: "identifiers", ...target, line, addon }));

const located = (payload: { outcome: { kind: string } }) => {
  if (payload.outcome.kind !== "locations")
    throw new Error(`not locations: ${JSON.stringify(payload.outcome)}`);
  return payload.outcome as Extract<
    Effect.Success<ReturnType<typeof definition>>["outcome"],
    { kind: "locations" }
  >;
};

const oldMath =
  "export function add(first: number, second: number) {\n  return first + second;\n}\n";
const newMath = `// Arithmetic helpers.\nexport const zero = 0;\n${oldMath}`;
const oldUse = 'import { add as plus } from "./math.js";\nexport const three = plus(1, 2);\n';
const newUse =
  'import { add as plus, zero } from "./math.js";\n' +
  "export const three = plus(1, 2) + zero;\n" +
  "export const four = plus(three, 1);\n";
const crlf = 'export const 𐐀name = "𐐀";\r\nexport const twice = 𐐀name + 𐐀name;\r\n';
const libUse = "export const isList = Array.isArray([]);\nconsole.log(isList);\n";
const generatedUse =
  'import { schema } from "./generated/schema.js";\nexport const value = schema;\n';
const tsconfig =
  '{ "compilerOptions": { "module": "nodenext", "strict": true, "noEmit": true } }\n';

describe("Navigation over real captures and the workspace add-on", () => {
  it("answers per side from captured text only, with aliases, parameters, UTF-16 and CRLF exact", async () => {
    const dataDir = join(dir, "data-main");
    const secret = `TOPSECRET-${crypto.randomUUID()}`;
    const cwd = await repo("main", {
      ".gitignore": "src/generated/\n",
      "package.json":
        '{ "name": "fixture", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n',
      "README.md": "# fixture\n",
      "src/math.ts": oldMath,
      "src/use.ts": oldUse,
      "src/lib-use.ts": libUse,
      "src/use-generated.ts": generatedUse,
    });
    await write(cwd, {
      // Only the new side has a project config, so the old side is an inferred project.
      "tsconfig.json": tsconfig,
      "src/math.ts": newMath,
      "src/use.ts": newUse,
      "src/crlf.ts": crlf,
      // Reaches the data dir from the materialized project, never from the checkout.
      "src/secret.ts":
        'import { secret } from "../../../../secret/hidden.js";\nexport const leaked = secret;\n',
      "src/blob.ts": new Uint8Array([0x65, 0, 0x78, 0]),
      // Ignored, so never captured: an import of it is a named gap, not a live read.
      "src/generated/schema.ts": "export const schema = 1;\n",
    });
    await write(dataDir, { "secret/hidden.ts": `export const secret = "${secret}";\n` });

    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        const ids = { session: session.id, snapshotId: session.snapshotId };
        // Ordinary review reads start nothing.
        yield* sessions.diff({ command: "diff", session: session.id });
        yield* sessions.files({ command: "files", ...ids });
        yield* sessions.code({ command: "code", ...ids, file: "src/use.ts", side: "new" });
        const before = yield* sessions.status({ command: "status", session: session.id });
        expect(engines()).toEqual([]);
        expect(existsSync(join(dataDir, "navigation"))).toBe(false);
        yield* Effect.promise(() => rm(cwd, { recursive: true, force: true }));

        const side = (file: string, which: "old" | "new") => ({ ...ids, file, side: which });
        const newUseTarget = side("src/use.ts", "new");
        const oldUseTarget = side("src/use.ts", "old");

        // Definitions resolve per side: `add` moved down two lines in the new side.
        const newDefinition = yield* definition(newUseTarget, at(newUse, 2, "plus"));
        expect(newDefinition).toMatchObject({
          sessionId: session.id,
          snapshotId: session.snapshotId,
          side: "new",
          file: "src/use.ts",
          query: "definition",
          position: at(newUse, 2, "plus"),
        });
        expect(located(newDefinition)).toEqual({
          kind: "locations",
          symbol: { text: "plus", range: span(newUse, 2, "plus") },
          locations: [{ file: "src/math.ts", range: span(newMath, 3, "add") }],
          outside: 0,
          gaps: [
            { kind: "dependencies", file: "package.json" },
            { kind: "uncaptured", file: "src/blob.ts", reason: "binary" },
          ],
        });
        const oldDefinition = located(yield* definition(oldUseTarget, at(oldUse, 2, "plus")));
        expect(oldDefinition.locations).toEqual([
          { file: "src/math.ts", range: span(oldMath, 1, "add") },
        ]);
        expect(oldDefinition.gaps).toEqual([
          { kind: "dependencies", file: "package.json" },
          { kind: "no-project-config" },
        ]);

        // Native alias semantics: the alias and the original are different symbols.
        const plusReferences = located(yield* references(newUseTarget, at(newUse, 2, "plus")));
        expect(plusReferences.locations).toEqual([
          { file: "src/use.ts", range: span(newUse, 1, "plus") },
          { file: "src/use.ts", range: span(newUse, 2, "plus") },
          { file: "src/use.ts", range: span(newUse, 3, "plus") },
        ]);
        const addReferences = located(
          yield* references(side("src/math.ts", "new"), at(newMath, 3, "add")),
        );
        expect(addReferences.symbol).toEqual({ text: "add", range: span(newMath, 3, "add") });
        expect(addReferences.locations).toEqual(
          expect.arrayContaining([
            { file: "src/math.ts", range: span(newMath, 3, "add") },
            { file: "src/use.ts", range: span(newUse, 1, "add") },
          ]),
        );
        expect(addReferences.locations).not.toEqual(plusReferences.locations);
        const oldPlusReferences = located(yield* references(oldUseTarget, at(oldUse, 1, "plus")));
        expect(oldPlusReferences.locations).toEqual([
          { file: "src/use.ts", range: span(oldUse, 1, "plus") },
          { file: "src/use.ts", range: span(oldUse, 2, "plus") },
        ]);

        // Identifiers a line offers: declaration parameters and import names, never keywords,
        // type keywords or words inside a module specifier.
        const parameterLine = yield* identifiers(side("src/math.ts", "new"), 3);
        expect(parameterLine).toMatchObject({
          sessionId: session.id,
          snapshotId: session.snapshotId,
          side: "new",
          file: "src/math.ts",
          line: 3,
        });
        expect(parameterLine.outcome).toMatchObject({
          kind: "identifiers",
          identifiers: [
            { text: "add", range: span(newMath, 3, "add") },
            { text: "first", range: span(newMath, 3, "first") },
            { text: "second", range: span(newMath, 3, "second") },
          ],
        });
        const importLine = yield* identifiers(newUseTarget, 1);
        expect(importLine.outcome.kind === "identifiers" && importLine.outcome.identifiers).toEqual(
          [
            { text: "add", range: span(newUse, 1, "add") },
            { text: "plus", range: span(newUse, 1, "plus") },
            { text: "zero", range: span(newUse, 1, "zero") },
          ],
        );

        // UTF-16 and CRLF end to end: an astral identifier before the cursor, CR before each LF.
        const crlfTarget = side("src/crlf.ts", "new");
        const astral = located(yield* references(crlfTarget, at(crlf, 2, "𐐀name", 1)));
        expect(at(crlf, 2, "𐐀name", 1)).toEqual({ line: 2, character: 30 });
        expect(astral.symbol).toEqual({ text: "𐐀name", range: span(crlf, 2, "𐐀name", 1) });
        expect(astral.locations).toEqual([
          { file: "src/crlf.ts", range: span(crlf, 1, "𐐀name") },
          { file: "src/crlf.ts", range: span(crlf, 2, "𐐀name") },
          { file: "src/crlf.ts", range: span(crlf, 2, "𐐀name", 1) },
        ]);
        const crlfLine = yield* identifiers(crlfTarget, 2);
        expect(crlfLine.outcome.kind === "identifiers" && crlfLine.outcome.identifiers).toEqual([
          { text: "twice", range: span(crlf, 2, "twice") },
          { text: "𐐀name", range: span(crlf, 2, "𐐀name") },
          { text: "𐐀name", range: span(crlf, 2, "𐐀name", 1) },
        ]);

        // A missing generated input is named, even when nothing is found.
        const generated = located(
          yield* references(side("src/use-generated.ts", "new"), at(generatedUse, 2, "schema")),
        );
        expect(generated.gaps).toContainEqual({
          kind: "unresolved-import",
          file: "src/use-generated.ts",
          message: 'cannot resolve "./generated/schema.js" (TS2307)',
        });

        // Targets outside the capture are counted, never named or read back.
        const lib = located(
          yield* definition(side("src/lib-use.ts", "new"), at(libUse, 2, "console")),
        );
        expect(lib).toMatchObject({ locations: [], symbol: { text: "console" } });
        expect(lib.outside).toBeGreaterThanOrEqual(1);
        const leaked = yield* definition(side("src/secret.ts", "new"), { line: 2, character: 22 });
        expect(located(leaked)).toMatchObject({ symbol: { text: "secret" }, locations: [] });
        expect(located(leaked).outside).toBeGreaterThanOrEqual(1);
        const leakedReferences = yield* references(side("src/secret.ts", "new"), {
          line: 1,
          character: 9,
        });
        for (const payload of [lib, leaked, leakedReferences]) {
          const json = JSON.stringify(payload);
          expect(json).not.toContain(secret);
          expect(json).not.toContain(dataDir);
          expect(json).not.toContain("lib.dom");
          expect(json).not.toContain("node_modules");
        }

        // Sides and files with no captured TS/JS text are not analysed.
        const notSource = (target: Target, detail: string) =>
          definition(target, { line: 1, character: 0 }).pipe(
            Effect.map(({ outcome }) =>
              expect(outcome).toEqual({
                kind: "unavailable",
                reason: { kind: "not-source", detail },
              }),
            ),
          );
        yield* notSource(side("src/crlf.ts", "old"), "src/crlf.ts has no old side");
        yield* notSource(
          side("README.md", "new"),
          "README.md is not a TypeScript or JavaScript source",
        );
        yield* notSource(
          side("src/blob.ts", "new"),
          "the new side of src/blob.ts was not captured as text (binary)",
        );
        // No identifier at the position: nothing is asked of the engine.
        expect((yield* definition(newUseTarget, at(newUse, 2, "= "))).outcome).toEqual({
          kind: "no-symbol",
        });
        expect((yield* definition(newUseTarget, at(newUse, 2, "export"))).outcome).toEqual({
          kind: "no-symbol",
        });
        expect(
          yield* Effect.flip(definition(newUseTarget, { line: 2, character: 999 })),
        ).toMatchObject({ _tag: "bad_args" });
        expect(yield* Effect.flip(identifiers(newUseTarget, 4))).toMatchObject({
          _tag: "bad_args",
        });
        expect(
          yield* Effect.flip(definition(side("src/none.ts", "new"), { line: 1, character: 0 })),
        ).toMatchObject({ _tag: "validation_failed" });

        // One engine per side served every query, and navigation changed no review state.
        expect(engines().map(({ args }) => args.slice(1))).toEqual([
          ["lsp", "--expect", daemonVersion],
          ["lsp", "--expect", daemonVersion],
        ]);
        expect(engines().every(({ pid }) => alive(pid))).toBe(true);
        expect(yield* sessions.status({ command: "status", session: session.id })).toEqual(before);
      }),
    );
  }, 120_000);

  it("refuses a historical snapshot, before and during a query, and keeps no engine for it", async () => {
    const dataDir = join(dir, "data-historical");
    const cwd = await repo("historical", { "src/math.ts": oldMath, "src/use.ts": oldUse });
    const changed = `${oldUse}export const four = plus(three, 1);\n`;
    await write(cwd, { "src/use.ts": changed });
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const navigation = yield* Navigation;
        const { session } = yield* sessions.open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        const first = { session: session.id, snapshotId: session.snapshotId };
        const target = { ...first, file: "src/use.ts", side: "old" } as const;
        expect(located(yield* definition(target, at(oldUse, 2, "plus"))).locations).toHaveLength(1);

        // A query in flight across a refresh: held reading its captured text, released after.
        const held = {
          skip: 0,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        readGate = held;
        const inFlight = yield* Effect.forkChild(
          references({ ...target, side: "new" }, at(oldUse, 2, "plus")),
        );
        yield* Deferred.await(held.started);
        readGate = undefined;
        yield* Effect.promise(() =>
          writeFile(join(cwd, "src/use.ts"), `${changed}export const five = 5;\n`),
        );
        const refreshed = yield* sessions.refresh({ command: "refresh", session: session.id });
        const current = refreshed.session.snapshotId;
        expect(current).not.toBe(session.snapshotId);
        yield* navigation.retire(session.id, current);
        yield* Deferred.succeed(held.release, undefined);
        expect((yield* Fiber.join(inFlight)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "historical" },
        });
        // The retired snapshot's engine is gone and its materialization removed.
        expect(engines().filter(({ pid }) => alive(pid))).toEqual([]);
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toEqual([]);

        const historical = yield* definition(target, at(oldUse, 2, "plus"));
        expect(historical).toMatchObject({
          snapshotId: session.snapshotId,
          outcome: { kind: "unavailable", reason: { kind: "historical" } },
        });
        expect((yield* identifiers({ ...target, snapshotId: "f".repeat(64) }, 1)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "historical" },
        });
        const engineCount = engines().length;
        // The current snapshot still works, on a fresh engine.
        const now = located(
          yield* definition({ ...target, snapshotId: current, side: "new" }, at(oldUse, 2, "plus")),
        );
        expect(now.locations).toEqual([{ file: "src/math.ts", range: span(oldMath, 1, "add") }]);
        expect(engines()).toHaveLength(engineCount + 1);
      }),
    );
  }, 120_000);

  it("reports add-on problems with the exact install command, including a release replaced after discovery", async () => {
    const dataDir = join(dir, "data-addon");
    const cwd = await repo("addon", { "src/math.ts": oldMath, "src/use.ts": oldUse });
    // A copy of the real add-on whose version changed after the launcher validated it.
    const replaced = join(dir, "replaced-addon");
    await mkdir(join(replaced, "src"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(addonDir, "package.json"), "utf8"));
    await writeFile(
      join(replaced, "package.json"),
      JSON.stringify({ ...manifest, version: "0.0.1" }),
    );
    await cp(addon.entry, join(replaced, "src", "cli.js"));
    await symlink(join(addonDir, "node_modules"), join(replaced, "node_modules"));
    const replacedEntry = await realpath(join(replaced, "src", "cli.js"));

    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        const target = {
          session: session.id,
          snapshotId: session.snapshotId,
          file: "src/use.ts",
          side: "new",
        } as const;
        const position = at(oldUse, 2, "plus");
        const unavailable = (discovery: AddonDiscovery) =>
          definition(target, position, discovery).pipe(Effect.map(({ outcome }) => outcome));
        expect(yield* unavailable({ kind: "missing" })).toEqual({
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "missing", install } },
        });
        expect(yield* unavailable({ kind: "mismatched", found: "0.0.1" })).toEqual({
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "mismatched", found: "0.0.1", install } },
        });
        expect(yield* unavailable({ kind: "unusable", reason: "no engine" })).toEqual({
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "unusable", reason: "no engine", install } },
        });
        // A discovery from another gyst release is refused without running it.
        expect(yield* unavailable({ ...addon, version: "0.0.1" })).toEqual({
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "mismatched", found: "0.0.1", install } },
        });
        expect(spawned).toEqual([]);

        // `lsp --expect` refuses; the daemon's own handshake names what is installed now.
        expect(yield* unavailable({ ...addon, entry: replacedEntry })).toEqual({
          kind: "unavailable",
          reason: { kind: "addon", addon: { kind: "mismatched", found: "0.0.1", install } },
        });
        expect(spawned.map(({ args }) => args.slice(1))).toEqual([
          ["lsp", "--expect", daemonVersion],
          ["--version"],
        ]);
        // Nothing is kept from the failed start: the right add-on works at once.
        expect(located(yield* definition(target, position)).locations).toEqual([
          { file: "src/math.ts", range: span(oldMath, 1, "add") },
        ]);
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toHaveLength(1);
      }),
    );
  }, 120_000);

  it("tears down a preparation the session's deletion overtakes, leaving no engine or files", async () => {
    const dataDir = join(dir, "data-delete");
    const cwd = await repo("delete", { "src/math.ts": oldMath, "src/use.ts": oldUse });
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const navigation = yield* Navigation;
        const { session } = yield* sessions.open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        const target = {
          session: session.id,
          snapshotId: session.snapshotId,
          file: "src/use.ts",
          side: "new",
        } as const;
        // The query reads its own text, then preparation copies the side and is held there.
        const held = {
          skip: 1,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        readGate = held;
        const query = yield* Effect.forkChild(definition(target, at(oldUse, 2, "plus")));
        yield* Deferred.await(held.started);
        readGate = undefined;
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toHaveLength(1);
        yield* sessions.delete({ command: "delete", session: session.id, requestId: "r1" });
        yield* navigation.retire(session.id);
        expect(yield* Effect.flip(Fiber.join(query))).toMatchObject({ _tag: "no_session" });
        expect(engines()).toEqual([]);
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toEqual([]);
      }),
    );
  }, 60_000);

  it("removes a crashed daemon's leftovers on first use, not when the layer is built", async () => {
    const dataDir = join(dir, "data-leftovers");
    const cwd = await repo("leftovers", { "src/math.ts": oldMath, "src/use.ts": oldUse });
    const leftover = join(dataDir, "navigation", "crashed", "project", "a.ts");
    await write(dataDir, { "navigation/crashed/project/a.ts": "export {};\n" });
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* sessions.open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        // A contender that never owns the socket builds the layer too; it must touch nothing.
        expect(existsSync(leftover)).toBe(true);
        yield* definition(
          { session: session.id, snapshotId: session.snapshotId, file: "src/use.ts", side: "old" },
          at(oldUse, 2, "plus"),
        );
        expect(existsSync(leftover)).toBe(false);
      }),
    );
  }, 60_000);
});
