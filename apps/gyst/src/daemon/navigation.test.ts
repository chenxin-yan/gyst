import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AddonDiscovery,
  type ByteRange,
  navigationInstallCommand,
  type BrowserRequest,
  SourceUnavailable,
  type TextPoint,
} from "@gyst/core";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schedule,
  Scope,
  Stream,
} from "effect";
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
import { noGitHub } from "./capture-doubles.ts";
import { CapturedContent } from "./content.ts";
import { Git } from "./git.ts";
import {
  Navigation,
  navigationPolicy,
  NavigationPolicy,
  type NavigationPolicy as Policy,
} from "./navigation.ts";
import { Paths } from "./paths.ts";
import { daemonVersion } from "./protocol.ts";
import { Sessions } from "./sessions.ts";
import { SessionStore } from "./store.ts";

type Input<C extends BrowserRequest["command"]> = Extract<BrowserRequest, { readonly command: C }>;
type Target = Pick<Input<"definition">, "session" | "snapshotId" | "side" | "file">;

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const addonDir = join(repoRoot, "packages", "navigation-typescript");
const addon = {
  kind: "available",
  entry: realpathSync(join(addonDir, "src", "cli.ts")),
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

/**
 * When set, captured-content reads (of the `only` blobs, if given) after the first `skip` signal
 * `started`, count themselves in `held` and wait for `release`.
 */
let readGate:
  | {
      skip: number;
      only?: ReadonlySet<string>;
      held?: number;
      started: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
    }
  | undefined;
/** How many blob writes still fail as out of space before writes succeed again. */
let outOfSpace = 0;
/** When set, the next load of `snapshotId`'s manifest signals `started`, then waits for `release`. */
let manifestGate:
  | { snapshotId: string; started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  | undefined;
const gatedContent = Layer.effect(
  CapturedContent,
  Effect.map(CapturedContent, (real) => ({
    ...real,
    loadManifest: (snapshotId: string) => {
      const gate = manifestGate;
      if (gate?.snapshotId !== snapshotId) return real.loadManifest(snapshotId);
      manifestGate = undefined;
      return Deferred.succeed(gate.started, undefined).pipe(
        Effect.andThen(Deferred.await(gate.release)),
        Effect.andThen(real.loadManifest(snapshotId)),
      );
    },
    putBlob: <E>(bytes: Stream.Stream<Uint8Array, E>) => {
      if (outOfSpace === 0) return real.putBlob(bytes);
      outOfSpace--;
      return Effect.fail(
        new SourceUnavailable({
          message: "gyst's data directory is out of space",
          detail: { reason: "storage_full" },
        }),
      );
    },
    readBlob: (blob: string, range: ByteRange) => {
      const gate = readGate;
      if (gate === undefined || (gate.only && !gate.only.has(blob)) || gate.skip-- > 0)
        return real.readBlob(blob, range);
      gate.held = (gate.held ?? 0) + 1;
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
const stack = (dataDir: string, policy: Policy = navigationPolicy) =>
  Navigation.layer.pipe(
    Layer.provide(Layer.succeed(NavigationPolicy, policy)),
    Layer.provideMerge(Sessions.layer),
    Layer.provide(Layer.mergeAll(Git.layer, noGitHub, SessionStore.layer)),
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
  policy?: Policy,
) => {
  spawned.length = 0;
  const result = await Effect.runPromise(
    Effect.provide(
      Sessions.use((s) => s.load).pipe(Effect.andThen(effect)),
      stack(dataDir, policy),
    ),
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
  it("names no location in a config confinement rewrote, whose engine coordinates are not the captured text's", async () => {
    const settings =
      '{\n  "extends": "../outside.json",\n  "marker": 1,\n  "padding": "xxxxxxxxxxxxxxxx"\n}\n';
    const use = 'import settings from "./settings.json";\nexport const result = settings.marker;\n';
    const plain = '{ "other": 2 }\n';
    const kept = 'import plain from "./plain.json";\nexport const other = plain.other;\n';
    const cwd = await repo("rewritten-config", { "README.md": "# fixture\n" });
    await write(cwd, {
      "tsconfig.json": JSON.stringify({
        extends: "./settings.json",
        compilerOptions: { module: "esnext", moduleResolution: "bundler", resolveJsonModule: true },
      }),
      "settings.json": settings,
      "plain.json": plain,
      "use.ts": use,
      "kept.ts": kept,
    });
    const dataDir = join(dir, "rewritten-config-data");
    const [rewritten, untouched] = await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session } = yield* Sessions.use((s) =>
          s.open({ command: "open", cwd, scope: { kind: "uncommitted" } }),
        );
        const target = {
          session: session.id,
          snapshotId: session.snapshotId,
          side: "new",
        } as const;
        return [
          yield* definition({ ...target, file: "use.ts" }, at(use, 2, "marker")),
          yield* definition({ ...target, file: "kept.ts" }, at(kept, 2, "other", 1)),
        ];
      }),
    );
    // Dropping its escaping `extends` moved "marker" up a line in the engine's copy.
    expect(located(rewritten)).toMatchObject({ locations: [], outside: 1 });
    expect(located(untouched)).toMatchObject({
      locations: [{ file: "plain.json", range: span(plain, 1, '"other"') }],
      outside: 0,
    });
  });

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
        // No name at the position: punctuation, or a keyword.
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

  it("queries keyword-named members but not keywords, and names JavaScript's missing imports", async () => {
    const dataDir = join(dir, "data-keywords");
    const keys =
      "export const handlers = { delete() {}, default: 1 };\n" +
      "handlers.delete();\n" +
      "export class Box {\n" +
      "  catch() { return this; }\n" +
      "}\n" +
      "new Box().catch();\n";
    const script =
      'import { schema } from "./generated/schema.js";\n' +
      'import { here } from "./present.js";\n' +
      'import pad from "left-pad";\n' +
      "import { extra } from\n" +
      '  "./generated/extra.js";\n' +
      '// import "./commented.js";\n' +
      "export const value = pad(schema + here);\n";
    const cwd = await repo("keywords", {
      ".gitignore": "src/generated/\n",
      "jsconfig.json": "{}\n",
      "src/present.js": "export const here = 1;\n",
    });
    await write(cwd, {
      "src/keys.ts": keys,
      "src/script.js": script,
      // Ignored, so never captured.
      "src/generated/schema.js": "export const schema = 1;\n",
      "src/generated/extra.js": "export const extra = 1;\n",
    });

    await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session } = yield* (yield* Sessions).open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        const target = (file: string) => ({
          session: session.id,
          snapshotId: session.snapshotId,
          file,
          side: "new" as const,
        });
        const keysTarget = target("src/keys.ts");

        // A reserved word as a member name is the engine's symbol, declaration and use alike.
        const deleteDefinition = located(yield* definition(keysTarget, at(keys, 2, "delete")));
        expect(deleteDefinition).toMatchObject({
          symbol: { text: "delete", range: span(keys, 2, "delete") },
          locations: [{ file: "src/keys.ts", range: span(keys, 1, "delete") }],
        });
        expect(located(yield* references(keysTarget, at(keys, 1, "delete"))).locations).toEqual([
          { file: "src/keys.ts", range: span(keys, 1, "delete") },
          { file: "src/keys.ts", range: span(keys, 2, "delete") },
        ]);
        expect(located(yield* definition(keysTarget, at(keys, 6, "catch"))).locations).toEqual([
          { file: "src/keys.ts", range: span(keys, 4, "catch") },
        ]);
        // The keywords themselves stay unqueried, though the engine resolves `return` and `this`.
        for (const word of ["return", "this"])
          expect((yield* definition(keysTarget, at(keys, 4, word))).outcome).toEqual({
            kind: "no-symbol",
          });
        const offered = (line: number) =>
          identifiers(keysTarget, line).pipe(
            Effect.map(({ outcome }) =>
              outcome.kind === "identifiers"
                ? outcome.identifiers.map(({ text }) => text)
                : outcome,
            ),
          );
        expect(yield* offered(1)).toEqual(["handlers", "delete", "default"]);
        expect(yield* offered(4)).toEqual(["catch"]);
        expect(yield* offered(6)).toEqual(["Box", "catch"]);

        // Without checkJs the engine reports no unresolved import in JavaScript; each is named.
        const scriptResult = located(
          yield* references(target("src/script.js"), at(script, 7, "schema")),
        );
        expect(scriptResult.gaps).toEqual([
          {
            kind: "unresolved-import",
            file: "src/script.js",
            message: 'cannot resolve "./generated/schema.js"',
          },
          {
            kind: "unresolved-import",
            file: "src/script.js",
            message: 'cannot resolve "left-pad"',
          },
          // A specifier on the line after its `from` is probed too.
          {
            kind: "unresolved-import",
            file: "src/script.js",
            message: 'cannot resolve "./generated/extra.js"',
          },
        ]);
      }),
    );
  }, 120_000);

  // The engine percent-encodes every character of a file URI but the unreserved ones, and answers
  // document highlights only for a document opened under exactly that URI.
  it("offers a line's identifiers in files whose names the engine percent-encodes", async () => {
    const dataDir = join(dir, "data-encoded");
    const source = "export const one = 1;\nexport const two = one + 1;\n";
    const files = [
      "src/routes/session.$sessionId.ts",
      "app/(marketing)/[slug]/page.ts",
      "src/@scope/a+b,c;d=e&f!g'h*i~j.ts",
    ];
    const cwd = await repo("encoded", { "tsconfig.json": tsconfig });
    await write(cwd, Object.fromEntries(files.map((file) => [file, source])));
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session } = yield* (yield* Sessions).open({
          command: "open",
          cwd,
          scope: { kind: "uncommitted" },
        });
        for (const file of files) {
          const target = {
            session: session.id,
            snapshotId: session.snapshotId,
            file,
            side: "new" as const,
          };
          const { outcome } = yield* identifiers(target, 2);
          expect(
            outcome.kind === "identifiers" && outcome.identifiers.map(({ text }) => text),
            file,
          ).toEqual(["two", "one"]);
          expect(located(yield* definition(target, at(source, 2, "one"))).locations).toEqual([
            { file, range: span(source, 1, "one") },
          ]);
        }
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
        const current = (yield* sessions.refresh({
          command: "refresh",
          session: session.id,
          snapshotId: session.snapshotId,
          requestId: "refresh",
        })).snapshotId;
        expect(current).not.toBe(session.snapshotId);
        yield* navigation.retire(session.id, current);
        // A late retirement for the replaced snapshot, as a replayed refresh reply asks, keeps the
        // current one.
        yield* navigation.retire(session.id, session.snapshotId);
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
    // A copy of the real add-on whose version changed after discovery validated it.
    const replaced = join(dir, "replaced-addon");
    await mkdir(join(replaced, "src"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(addonDir, "package.json"), "utf8"));
    await writeFile(
      join(replaced, "package.json"),
      JSON.stringify({ ...manifest, version: "0.0.1" }),
    );
    await cp(addon.entry, join(replaced, "src", "cli.ts"));
    await symlink(join(addonDir, "node_modules"), join(replaced, "node_modules"));
    const replacedEntry = await realpath(join(replaced, "src", "cli.ts"));

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

  it("answers alike whatever the host holds outside the capture, or refuses what it cannot keep out", async () => {
    // The test owns every directory between the data dir and the shared temporary directory.
    const host = join(dir, "isolation");
    const dataDir = join(host, "data");
    const live = join(host, "live-dep.ts");
    const use =
      'import { value } from "dep";\n' +
      'import { scoped } from "#scoped";\n' +
      'import { left } from "left";\n' +
      "export const result = value + scoped + left;\n";
    const dep = "export const value = 1;\n";
    const cwd = await repo("isolation-repo", { "README.md": "# fixture\n" });
    await write(cwd, {
      // A `paths` fallback the engine would try first, outside the capture.
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          paths: { dep: [live, "./dep.ts"] },
        },
      }),
      "dep.ts": dep,
      "use.ts": use,
    });
    const { session } = await runReal(
      dataDir,
      Effect.flatMap(Sessions, (sessions) =>
        sessions.open({ command: "open", cwd, scope: { kind: "uncommitted" } }),
      ),
    );
    const target = {
      session: session.id,
      snapshotId: session.snapshotId,
      file: "use.ts",
      side: "new",
    } as const;
    // Each state of the host gets fresh engines.
    const answers = () =>
      runReal(
        dataDir,
        Effect.all(
          [
            definition(target, at(use, 4, "value")),
            definition(target, at(use, 4, "scoped")),
            references(target, at(use, 4, "left")),
            identifiers(target, 4),
          ],
          { concurrency: 1 },
        ).pipe(Effect.map((payloads) => payloads.map(({ outcome }) => outcome))),
      );

    const clean = await answers();
    expect(located({ outcome: clean[0]! })).toEqual({
      kind: "locations",
      symbol: { text: "value", range: span(use, 4, "value") },
      locations: [{ file: "dep.ts", range: span(dep, 1, "value") }],
      outside: 0,
      gaps: [
        {
          kind: "unresolved-import",
          file: "tsconfig.json",
          message: `cannot resolve paths "dep" ${JSON.stringify(live)}`,
        },
        {
          kind: "unresolved-import",
          file: "use.ts",
          message: 'cannot resolve "#scoped" (TS2307)',
        },
        { kind: "unresolved-import", file: "use.ts", message: 'cannot resolve "left" (TS2307)' },
      ],
    });

    // A host file the config names, and a package.json above the layout scoping `#scoped`.
    await writeFile(live, "export const value = 2;\n");
    await writeFile(
      join(host, "package.json"),
      JSON.stringify({ type: "module", imports: { "#scoped": "./scoped.ts" } }),
    );
    await writeFile(join(host, "scoped.ts"), "export const scoped = 1;\n");
    expect(await answers()).toEqual(clean);
    await writeFile(live, "export const other = 2;\nexport const value = 3;\n");
    await writeFile(join(host, "scoped.ts"), "export const scoped = 2;\n");
    expect(await answers()).toEqual(clean);
    for (const file of [live, join(host, "package.json"), join(host, "scoped.ts")]) await rm(file);
    expect(await answers()).toEqual(clean);

    // No option stops the engine looking up `node_modules` above the layout: navigation refuses.
    for (const lookup of ["node_modules/left/index.d.ts", "tsconfig.json"]) {
      await write(host, { [lookup]: lookup.endsWith(".ts") ? "export const left = 1;\n" : "{}\n" });
      const refused = {
        kind: "unavailable",
        reason: {
          kind: "engine",
          message:
            `the engine would read a ${lookup.split("/")[0]} in or above gyst's data ` +
            "directory, which is not captured; remove it, or set GYST_DATA_DIR elsewhere",
        },
      };
      expect(await answers()).toEqual([refused, refused, refused, refused]);
      expect(engines()).toEqual([]);
      await rm(join(host, lookup.split("/")[0]!), { recursive: true });
    }
    expect(await answers()).toEqual(clean);
  }, 120_000);

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

