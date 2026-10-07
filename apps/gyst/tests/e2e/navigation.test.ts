// The packed navigation add-on with the installed gyst: npm installs, launch-PATH discovery and
// Check again through a real launch's HTTP bridge, and the daemon's engines on the add-on's own
// pinned TypeScript, observed as processes.
import { navigationAddon, navigationInstallCommand } from "@gyst/core";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, inject, it, onTestFinished } from "vite-plus/test";

import {
  daemonPid,
  installed,
  isAlive,
  json,
  killDaemon,
  launchViewer,
  run,
  sandbox,
  succeeded,
  waitFor,
} from "./installed-gyst.ts";

const navigation = inject("installedNavigation");
const navigationBin = dirname(navigation.bin);
const navigationPackage = join(
  navigation.prefix,
  "lib",
  "node_modules",
  "@gyst",
  "navigation-typescript",
);
const version: string = JSON.parse(
  readFileSync(join(installed.packageDir, "package.json"), "utf8"),
).version;
const install = navigationInstallCommand(version);

type Sandbox = Awaited<ReturnType<typeof sandbox>>;
type Viewer = Awaited<ReturnType<typeof launchViewer>>;

/**
 * A launch PATH: `dirs` first, then the sandbox's, minus any directory that already holds an
 * add-on, so a developer's own global install never stands in for the one a test chose.
 */
const launchEnv = (box: Sandbox, ...dirs: string[]): NodeJS.ProcessEnv => ({
  ...box.env,
  PATH: [
    ...dirs,
    ...(box.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => dir !== "" && !existsSync(join(dir, navigationAddon.bin))),
  ].join(delimiter),
});

/** npm beside the Node under test, with the runner's own npm cache. */
const npm = async (cwd: string, ...args: string[]) =>
  succeeded(
    await run(join(dirname(process.execPath), "npm"), [...args, "--no-audit", "--no-fund"], {
      cwd,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
      timeout: 180_000,
    }),
  );

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Engine processes started from an add-on under `root`: the add-on before it hands over, then
 * TypeScript's launcher and its native binary, which keep that PID.
 */
function engines(root: string): number[] {
  const found = spawnSync(
    "pgrep",
    ["-f", `${escape(root)}/[^ ]*(cli\\.js lsp --expect|tsc --lsp --stdio)`],
    { encoding: "utf8" },
  );
  if (found.status === 1) return [];
  if (found.status !== 0) throw new Error(`pgrep failed (${found.status}): ${found.stderr}`);
  return found.stdout.trim().split("\n").map(Number);
}

/** Stops engines a test may leave behind on purpose, such as after its daemon is SIGKILLed. */
const killEnginesAfterTest = (root: string) =>
  onTestFinished(() => {
    for (const pid of engines(root)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  });

/** Only Linux exposes another process's environment, through `/proc`. */
const readsEnviron = process.platform === "linux";
const environ = (pid: number) =>
  Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );

const navigationDirs = async (data: string) =>
  existsSync(join(data, "navigation")) ? await readdir(join(data, "navigation")) : [];