const readiness = (session: string, snapshotId: string, discovery: AddonDiscovery = addon) =>
  Navigation.use((n) => n.status({ command: "navigation", session, snapshotId, addon: discovery }));
/** Repeats `check` until it holds, failing the test after 20 seconds. */
const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("20 seconds"),
  );
const liveEngines = () => engines().filter(({ pid }) => alive(pid));
const hold = Effect.fnUntraced(function* (only?: ReadonlySet<string>, skip = 0) {
  const gate: NonNullable<typeof readGate> = {
    skip,
    ...(only ? { only } : {}),
    started: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  readGate = gate;
  return gate;
});
/** A session over a repository whose `src/math.ts` and `src/use.ts` changed: both sides exist. */
const changedSession = Effect.fnUntraced(function* (cwd: string) {
  const sessions = yield* Sessions;
  const { session } = yield* sessions.open({
    command: "open",
    cwd,
    scope: { kind: "uncommitted" },
  });
  const { manifest } = yield* sessions.snapshot({
    session: session.id,
    snapshotId: session.snapshotId,
  });
  const blob = (file: string, side: "old" | "new") => {
    const captured = manifest.files.find(({ path }) => path === file)![side];
    if (captured.kind !== "text") throw new Error(`${file} has no ${side} text`);
    return captured.blob;
  };
  const target = (side: "old" | "new") =>
    ({ session: session.id, snapshotId: session.snapshotId, file: "src/use.ts", side }) as const;
  return { session, blob, target };
});
const changedRepo = async (name: string) => {
  const cwd = await repo(name, { "src/math.ts": oldMath, "src/use.ts": oldUse });
  await write(cwd, { "src/math.ts": newMath, "src/use.ts": newUse });
  return cwd;
};
const plusAt = (side: "old" | "new") => at(side === "old" ? oldUse : newUse, 2, "plus");

describe("Navigation lifecycle", () => {
  it("defaults to two engines, a 60 second idle expiry and a 2 minute query bound", () => {
    expect(navigationPolicy).toEqual({ engines: 2, idle: "60 seconds", query: "2 minutes" });
  });

  it("reports readiness without starting anything", async () => {
    const dataDir = join(dir, "data-status");
    const cwd = await changedRepo("status");
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const { session } = yield* changedSession(cwd);
        expect(yield* readiness(session.id, session.snapshotId)).toEqual({
          sessionId: session.id,
          snapshotId: session.snapshotId,
          addon: { kind: "available", version: daemonVersion },
          sides: { old: { kind: "stopped" }, new: { kind: "stopped" } },
        });
        const missing = { kind: "addon", addon: { kind: "missing", install } } as const;
        expect(yield* readiness(session.id, session.snapshotId, { kind: "missing" })).toEqual({
          sessionId: session.id,
          snapshotId: session.snapshotId,
          addon: { kind: "missing", install },
          sides: {
            old: { kind: "unavailable", reason: missing },
            new: { kind: "unavailable", reason: missing },
          },
        });
        expect(
          (yield* readiness(session.id, session.snapshotId, { ...addon, version: "0.0.1" })).addon,
        ).toEqual({ kind: "mismatched", found: "0.0.1", install });
        const historical = { kind: "unavailable", reason: { kind: "historical" } };
        expect((yield* readiness(session.id, "f".repeat(64))).sides).toEqual({
          old: historical,
          new: historical,
        });
        expect(spawned).toEqual([]);
        expect(existsSync(join(dataDir, "navigation"))).toBe(false);
        yield* sessions.delete({ command: "delete", session: session.id, requestId: "r1" });
        expect(yield* Effect.flip(readiness(session.id, session.snapshotId))).toMatchObject({
          _tag: "no_session",
        });
      }),
    );
  }, 60_000);

  it("keeps at most two engines across sessions, evicting the least recently used idle one and queueing while both are busy", async () => {
    const dataDir = join(dir, "data-capacity");
    const [cwdA, cwdB] = [await changedRepo("capacity-a"), await changedRepo("capacity-b")];
    await runReal(
      dataDir,
      Effect.gen(function* () {
        let most = 0;
        const monitor = yield* Effect.forkChild(
          Effect.sync(() => {
            most = Math.max(most, liveEngines().length);
          }).pipe(Effect.repeat(Schedule.spaced("2 millis"))),
        );
        const a = yield* changedSession(cwdA);
        const b = yield* changedSession(cwdB);
        const sides = (of: typeof a) =>
          Effect.map(readiness(of.session.id, of.session.snapshotId), ({ sides }) => sides);
        const engineOf = (args: number) => engines()[args]!.pid;

        // The old side of A is used first, so it is the least recently used once both are idle.
        expect(located(yield* definition(a.target("old"), plusAt("old"))).locations).toHaveLength(
          1,
        );
        expect(located(yield* definition(a.target("new"), plusAt("new"))).locations).toHaveLength(
          1,
        );
        const [aOld, aNew] = [engineOf(0), engineOf(1)];
        expect(yield* sides(a)).toEqual({
          old: {
            kind: "ready",
            files: 2,
            bytes: oldMath.length + oldUse.length,
            gaps: [{ kind: "no-project-config" }],
          },
          new: {
            kind: "ready",
            files: 2,
            bytes: newMath.length + newUse.length,
            gaps: [{ kind: "no-project-config" }],
          },
        });
        // A third key stops A's old engine rather than starting a third.
        expect(located(yield* definition(b.target("new"), plusAt("new"))).locations).toHaveLength(
          1,
        );
        const bNew = engineOf(2);
        expect(alive(aOld)).toBe(false);
        expect(liveEngines().map(({ pid }) => pid)).toEqual([aNew, bNew]);
        expect((yield* sides(a)).old).toEqual({ kind: "stopped" });

        // Both engines busy (each query held reading its target's text): a third key waits.
        const busy = yield* hold(
          new Set([a.blob("src/math.ts", "new"), b.blob("src/math.ts", "new")]),
        );
        const q1 = yield* Effect.forkChild(definition(a.target("new"), plusAt("new")));
        const q2 = yield* Effect.forkChild(definition(b.target("new"), plusAt("new")));
        yield* until(Effect.sync(() => busy.held === 2));
        readGate = undefined;
        const q3 = yield* Effect.forkChild(definition(a.target("old"), plusAt("old")));
        yield* until(Effect.map(sides(a), ({ old }) => old.kind === "queued"));
        yield* Effect.sleep("200 millis");
        expect((yield* sides(a)).old).toEqual({ kind: "queued" });
        expect(liveEngines().map(({ pid }) => pid)).toEqual([aNew, bNew]);
        // Review reads are not held up meanwhile.
        yield* (yield* Sessions)
          .status({ command: "status", session: a.session.id })
          .pipe(Effect.timeout("2 seconds"));

        yield* Deferred.succeed(busy.release, undefined);
        for (const query of [q1, q2, q3])
          expect(located(yield* Fiber.join(query)).locations).toHaveLength(1);
        expect(engines()).toHaveLength(4);
        expect(liveEngines()).toHaveLength(2);
        expect((yield* sides(a)).old).toMatchObject({ kind: "ready" });
        yield* Fiber.interrupt(monitor);
        expect(most).toBe(2);
      }),
    );
  }, 120_000);

  it("holds captured content from choosing a snapshot to reading it, so a reclaim meanwhile waits", async () => {
    const dataDir = join(dir, "data-select");
    const cwdA = await changedRepo("select-a");
    const cwdB = await changedRepo("select-b");
    await write(cwdB, { "src/other.ts": "export {};\n" });
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const a = yield* changedSession(cwdA);
        // The one-entry manifest cache now holds B's, so the query loads A's again.
        yield* changedSession(cwdB);
        const gate = {
          snapshotId: a.session.snapshotId,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        manifestGate = gate;
        const query = yield* Effect.forkChild(definition(a.target("new"), plusAt("new")));
        yield* Deferred.await(gate.started);
        yield* Effect.promise(() => write(cwdA, { "src/use.ts": `${newUse}// later\n` }));
        yield* sessions.refresh({
          command: "refresh",
          session: a.session.id,
          snapshotId: a.session.snapshotId,
          requestId: "later",
        });
        let reclaimed = false;
        const reclaiming = yield* Effect.forkChild(
          sessions.reclaim.pipe(Effect.tap(() => Effect.sync(() => (reclaimed = true)))),
        );
        yield* Effect.sleep("50 millis");
        expect(reclaimed).toBe(false);
        yield* Deferred.succeed(gate.release, undefined);
        expect((yield* Fiber.join(query)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "historical" },
        });
        yield* Fiber.join(reclaiming);
      }),
    );
  }, 60_000);

  it("drops a crashed daemon's leftovers and idle engines, never an active one, before a capture refuses for space", async () => {
    const dataDir = join(dir, "data-space");
    const leftover = join(dataDir, "navigation", "crashed", "project", "a.ts");
    await write(dataDir, { "navigation/crashed/project/a.ts": "export {};\n" });
    const cwds = [];
    for (const name of ["space-a", "space-b", "space-c"]) cwds.push(await changedRepo(name));
    const [cwdA, cwdB, cwdC] = cwds as [string, string, string];
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const open = (cwd: string) =>
          sessions.open({ command: "open", cwd, scope: { kind: "uncommitted" } });
        const a = yield* changedSession(cwdA);
        outOfSpace = 1;
        yield* open(cwdB);
        expect(outOfSpace).toBe(0);
        expect(existsSync(leftover)).toBe(false);

        expect(located(yield* definition(a.target("old"), plusAt("old"))).locations).toHaveLength(
          1,
        );
        const idle = engines()[0]!.pid;
        const busy = yield* hold(new Set([a.blob("src/math.ts", "new")]));
        const query = yield* Effect.forkChild(definition(a.target("new"), plusAt("new")));
        yield* Deferred.await(busy.started);
        readGate = undefined;
        outOfSpace = 1;
        // The reclaim after the drop waits for the active query's read; the idle engine is gone.
        const opening = yield* Effect.forkChild(open(cwdC));
        yield* until(Effect.sync(() => !alive(idle)));
        expect((yield* readiness(a.session.id, a.session.snapshotId)).sides.old).toEqual({
          kind: "stopped",
        });
        yield* Deferred.succeed(busy.release, undefined);
        expect(located(yield* Fiber.join(query)).locations).toHaveLength(1);
        yield* Fiber.join(opening);
        expect(outOfSpace).toBe(0);
      }),
    );
  }, 60_000);

  it("expires an idle engine, but never while a query is active", async () => {
    const dataDir = join(dir, "data-idle");
    const cwd = await changedRepo("idle");
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session, blob, target } = yield* changedSession(cwd);
        const sideNew = Effect.map(
          readiness(session.id, session.snapshotId),
          ({ sides }) => sides.new,
        );
        expect(located(yield* definition(target("new"), plusAt("new"))).locations).toHaveLength(1);
        const first = engines()[0]!.pid;
        expect((yield* sideNew).kind).toBe("ready");
        yield* until(Effect.map(sideNew, ({ kind }) => kind === "stopped"));
        // Its teardown finishes just after: the engine exits, then its copy is removed.
        yield* until(
          Effect.promise(() => readdir(join(dataDir, "navigation"))).pipe(
            Effect.map((left) => left.length === 0 && !alive(first)),
          ),
        );

        // A query that starts on an idle engine and is held well past the idle time keeps it.
        expect(located(yield* definition(target("new"), plusAt("new"))).locations).toHaveLength(1);
        const second = engines()[1]!.pid;
        const held = yield* hold(new Set([blob("src/math.ts", "new")]));
        const query = yield* Effect.forkChild(definition(target("new"), plusAt("new")));
        yield* Deferred.await(held.started);
        readGate = undefined;
        yield* Effect.sleep("900 millis");
        expect(engines()).toHaveLength(2);
        expect(alive(second)).toBe(true);
        expect((yield* sideNew).kind).toBe("ready");
        yield* Deferred.succeed(held.release, undefined);
        expect(located(yield* Fiber.join(query)).locations).toEqual([
          { file: "src/math.ts", range: span(newMath, 3, "add") },
        ]);
        expect(alive(second)).toBe(true);
        yield* until(Effect.sync(() => !alive(second)));
        expect((yield* sideNew).kind).toBe("stopped");
      }),
      { engines: 2, idle: "300 millis", query: "2 minutes" },
    );
  }, 60_000);

  it("stops an engine whose query outlasts the query bound and reports it until the next query", async () => {
    const dataDir = join(dir, "data-timeout");
    const cwd = await changedRepo("timeout");
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session, blob, target } = yield* changedSession(cwd);
        const held = yield* hold(new Set([blob("src/math.ts", "new")]), 1);
        const query = yield* Effect.forkChild(definition(target("new"), plusAt("new")));
        yield* Deferred.await(held.started);
        readGate = undefined;
        const engine = engines()[0]!.pid;
        const engineFailure = {
          kind: "unavailable",
          reason: { kind: "engine", message: "the engine did not answer in time and was stopped" },
        };
        expect((yield* Fiber.join(query)).outcome).toEqual(engineFailure);
        expect(alive(engine)).toBe(false);
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toEqual([]);
        expect((yield* readiness(session.id, session.snapshotId)).sides.new).toEqual(engineFailure);
        yield* Deferred.succeed(held.release, undefined);
        // The next query retries on a fresh engine.
        expect(located(yield* definition(target("new"), plusAt("new"))).locations).toHaveLength(1);
        expect((yield* readiness(session.id, session.snapshotId)).sides.new.kind).toBe("ready");
      }),
      { engines: 2, idle: "60 seconds", query: "1 second" },
    );
  }, 60_000);

  it("counts waiting for an engine slot against the query bound, and drops a query that expires queued", async () => {
    const dataDir = join(dir, "data-queue-deadline");
    const cwd = await changedRepo("queue-deadline");
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const { session, blob, target } = yield* changedSession(cwd);
        const sides = Effect.map(readiness(session.id, session.snapshotId), ({ sides }) => sides);
        expect(located(yield* definition(target("new"), plusAt("new"))).locations).toHaveLength(1);
        const engine = engines()[0]!.pid;

        // The only engine is busy with a query held reading its answer's text, and frozen, so
        // stopping it once that query times out takes well over a second.
        const held = yield* hold(new Set([blob("src/math.ts", "new")]));
        const busy = yield* Effect.forkChild(definition(target("new"), plusAt("new")));
        yield* Deferred.await(held.started);
        readGate = undefined;
        process.kill(engine, "SIGSTOP");
        const asked = Date.now();
        const queued = yield* Effect.forkChild(definition(target("old"), plusAt("old")));
        yield* until(Effect.map(sides, ({ old }) => old.kind === "queued"));

        expect((yield* Fiber.join(queued)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "engine", message: "no engine was free in time" },
        });
        // Its own one second, not the busy query's second and then another.
        expect(Date.now() - asked).toBeLessThan(1_800);
        expect((yield* sides).old).toEqual({ kind: "stopped" });
        expect((yield* Fiber.join(busy)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "engine", message: "the engine did not answer in time and was stopped" },
        });
        yield* Deferred.succeed(held.release, undefined);
        expect(alive(engine)).toBe(false);
        // Nothing of the expired wait is left: the next query takes the freed slot.
        expect(located(yield* definition(target("old"), plusAt("old"))).locations).toHaveLength(1);
        expect((yield* sides).old.kind).toBe("ready");
      }),
      { engines: 1, idle: "60 seconds", query: "1 second" },
    );
  }, 60_000);

  it("cancels a preparation a refresh overtakes without holding up review", async () => {
    const dataDir = join(dir, "data-refresh");
    const cwd = await changedRepo("refresh");
    await runReal(
      dataDir,
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const navigation = yield* Navigation;
        const { session, target } = yield* changedSession(cwd);
        // The query reads its own text, then its preparation is held copying the side.
        const held = yield* hold(undefined, 1);
        const query = yield* Effect.forkChild(definition(target("new"), plusAt("new")));
        yield* Deferred.await(held.started);
        readGate = undefined;
        expect((yield* readiness(session.id, session.snapshotId)).sides).toEqual({
          old: { kind: "stopped" },
          new: { kind: "preparing" },
        });

        // Review operations answer promptly while preparation is held.
        const diff = yield* sessions.diff({ command: "diff", session: session.id });
        const status = yield* sessions
          .status({ command: "status", session: session.id })
          .pipe(Effect.timeout("2 seconds"));
        yield* sessions
          .code({
            command: "code",
            session: session.id,
            snapshotId: session.snapshotId,
            file: "src/use.ts",
            side: "new",
          })
          .pipe(Effect.timeout("2 seconds"));
        yield* sessions
          .viewed({
            command: "viewed",
            session: session.id,
            snapshotId: session.snapshotId,
            revision: status.revision,
            requestId: "v1",
            hunkIds: [diff.hunks[0]!.id],
            viewed: true,
          })
          .pipe(Effect.timeout("2 seconds"));

        yield* Effect.promise(() =>
          writeFile(join(cwd, "src/use.ts"), `${newUse}export const five = 5;\n`),
        );
        const refreshed = yield* sessions.refresh({
          command: "refresh",
          session: session.id,
          snapshotId: session.snapshotId,
          requestId: "refresh",
        });
        yield* navigation.retire(session.id, refreshed.snapshotId);
        expect((yield* Fiber.join(query)).outcome).toEqual({
          kind: "unavailable",
          reason: { kind: "historical" },
        });
        yield* Deferred.succeed(held.release, undefined);
        expect(engines()).toEqual([]);
        expect(yield* Effect.promise(() => readdir(join(dataDir, "navigation")))).toEqual([]);
        expect((yield* readiness(session.id, session.snapshotId)).sides.new).toEqual({
          kind: "unavailable",
          reason: { kind: "historical" },
        });
        expect((yield* readiness(session.id, refreshed.snapshotId)).sides).toEqual({
          old: { kind: "stopped" },
          new: { kind: "stopped" },
        });
      }),
    );
  }, 60_000);

  it("stops engines and publishes nothing when the daemon shuts down mid-query", async () => {
    const dataDir = join(dir, "data-shutdown");
    const cwd = await changedRepo("shutdown");
    spawned.length = 0;
    const scope = Effect.runSync(Scope.make());
    const context = await Effect.runPromise(Layer.buildWithScope(stack(dataDir), scope));
    const run = <A, E>(effect: Effect.Effect<A, E, Navigation | Sessions>) =>
      Effect.runPromise(Effect.provideContext(effect, context));
    await run(Sessions.use((s) => s.load));
    const { blob, target } = await run(changedSession(cwd));
    const held = await Effect.runPromise(hold(new Set([blob("src/math.ts", "new")]), 1));
    const query = Effect.runFork(
      Effect.provideContext(definition(target("new"), plusAt("new")), context),
    );
    await Effect.runPromise(Deferred.await(held.started));
    readGate = undefined;
    const engine = engines()[0]!.pid;
    expect(alive(engine)).toBe(true);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(alive(engine)).toBe(false);
    expect(await readdir(join(dataDir, "navigation"))).toEqual([]);
    await Effect.runPromise(Deferred.succeed(held.release, undefined));
    const outcome = await Effect.runPromise(Fiber.await(query));
    expect(Exit.isSuccess(outcome) ? outcome.value.outcome : { failed: true }).not.toMatchObject({
      kind: "locations",
    });
    expect(liveEngines()).toEqual([]);
  }, 60_000);
});