const git = (box: Sandbox, cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: box.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const write = async (cwd: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
};

/** A repository with `committed` as its only commit and `edited` left uncommitted. */
async function project(
  box: Sandbox,
  name: string,
  committed: Record<string, string>,
  edited: Record<string, string>,
) {
  const cwd = join(box.root, name);
  await mkdir(cwd);
  git(box, cwd, "init", "-q");
  git(box, cwd, "config", "user.email", "test@gyst.invalid");
  git(box, cwd, "config", "user.name", "Gyst Test");
  await write(cwd, committed);
  git(box, cwd, "add", ".");
  git(box, cwd, "commit", "-qm", "initial");
  await write(cwd, edited);
  return cwd;
}

const oldMath =
  "export function add(first: number, second: number) {\n  return first + second;\n}\n";
const newMath = `// Arithmetic helpers.\nexport const zero = 0;\n${oldMath}`;
const oldUse = 'import { add as plus } from "./math.js";\nexport const three = plus(1, 2);\n';
const newUse =
  'import { add as plus, zero } from "./math.js";\n' +
  "export const three = plus(1, 2) + zero;\n" +
  "export const four = plus(three, 1);\n";
const crlf = 'export const 𐐀name = "𐐀";\r\nexport const twice = 𐐀name + 𐐀name;\r\n';
const packageJson =
  '{ "name": "fixture", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n';
/** The TS fixture: `add` moves down two lines in the new side, and `plus` aliases it. */
const math = (box: Sandbox, name: string) =>
  project(
    box,
    name,
    {
      "package.json": packageJson,
      "README.md": "# fixture\n",
      "src/math.ts": oldMath,
      "src/use.ts": oldUse,
    },
    { "src/math.ts": newMath, "src/use.ts": newUse, "src/crlf.ts": crlf },
  );

/** The range of the `nth` `word` on a 1-based LF-delimited line. */
const span = (text: string, line: number, word: string, nth = 0) => {
  const lineText = text.split("\n")[line - 1]!;
  let character = -1;
  for (let index = 0; index <= nth; index++) character = lineText.indexOf(word, character + 1);
  if (character === -1) throw new Error(`no ${word} on line ${line}`);
  return { start: { line, character }, end: { line, character: character + word.length } };
};
const at = (text: string, line: number, word: string, nth = 0) => span(text, line, word, nth).start;

const ok = (reply: any) => {
  if (reply.ok !== true) throw new Error(`expected ok: ${JSON.stringify(reply)}`);
  return reply.value;
};
const located = (payload: any) => {
  if (payload.outcome.kind !== "locations")
    throw new Error(`not locations: ${JSON.stringify(payload.outcome)}`);
  return payload.outcome;
};

/** The current snapshot of the viewer's session and query helpers bound to it. */
async function queries(viewer: Viewer, session = viewer.id) {
  const { snapshotId } = ok(await viewer.operation({ command: "diff", session }));
  const ids = { session, snapshotId };
  const query =
    (command: "definition" | "references") =>
    async (side: "old" | "new", file: string, position: { line: number; character: number }) =>
      ok(await viewer.operation({ command, ...ids, side, file, position }));
  return {
    ids,
    status: async (recheck?: boolean) =>
      ok(
        await viewer.operation({
          command: "navigation",
          ...ids,
          ...(recheck === undefined ? {} : { recheck }),
        }),
      ),
    definition: query("definition"),
    references: query("references"),
    identifiers: async (side: "old" | "new", file: string, line: number) =>
      ok(await viewer.operation({ command: "identifiers", ...ids, side, file, line })),
  };
}

const addonUnavailable = (addon: object) => ({
  kind: "unavailable",
  reason: { kind: "addon", addon },
});

describe("TS/JS navigation through the installed add-on", () => {
  it("reviews without the add-on, names the exact install command and starts nothing", async () => {
    const box = await sandbox();
    const cwd = await math(box, "no-addon");
    const viewer = await launchViewer([], { cwd, env: launchEnv(box) });
    const diff = ok(await viewer.operation({ command: "diff", session: viewer.id }));
    const ids = { session: viewer.id, snapshotId: diff.snapshotId };
    ok(await viewer.operation({ command: "open", session: viewer.id }));
    ok(await viewer.operation({ command: "status", session: viewer.id }));
    expect(ok(await viewer.operation({ command: "files", ...ids })).total).toBe(5);
    const code = ok(
      await viewer.operation({ command: "code", ...ids, file: "src/use.ts", side: "new" }),
    );
    expect(code.content).toMatchObject({ kind: "text", text: newUse });
    const viewed = ok(
      await viewer.operation({
        command: "viewed",
        ...ids,
        revision: diff.revision,
        requestId: "viewed-1",
        hunkIds: [diff.hunks[0].id],
        viewed: true,
      }),
    );
    expect(viewed).toMatchObject({ hunkIds: [diff.hunks[0].id], viewed: true });

    const missing = { kind: "missing", install };
    expect(install).toBe(`npm install -g @gyst/navigation-typescript@${version}`);
    const { status, definition, identifiers } = await queries(viewer);
    for (const state of [await status(), await status(true)])
      expect(state).toEqual({
        sessionId: viewer.id,
        snapshotId: diff.snapshotId,
        addon: missing,
        sides: { old: addonUnavailable(missing), new: addonUnavailable(missing) },
      });
    expect((await definition("new", "src/use.ts", at(newUse, 2, "plus"))).outcome).toEqual(
      addonUnavailable(missing),
    );
    expect((await identifiers("new", "src/math.ts", 3)).outcome).toEqual(addonUnavailable(missing));
    expect(engines(navigation.prefix)).toEqual([]);
    expect(engines(box.root)).toEqual([]);
    expect(existsSync(join(box.data, "navigation"))).toBe(false);
  }, 60_000);

  it("finds an npm install into an existing launch-PATH directory on Check again, with the same daemon", async () => {
    const box = await sandbox();
    const cwd = await math(box, "install-later");
    const prefix = join(box.root, "npm-global");
    await mkdir(join(prefix, "bin"), { recursive: true });
    const viewer = await launchViewer([], { cwd, env: launchEnv(box, join(prefix, "bin")) });
    const { status, definition } = await queries(viewer);
    expect((await status()).addon).toEqual({ kind: "missing", install });
    const daemon = await daemonPid(box.data);

    await npm(box.root, "install", "--global", "--prefix", prefix, navigation.tarball);
    // The launch keeps its discovery until Check again.
    expect((await status()).addon).toEqual({ kind: "missing", install });
    expect(await status(true)).toMatchObject({
      addon: { kind: "available", version },
      sides: { old: { kind: "stopped" }, new: { kind: "stopped" } },
    });
    const found = located(await definition("new", "src/use.ts", at(newUse, 2, "plus")));
    expect(found.locations).toEqual([{ file: "src/math.ts", range: span(newMath, 3, "add") }]);
    expect(engines(prefix)).toHaveLength(1);
    expect(await daemonPid(box.data)).toBe(daemon);
    expect(isAlive(daemon)).toBe(true);
  }, 240_000);

  it("needs a new launch for an add-on whose prefix is not on the launch PATH", async () => {
    const box = await sandbox();
    const cwd = await math(box, "other-prefix");
    // The shared install exists, but its bin directory is not on this launch's PATH.
    const first = await launchViewer([], { cwd, env: launchEnv(box) });
    const before = await queries(first);
    expect((await before.status(true)).addon).toEqual({ kind: "missing", install });
    const daemon = await daemonPid(box.data);

    const second = await launchViewer(["--session", first.id], {
      cwd,
      env: launchEnv(box, navigationBin),
    });
    const after = await queries(second);
    expect((await after.status()).addon).toEqual({ kind: "available", version });
    expect(
      located(await after.definition("old", "src/use.ts", at(oldUse, 2, "plus"))).locations,
    ).toEqual([{ file: "src/math.ts", range: span(oldMath, 1, "add") }]);
    // Each launch keeps its own discovery; the first still cannot see the other prefix.
    expect((await before.status(true)).addon).toEqual({ kind: "missing", install });
    expect((await before.definition("old", "src/use.ts", at(oldUse, 2, "plus"))).outcome).toEqual(
      addonUnavailable({ kind: "missing", install }),
    );
    expect(await daemonPid(box.data)).toBe(daemon);
  }, 60_000);

  it("reports another release first on PATH as mismatched, apart from project gaps", async () => {
    const box = await sandbox();
    const cwd = await math(box, "mismatched");
    const other = join(box.root, "other-release");
    await mkdir(join(other, "dist"), { recursive: true });
    const manifest = JSON.parse(await readFile(join(navigationPackage, "package.json"), "utf8"));
    await writeFile(join(other, "package.json"), JSON.stringify({ ...manifest, version: "0.0.1" }));
    await copyFile(join(navigationPackage, "dist", "cli.mjs"), join(other, "dist", "cli.mjs"));
    await chmod(join(other, "dist", "cli.mjs"), 0o755);
    await symlink(join(navigationPackage, "node_modules"), join(other, "node_modules"));
    const otherBin = join(box.root, "other-bin");
    await mkdir(otherBin);
    await symlink(join(other, "dist", "cli.mjs"), join(otherBin, navigationAddon.bin));

    const viewer = await launchViewer([], { cwd, env: launchEnv(box, otherBin, navigationBin) });
    const mismatched = { kind: "mismatched", found: "0.0.1", install };
    const { status, definition } = await queries(viewer);
    expect(await status()).toMatchObject({
      addon: mismatched,
      sides: { old: addonUnavailable(mismatched), new: addonUnavailable(mismatched) },
    });
    expect((await definition("new", "src/use.ts", at(newUse, 2, "plus"))).outcome).toEqual(
      addonUnavailable(mismatched),
    );
    expect(engines(box.root)).toEqual([]);
    expect(engines(navigation.prefix)).toEqual([]);

    // With this release's add-on, project inputs are gaps and non-sources, never add-on states.
    const matching = await queries(
      await launchViewer(["--session", viewer.id], { cwd, env: launchEnv(box, navigationBin) }),
    );
    const found = located(await matching.definition("new", "src/use.ts", at(newUse, 2, "plus")));
    expect(found.gaps).toEqual([
      { kind: "dependencies", file: "package.json" },
      { kind: "no-project-config" },
    ]);
    expect(
      (await matching.definition("new", "README.md", { line: 1, character: 2 })).outcome,
    ).toEqual({
      kind: "unavailable",
      reason: { kind: "not-source", detail: "README.md is not a TypeScript or JavaScript source" },
    });
  }, 60_000);

  it("reports an install without its optional engine binary as unusable and keeps reviewing", async () => {
    const box = await sandbox();
    const cwd = await math(box, "omitted");
    // npm 11 ignores --omit=optional for --global installs, which always carry the platform
    // binary; a project-local install whose .bin is on PATH can omit it.
    const local = join(box.root, "without-optional");
    await mkdir(local);
    await npm(local, "install", "--prefix", local, "--omit=optional", navigation.tarball);
    expect(existsSync(join(local, "node_modules", "typescript"))).toBe(true);
    expect(existsSync(join(local, "node_modules", "@typescript"))).toBe(false);

    const viewer = await launchViewer([], {
      cwd,
      env: launchEnv(box, join(local, "node_modules", ".bin")),
    });
    const { ids, status, definition } = await queries(viewer);
    const daemon = await daemonPid(box.data);
    const state = await status();
    expect(state.addon).toEqual({
      kind: "unusable",
      reason: expect.stringContaining(
        `Unable to resolve @typescript/typescript-${process.platform}-${process.arch}`,
      ),
      install,
    });
    expect(JSON.stringify(state)).not.toContain(box.root);
    expect((await definition("new", "src/use.ts", at(newUse, 2, "plus"))).outcome).toEqual(
      addonUnavailable(state.addon),
    );
    ok(await viewer.operation({ command: "status", session: ids.session }));
    expect(
      ok(await viewer.operation({ command: "code", ...ids, file: "src/math.ts", side: "old" }))
        .content.text,
    ).toBe(oldMath);
    expect(isAlive(daemon)).toBe(true);
    expect(await daemonPid(box.data)).toBe(daemon);
    expect(engines(local)).toEqual([]);
  }, 240_000);

  it("answers both sides on the packaged engine from captured text, with the request's identity", async () => {
    const box = await sandbox();
    const cwd = await math(box, "both-sides");
    const viewer = await launchViewer([], { cwd, env: launchEnv(box, navigationBin) });
    const { ids, definition, references, identifiers } = await queries(viewer);
    // Captured content is the only input: the checkout is gone before the first query.
    await rm(cwd, { recursive: true, force: true });

    const identity = (side: string, file: string, query: string, position: object) => ({
      sessionId: ids.session,
      snapshotId: ids.snapshotId,
      side,
      file,
      query,
      position,
    });
    const newPlus = at(newUse, 2, "plus");
    const newDefinition = await definition("new", "src/use.ts", newPlus);
    expect(newDefinition).toMatchObject(identity("new", "src/use.ts", "definition", newPlus));
    expect(located(newDefinition)).toEqual({
      kind: "locations",
      symbol: { text: "plus", range: span(newUse, 2, "plus") },
      locations: [{ file: "src/math.ts", range: span(newMath, 3, "add") }],
      outside: 0,
      gaps: [{ kind: "dependencies", file: "package.json" }, { kind: "no-project-config" }],
    });
    const oldPlus = at(oldUse, 2, "plus");
    const oldDefinition = await definition("old", "src/use.ts", oldPlus);
    expect(oldDefinition).toMatchObject(identity("old", "src/use.ts", "definition", oldPlus));
    expect(located(oldDefinition).locations).toEqual([
      { file: "src/math.ts", range: span(oldMath, 1, "add") },
    ]);

    // Native alias semantics: the alias and the original are different symbols.
    const plusReferences = await references("new", "src/use.ts", newPlus);
    expect(plusReferences).toMatchObject(identity("new", "src/use.ts", "references", newPlus));
    expect(located(plusReferences).locations).toEqual(
      [1, 2, 3].map((line) => ({
        file: "src/use.ts",
        range: span(newUse, line, "plus"),
      })),
    );
    const addReferences = located(await references("new", "src/math.ts", at(newMath, 3, "add")));
    expect(addReferences.locations).toEqual(
      expect.arrayContaining([
        { file: "src/math.ts", range: span(newMath, 3, "add") },
        { file: "src/use.ts", range: span(newUse, 1, "add") },
      ]),
    );
    expect(addReferences.locations).not.toEqual(located(plusReferences).locations);

    // Declaration parameters are offered on their line, keywords and type names are not.
    const parameters = await identifiers("new", "src/math.ts", 3);
    expect(parameters).toEqual({
      sessionId: ids.session,
      snapshotId: ids.snapshotId,
      side: "new",
      file: "src/math.ts",
      line: 3,
      outcome: {
        kind: "identifiers",
        identifiers: ["add", "first", "second"].map((word) => ({
          text: word,
          range: span(newMath, 3, word),
        })),
        gaps: [{ kind: "dependencies", file: "package.json" }, { kind: "no-project-config" }],
      },
    });
    const firstUse = located(await references("old", "src/math.ts", at(oldMath, 2, "first")));
    expect(firstUse.locations).toEqual([
      { file: "src/math.ts", range: span(oldMath, 1, "first") },
      { file: "src/math.ts", range: span(oldMath, 2, "first") },
    ]);

    // UTF-16 and CRLF: an astral identifier before the cursor, CR before each LF.
    const astral = at(crlf, 2, "𐐀name", 1);
    expect(astral).toEqual({ line: 2, character: 30 });
    const astralReferences = await references("new", "src/crlf.ts", astral);
    expect(astralReferences).toMatchObject(identity("new", "src/crlf.ts", "references", astral));
    expect(located(astralReferences)).toMatchObject({
      symbol: { text: "𐐀name", range: span(crlf, 2, "𐐀name", 1) },
      locations: [
        { file: "src/crlf.ts", range: span(crlf, 1, "𐐀name") },
        { file: "src/crlf.ts", range: span(crlf, 2, "𐐀name") },
        { file: "src/crlf.ts", range: span(crlf, 2, "𐐀name", 1) },
      ],
    });
    // One engine per side served every query.
    expect(engines(navigation.prefix)).toHaveLength(2);
  }, 120_000);

  it("never runs npm: type acquisition is off and the engine gets no PATH", async () => {
    const box = await sandbox();
    const fake = join(box.root, "fake-bin");
    const ran = join(box.root, "npm-ran");
    await mkdir(fake);
    await writeFile(join(fake, "npm"), `#!/bin/sh\necho "$@" >> '${ran}'\n`, { mode: 0o755 });
    const pad =
      'import leftPad from "left-pad";\nexport function pad(text) {\n  return leftPad(text, 4);\n}\n';
    const cwd = await project(
      box,
      "javascript",
      { "package.json": packageJson, "src/pad.js": pad },
      { "src/pad.js": `${pad}export const padded = pad("a");\n` },
    );
    // The launch starts the daemon, so the fake npm is first on both of their PATHs.
    const viewer = await launchViewer([], { cwd, env: launchEnv(box, fake, navigationBin) });
    const { definition, references } = await queries(viewer);
    const daemon = await daemonPid(box.data);
    if (readsEnviron) expect(environ(daemon).PATH?.split(delimiter)[0]).toBe(fake);

    const found = located(await definition("new", "src/pad.js", { line: 5, character: 23 }));
    expect(found).toMatchObject({
      symbol: { text: "pad" },
      locations: [{ file: "src/pad.js", range: span(pad, 2, "pad") }],
    });
    expect(found.gaps).toContainEqual({ kind: "dependencies", file: "package.json" });
    const [engine, ...others] = engines(navigation.prefix);
    expect(others).toEqual([]);
    if (readsEnviron) {
      const engineEnv = environ(engine!);
      expect(engineEnv.PATH).toBeUndefined();
      expect(engineEnv.HOME?.startsWith(join(box.data, "navigation") + sep)).toBe(true);
    }
    // With acquisition on, 7.0.2 runs npm for such a project within about 4 seconds.
    await sleep(8_000);
    located(await references("new", "src/pad.js", { line: 2, character: 16 }));
    expect(existsSync(ran)).toBe(false);
    const caches = (await readdir(box.root, { recursive: true })).filter((path) =>
      path.endsWith(join("typescript", "7.0")),
    );
    expect(caches).toEqual([]);
    expect(isAlive(engine!)).toBe(true);
  }, 120_000);

  it("refuses targets outside the capture without naming them, and a replaced snapshot", async () => {
    const box = await sandbox();
    const secret = `TOPSECRET-${crypto.randomUUID()}`;
    const libUse = "export const isList = Array.isArray([]);\nconsole.log(isList);\n";
    // Reaches the data dir from the materialized project, never from the checkout.
    const reach =
      'import { secret } from "../../../../secret/hidden.js";\nexport const leaked = secret;\n';
    const cwd = await project(
      box,
      "outside",
      { "src/math.ts": oldMath, "src/use.ts": oldUse },
      {
        "src/use.ts": newUse.replace(", zero", ""),
        "src/lib-use.ts": libUse,
        "src/secret.ts": reach,
      },
    );
    await write(box.data, { "secret/hidden.ts": `export const secret = "${secret}";\n` });
    const viewer = await launchViewer([], { cwd, env: launchEnv(box, navigationBin) });
    const { ids, status, definition, references } = await queries(viewer);

    const lib = located(await definition("new", "src/lib-use.ts", at(libUse, 2, "console")));
    expect(lib).toMatchObject({ symbol: { text: "console" }, locations: [] });
    expect(lib.outside).toBeGreaterThanOrEqual(1);
    const leaked = located(await definition("new", "src/secret.ts", at(reach, 2, "secret")));
    expect(leaked).toMatchObject({ symbol: { text: "secret" }, locations: [] });
    expect(leaked.outside).toBeGreaterThanOrEqual(1);
    const leakedReferences = await references("new", "src/secret.ts", at(reach, 1, "secret"));
    for (const payload of [lib, leaked, leakedReferences]) {
      const text = JSON.stringify(payload);
      for (const hidden of [secret, box.root, "hidden", "lib.dom", "node_modules"])
        expect(text).not.toContain(hidden);
    }
    expect(engines(navigation.prefix)).toHaveLength(1);

    await write(cwd, { "src/use.ts": newUse.replace(", zero", "").replace("(1, 2)", "(2, 2)") });
    const refreshed = json(await box.gyst(cwd, ["session", "refresh", "--session", ids.session]));
    expect(refreshed.session.snapshotId).not.toBe(ids.snapshotId);
    // The replaced snapshot's engine stops with it.
    await waitFor(
      () => engines(navigation.prefix).length === 0,
      "the old snapshot's engine to stop",
    );
    const historical = { kind: "unavailable", reason: { kind: "historical" } };
    expect((await definition("new", "src/use.ts", at(oldUse, 2, "plus"))).outcome).toEqual(
      historical,
    );
    expect((await status()).sides).toEqual({ old: historical, new: historical });
    expect(engines(navigation.prefix)).toEqual([]);
    expect(await navigationDirs(box.data)).toEqual([]);
    const current = await queries(viewer);
    expect(current.ids.snapshotId).toBe(refreshed.session.snapshotId);
    expect(
      located(await current.definition("new", "src/use.ts", at(oldUse, 2, "plus"))).locations,
    ).toEqual([{ file: "src/math.ts", range: span(oldMath, 1, "add") }]);
  }, 120_000);

  it("keeps at most two engines, and stops them on delete and daemon shutdown", async () => {
    const box = await sandbox();
    killEnginesAfterTest(navigation.prefix);
    const cwd = await project(
      box,
      "lifecycle",
      { "src/math.ts": oldMath, "src/use.ts": oldUse },
      { "src/math.ts": newMath, "src/use.ts": newUse },
    );
    git(box, cwd, "commit", "-qam", "move add");
    await write(cwd, { "src/use.ts": `${newUse}export const five = plus(four, 1);\n` });
    const viewer = await launchViewer([], { cwd, env: launchEnv(box, navigationBin) });
    const range = json(await box.gyst(cwd, ["session", "open", "HEAD~1..HEAD"])).session.id;
    const a = await queries(viewer);
    const b = await queries(viewer, range);
    let most = 0;
    const monitor = setInterval(
      () => (most = Math.max(most, engines(navigation.prefix).length)),
      10,
    );
    onTestFinished(() => clearInterval(monitor));
    const plus = async (q: typeof a, side: "old" | "new") =>
      located(
        await q.definition(side, "src/use.ts", at(side === "old" ? oldUse : newUse, 2, "plus")),
      );

    await plus(a, "new");
    await plus(a, "old");
    await plus(b, "new");
    expect(engines(navigation.prefix)).toHaveLength(2);
    // Four sides at once: two engines serve them, the others wait for one to go idle.
    await Promise.all([plus(a, "new"), plus(a, "old"), plus(b, "new"), plus(b, "old")]);
    clearInterval(monitor);
    expect(most).toBe(2);
    expect(engines(navigation.prefix)).toHaveLength(2);
    const ready = (state: any) =>
      [state.sides.old, state.sides.new].filter((side: any) => side.kind === "ready").length;
    expect(ready(await a.status()) + ready(await b.status())).toBe(2);

    const kept = ready(await b.status());
    ok(await viewer.operation({ command: "delete", session: viewer.id, requestId: "delete-a" }));
    expect(engines(navigation.prefix)).toHaveLength(kept);
    expect(await navigationDirs(box.data)).toHaveLength(kept);

    await plus(b, "new");
    await killDaemon(box.data, "SIGTERM");
    await waitFor(() => engines(navigation.prefix).length === 0, "engines to stop with the daemon");
    expect(await navigationDirs(box.data)).toEqual([]);

    // A SIGKILLed daemon cannot stop its engine; the engine is told the daemon's processId and
    // loses its stdin. What happens is recorded, not required.
    await plus(b, "new");
    const [engine] = engines(navigation.prefix);
    const killedAt = performance.now();
    await killDaemon(box.data, "SIGKILL");
    const exited = await waitFor(() => !isAlive(engine!), "the engine to exit", 10_000).then(
      () => Math.round(performance.now() - killedAt),
      () => undefined,
    );
    const left = await navigationDirs(box.data);
    console.log(
      `[navigation-measure] engine after daemon SIGKILL: ${exited === undefined ? "still running after 10000 ms" : `exited after ${exited} ms`}; materializations left: ${left.length}`,
    );
    expect(left).toHaveLength(1);
    // The next daemon clears the crashed one's materialization when navigation is next used.
    await plus(b, "new");
    expect(await navigationDirs(box.data)).toHaveLength(1);
    expect(await navigationDirs(box.data)).not.toEqual(left);
  }, 120_000);
});

describe("TS/JS navigation over this repository", () => {
  it("queries real symbols on both sides of a range of a clone, and records the cost", async () => {
    const box = await sandbox();
    const source = join(import.meta.dirname, "..", "..", "..", "..");
    const clone = join(box.root, "gyst");
    git(box, box.root, "clone", "-q", "--local", source, clone);
    git(box, clone, "config", "user.email", "test@gyst.invalid");
    git(box, clone, "config", "user.name", "Gyst Test");
    const core = "packages/core/src/navigation.ts";
    const added =
      "\n/** The command that updates an installed add-on to this release. */\nexport const navigationUpdateCommand = (version: string) => navigationInstallCommand(version);\n";
    const oldCore = await readFile(join(clone, core), "utf8");
    const newCore = `${oldCore}${added}`;
    await writeFile(join(clone, core), newCore);
    git(box, clone, "commit", "-qam", "add navigationUpdateCommand");
    const server = "apps/gyst/src/daemon/server.ts";
    const serverText = await readFile(join(clone, server), "utf8");
    const addonFile = "apps/gyst/src/web/navigation-addon.ts";
    const addonText = await readFile(join(clone, addonFile), "utf8");
    // Only the core file changes, and only after its last line, so these positions hold on both sides.
    const lineOf = (text: string, pattern: RegExp) => {
      const index = text.split("\n").findIndex((line) => pattern.test(line));
      if (index === -1) throw new Error(`this repository no longer has a line matching ${pattern}`);
      return index + 1;
    };

    const viewer = await launchViewer(["HEAD~1..HEAD"], {
      cwd: clone,
      env: launchEnv(box, navigationBin),
    });
    const { ids, status, definition, references } = await queries(viewer);
    const capturedFiles = new Set<string>();
    for (let after: string | null | undefined; after !== null;) {
      const page = ok(
        await viewer.operation({ command: "files", ...ids, ...(after ? { after } : {}) }),
      );
      for (const file of page.files) capturedFiles.add(file.path);
      after = page.next;
    }
    const timed = async <T>(query: () => Promise<T>) => {
      const started = performance.now();
      const result = await query();
      return { result, ms: Math.round(performance.now() - started) };
    };
    const declaration = lineOf(oldCore, /^export const navigationInstallCommand\b/);
    const declared = at(oldCore, declaration, "navigationInstallCommand");
    const sessionsImport = lineOf(serverText, /^import \{ Sessions \} from "\.\/sessions\.ts";$/);
    const coreImport = lineOf(addonText, /from "@gyst\/core";$/);

    const newCold = await timed(() =>
      definition(
        "new",
        core,
        at(newCore, newCore.split("\n").length - 1, "navigationInstallCommand"),
      ),
    );
    const newWarm = await timed(() => references("new", core, declared));
    const oldCold = await timed(() =>
      definition("old", server, at(serverText, sessionsImport, "Sessions")),
    );
    const oldWarm = await timed(() => references("old", core, declared));
    const newSessions = located(
      await definition("new", server, at(serverText, sessionsImport, "Sessions")),
    );
    const workspaceImport = located(
      await definition("new", addonFile, at(addonText, coreImport, "navigationAddon")),
    );

    const results = [newCold, newWarm, oldCold, oldWarm].map(({ result }) => located(result));
    for (const outcome of [...results, newSessions, workspaceImport]) {
      for (const location of outcome.locations) expect(capturedFiles).toContain(location.file);
      const text = JSON.stringify(outcome);
      expect(text).not.toContain(box.root);
      expect(text).not.toContain("node_modules");
    }
    const [newDefinition, newReferences, oldDefinition, oldReferences] = results;
    expect(newDefinition.locations).toEqual([
      { file: core, range: span(newCore, declaration, "navigationInstallCommand") },
    ]);
    expect(oldDefinition.locations.map(({ file }: { file: string }) => file)).toEqual([
      "apps/gyst/src/daemon/sessions.ts",
    ]);
    expect(newSessions.locations).toEqual(oldDefinition.locations);
    // The new side has exactly one more reference: the added line.
    expect(newReferences.locations).toEqual(
      expect.arrayContaining([
        ...oldReferences.locations,
        {
          file: core,
          range: span(newCore, newCore.split("\n").length - 1, "navigationInstallCommand"),
        },
      ]),
    );
    expect(newReferences.locations).toHaveLength(oldReferences.locations.length + 1);
    expect(engines(navigation.prefix)).toHaveLength(2);
    // Workspace packages resolve through uncaptured node_modules links: named, never guessed.
    expect(workspaceImport.gaps).toContainEqual({
      kind: "unresolved-import",
      file: addonFile,
      message: 'cannot resolve "@gyst/core" (TS2307)',
    });
    const textual = git(box, clone, "grep", "-c", "navigationInstallCommand").trim().split("\n");

    const state = await status();
    const cost = (side: any) => ({
      files: side.files,
      bytes: side.bytes,
      gaps: side.gaps.map((gap: any) => `${gap.kind}${gap.file ? ` ${gap.file}` : ""}`),
    });
    expect(state.sides.old.kind).toBe("ready");
    expect(state.sides.new.kind).toBe("ready");
    const outside = (name: string, outcome: any) =>
      `${name}: ${outcome.locations.length} locations, ${outcome.outside} outside, gaps ${JSON.stringify(outcome.gaps.map((gap: any) => gap.kind))}`;
    console.log(
      [
        "[navigation-measure] this repository, HEAD~1..HEAD of a local clone",
        `captured files: ${capturedFiles.size}`,
        `old side materialized: ${JSON.stringify(cost(state.sides.old))}`,
        `new side materialized: ${JSON.stringify(cost(state.sides.new))}`,
        `new side cold definition (materialize + engine start + query): ${newCold.ms} ms; warm references: ${newWarm.ms} ms`,
        `old side cold definition: ${oldCold.ms} ms; warm references: ${oldWarm.ms} ms`,
        outside("new navigationInstallCommand definition", newDefinition),
        outside("new navigationInstallCommand references", newReferences),
        outside("old navigationInstallCommand references", oldReferences),
        outside("old Sessions definition", oldDefinition),
        `files naming navigationInstallCommand on the new side (git grep -c): ${textual.join(", ")}`,
        `@gyst/core import of navigationAddon: ${JSON.stringify(workspaceImport)}`,
      ].join("\n"),
    );
  }, 300_000);
});
