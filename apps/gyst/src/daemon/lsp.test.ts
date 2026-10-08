import { describe, expect, it, onTestFinished } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TextPoint } from "@gyst/core";
import { Effect, Exit, Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  documentUri,
  type Engine,
  EngineFailure,
  encodeFrame,
  engineSettings,
  frameReader,
  fromLspPosition,
  type LspPosition,
  lspLanguageId,
  startEngine,
  startLanguageServer,
  toLspPosition,
} from "./lsp.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const addonCli = join(repo, "packages", "navigation-typescript", "src", "cli.ts");
const addonVersion: string = JSON.parse(
  await readFile(join(repo, "packages", "navigation-typescript", "package.json"), "utf8"),
).version;
const tscBin = join(
  dirname(createRequire(addonCli).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gyst-lsp-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const run = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** A scope the test closes itself (or that closes when the test ends) to tear an engine down. */
const engineScope = () => {
  const scope = Effect.runSync(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  onTestFinished(close);
  return { scope, close };
};
const started = (
  scope: Scope.Closeable,
  start: Effect.Effect<
    Engine,
    EngineFailure,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >,
) => run(start.pipe(Scope.provide(scope)));
const failure = (
  effect: Effect.Effect<unknown, EngineFailure, ChildProcessSpawner.ChildProcessSpawner>,
) => run(Effect.flip(effect));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (done: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
};

describe("LSP positions", () => {
  const point = (line: number, character: number): TextPoint => ({ line, character });
  const lsp = (line: number, character: number): LspPosition => ({ line, character });

  it("counts UTF-16 code units, so an astral character before the cursor is two", () => {
    expect(toLspPosition("a𐐀b", point(1, 3))).toEqual(lsp(0, 3));
    expect(fromLspPosition("a𐐀b", lsp(0, 3))).toEqual(point(1, 3));
  });

  it("ends a CRLF line before its CR and never counts that CR on the next line", () => {
    const text = "one\r\ntwo\r\n";
    expect(toLspPosition(text, point(2, 1))).toEqual(lsp(1, 1));
    expect(toLspPosition(text, point(1, 3))).toEqual(lsp(0, 3));
    expect(toLspPosition(text, point(1, 4))).toBeUndefined();
    expect(fromLspPosition(text, lsp(1, 3))).toEqual(point(2, 3));
    expect(fromLspPosition(text, lsp(0, 4))).toBeUndefined();
    expect(fromLspPosition(text, lsp(2, 0))).toEqual(point(3, 0));
  });

  it("splits LSP lines at a lone CR inside a gyst line", () => {
    const text = "a\rb\nc";
    expect(toLspPosition(text, point(1, 1))).toEqual(lsp(0, 1));
    expect(toLspPosition(text, point(1, 2))).toEqual(lsp(1, 0));
    expect(toLspPosition(text, point(2, 1))).toEqual(lsp(2, 1));
    expect(fromLspPosition(text, lsp(1, 1))).toEqual(point(1, 3));
    expect(fromLspPosition(text, lsp(2, 0))).toEqual(point(2, 0));
  });

  it("counts a BOM as the first code unit, as the engine sees it in the opened text", () => {
    expect(toLspPosition("\uFEFFx = 1", point(1, 1))).toEqual(lsp(0, 1));
    expect(fromLspPosition("\uFEFFx = 1", lsp(0, 1))).toEqual(point(1, 1));
  });

  it("handles an unterminated last line and the empty line after a final LF", () => {
    expect(toLspPosition("a\nbc", point(2, 2))).toEqual(lsp(1, 2));
    expect(toLspPosition("a\nbc", point(3, 0))).toBeUndefined();
    expect(toLspPosition("a\n", point(2, 0))).toEqual(lsp(1, 0));
    expect(toLspPosition("", point(1, 0))).toEqual(lsp(0, 0));
    expect(fromLspPosition("a\nbc", lsp(1, 2))).toEqual(point(2, 2));
    expect(fromLspPosition("a\nbc", lsp(2, 0))).toBeUndefined();
  });

  it("rejects points past a line's end or past the last line", () => {
    for (const outside of [point(1, 4), point(3, 0), point(9, 0), point(2, 3)])
      expect(toLspPosition("abc\nde", outside), JSON.stringify(outside)).toBeUndefined();
    for (const outside of [lsp(0, 4), lsp(2, 0), lsp(1, 3)])
      expect(fromLspPosition("abc\nde", outside), JSON.stringify(outside)).toBeUndefined();
  });

  it("round-trips every offset of a mixed file through both coordinate systems", () => {
    const text = "\uFEFFconst 𐐀 = 1;\r\nlet a\rb = 2;\n\n🦀\r\r\nend";
    for (let offset = 0; offset <= text.length; offset++) {
      // Between a CR and its LF is not a position in either system.
      if (text[offset - 1] === "\r" && text[offset] === "\n") continue;
      const gystLines = text.slice(0, offset).split("\n");
      const lspLines = text.slice(0, offset).split(/\r\n|\r|\n/);
      const expectedPoint = point(gystLines.length, gystLines.at(-1)!.length);
      const expectedLsp = lsp(lspLines.length - 1, lspLines.at(-1)!.length);
      expect(toLspPosition(text, expectedPoint), `offset ${offset}`).toEqual(expectedLsp);
      expect(fromLspPosition(text, expectedLsp), `offset ${offset}`).toEqual(expectedPoint);
    }
  });
});

describe("lspLanguageId", () => {
  it("names TS and JS sources by extension, and nothing else", () => {
    expect(
      ["a.ts", "a.d.ts", "a.mts", "a.cts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx"].map(
        lspLanguageId,
      ),
    ).toEqual([
      "typescript",
      "typescript",
      "typescript",
      "typescript",
      "typescriptreact",
      "javascript",
      "javascript",
      "javascript",
      "javascriptreact",
    ]);
    for (const other of ["package.json", "README.md", "a.TS", "Makefile", "a.constructor"])
      expect(lspLanguageId(other), other).toBeUndefined();
  });
});

describe("documentUri", () => {
  it("percent-encodes all but the unreserved characters, as the engine spells file URIs", () => {
    const path = "/data/a b/session.$id/(group)/[slug]/@x/a+b,c;d=e&f!g'h*i~j-k_l.ts";
    expect(documentUri(path)).toBe(
      "file:///data/a%20b/session.%24id/%28group%29/%5Bslug%5D/%40x/a%2Bb%2Cc%3Bd%3De%26f%21g%27h%2Ai~j-k_l.ts",
    );
    expect(fileURLToPath(documentUri(path))).toBe(path);
  });
});

describe("LSP framing", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reassembles frames split anywhere and splits several frames in one chunk", () => {
    const frames = Buffer.concat([
      encodeFrame({ id: 1, result: "π 🦀" }),
      Buffer.from("content-length: 2\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}"),
      encodeFrame({ method: "x" }),
    ]);
    const expected = [
      '{"jsonrpc":"2.0","id":1,"result":"π 🦀"}',
      "{}",
      '{"jsonrpc":"2.0","method":"x"}',
    ];
    const whole = frameReader();
    expect(whole(frames)).toEqual(expected);
    const byByte = frameReader();
    const bodies: Array<string> = [];
    for (let index = 0; index < frames.byteLength; index++)
      bodies.push(...byByte(frames.subarray(index, index + 1)));
    expect(bodies).toEqual(expected);
  });

  it("refuses an oversized frame before buffering its body", () => {
    const read = frameReader(16);
    expect(read(bytes("Content-Length: 16\r\n\r\n0123456789abcdef"))).toEqual(["0123456789abcdef"]);
    expect(() => read(bytes("Content-Length: 17\r\n\r\n"))).toThrow(EngineFailure);
    expect(() => frameReader()(bytes(`Content-Length: ${64 * 1024 * 1024 + 1}\r\n\r\n`))).toThrow(
      /over 67108864 bytes/,
    );
  });

  it("refuses malformed headers and non-UTF-8 bodies", () => {
    for (const header of [
      "Content-Type: x\r\n\r\n",
      "Content-Length: two\r\n\r\n",
      "Content-Length: -1\r\n\r\n",
      "Content-Length: 1\r\nContent-Length: 1\r\n\r\n",
      "Content-Length 1\r\n\r\n",
      "\r\nContent-Length: 1\r\n\r\n",
    ])
      expect(() => frameReader()(bytes(header)), JSON.stringify(header)).toThrow(EngineFailure);
    expect(() => frameReader()(bytes(`X-Filler: ${"x".repeat(9000)}`))).toThrow(/unterminated/);
    expect(() =>
      frameReader()(Buffer.concat([bytes("Content-Length: 2\r\n\r\n"), Buffer.from([0xc3, 0x28])])),
    ).toThrow(/not UTF-8/);
  });
});

/**
 * A Node language server that logs every message it receives to `log`, and answers `initialize`
 * after making `serverRequests` of its client, putting their answers in `capabilities.experimental`.
 */
const fakeServer = (
  log: string,
  options: {
    readonly serverRequests?: ReadonlyArray<{ method: string; params?: unknown }>;
    readonly positionEncoding?: string;
    readonly ignoreShutdown?: boolean;
  } = {},
) => `
const fs = require("node:fs");
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
};
const requests = ${JSON.stringify(options.serverRequests ?? [])};
const answers = {};
let initialize;
let buffer = Buffer.alloc(0);
${options.ignoreShutdown ? 'process.on("SIGTERM", () => {});' : ""}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + "\\n");
    if (message.method === "initialize") {
      initialize = message.id;
      requests.forEach((request, index) => send({ id: "s" + index, ...request }));
      send({ method: "window/logMessage", params: { type: 3, message: "ignored" } });
    } else if (message.method === undefined) answers[message.id] = message;
    else if (message.method === "fail") send({ id: message.id, error: { code: 1, message: "nope" } });
    else if (message.method === "shutdown" && ${!options.ignoreShutdown}) send({ id: message.id, result: null });
    else if (message.method === "exit" && ${!options.ignoreShutdown}) process.exit(0);
    if (initialize !== undefined && Object.keys(answers).length === requests.length) {
      send({ id: initialize, result: { capabilities: { positionEncoding: ${JSON.stringify(options.positionEncoding ?? "utf-16")}, experimental: answers } } });
      initialize = undefined;
    }
  }
});
`;

const startFake = async (scope: Scope.Closeable, script: string, project: string) =>
  started(
    scope,
    startLanguageServer(
      { file: process.execPath, args: ["-e", script], env: {} },
      project,
      engineSettings,
    ),
  );
const logged = async (log: string) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown; id?: unknown });

describe("startLanguageServer", () => {
  it("initializes with UTF-16 and answers configuration, registration and progress, refusing anything else", async () => {
    const dir = await tempDir();
    const log = join(dir, "log");
    const { scope } = engineScope();
    const engine = await startFake(
      scope,
      fakeServer(log, {
        serverRequests: [
          {
            method: "workspace/configuration",
            params: {
              items: [
                { section: "js/ts" },
                { section: "typescript" },
                { section: "javascript" },
                { section: "editor" },
                { section: "__proto__" },
                {},
              ],
            },
          },
          { method: "client/registerCapability", params: { registrations: [] } },
          { method: "window/workDoneProgress/create", params: { token: "t" } },
          { method: "workspace/applyEdit", params: { edit: {} } },
        ],
      }),
      dir,
    );
    expect(engine.capabilities.experimental).toEqual({
      s0: {
        jsonrpc: "2.0",
        id: "s0",
        result: [
          { tsserver: { automaticTypeAcquisition: { enabled: false } } },
          {
            disableAutomaticTypeAcquisition: true,
            tsserver: { automaticTypeAcquisition: { enabled: false } },
          },
          {
            disableAutomaticTypeAcquisition: true,
            tsserver: { automaticTypeAcquisition: { enabled: false } },
          },
          null,
          null,
          null,
        ],
      },
      s1: { jsonrpc: "2.0", id: "s1", result: null },
      s2: { jsonrpc: "2.0", id: "s2", result: null },
      s3: {
        jsonrpc: "2.0",
        id: "s3",
        error: { code: -32601, message: "workspace/applyEdit is not supported" },
      },
    });
    const [initialize] = await logged(log);
    expect(initialize).toMatchObject({
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(dir).href,
        workspaceFolders: [{ uri: pathToFileURL(dir).href, name: "project" }],
        capabilities: { general: { positionEncodings: ["utf-16"] } },
      },
    });
    expect(await failure(engine.request("fail", {}))).toEqual(
      new EngineFailure({ message: "the engine refused: nope" }),
    );
  });

  it("tears down with shutdown (no params), then exit, leaving no process", async () => {
    const dir = await tempDir();
    const log = join(dir, "log");
    const { scope, close } = engineScope();
    const engine = await startFake(scope, fakeServer(log), dir);
    expect(alive(engine.pid)).toBe(true);
    await close();
    expect(alive(engine.pid)).toBe(false);
    const messages = await logged(log);
    expect(messages.map(({ method }) => method)).toEqual([
      "initialize",
      "initialized",
      "shutdown",
      "exit",
    ]);
    expect(messages[2]).not.toHaveProperty("params");
    expect(await failure(engine.request("after", {}))).toBeInstanceOf(EngineFailure);
  });

  it("kills an engine that ignores shutdown and SIGTERM", async () => {
    const dir = await tempDir();
    const { scope, close } = engineScope();
    const engine = await startFake(
      scope,
      fakeServer(join(dir, "log"), { ignoreShutdown: true }),
      dir,
    );
    const before = Date.now();
    await close();
    expect(alive(engine.pid)).toBe(false);
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it("tears down when the fiber holding the engine is interrupted mid-request", async () => {
    const dir = await tempDir();
    const log = join(dir, "log");
    let pid = 0;
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const engine = yield* startLanguageServer(
          { file: process.execPath, args: ["-e", fakeServer(log)], env: {} },
          dir,
          engineSettings,
        );
        pid = engine.pid;
        // The fake never answers this, so only interruption ends it.
        return yield* engine.request("hang", {});
      }).pipe(Effect.scoped, Effect.timeout("1 second"), Effect.provide(NodeServices.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(pid).not.toBe(0);
    expect(alive(pid)).toBe(false);
    expect((await logged(log)).map(({ method }) => method)).toContain("shutdown");
  });

  it("refuses an engine that does not count positions in UTF-16", async () => {
    const dir = await tempDir();
    const { scope } = engineScope();
    expect(
      await failure(
        startLanguageServer(
          {
            file: process.execPath,
            args: ["-e", fakeServer(join(dir, "log"), { positionEncoding: "utf-8" })],
            env: {},
          },
          dir,
          engineSettings,
        ).pipe(Scope.provide(scope)),
      ),
    ).toEqual(new EngineFailure({ message: "the engine does not use UTF-16 positions" }));
  });

  it("fails pending and later requests once the engine exits or breaks the protocol", async () => {
    const dir = await tempDir();
    for (const [script, message] of [
      ["process.exit(3)", "the engine exited with code 3"],
      [
        'process.stdout.write("Content-Length: x\\r\\n\\r\\n"); setInterval(() => {}, 1000)',
        "the engine sent an invalid Content-Length",
      ],
      [
        'process.stdout.write("Content-Length: 2\\r\\n\\r\\n[]"); setInterval(() => {}, 1000)',
        "the engine sent a message that is not JSON-RPC",
      ],
    ] as const) {
      const { scope } = engineScope();
      expect(
        await failure(
          startLanguageServer(
            { file: process.execPath, args: ["-e", script], env: {} },
            dir,
            engineSettings,
          ).pipe(Scope.provide(scope)),
        ),
        script,
      ).toEqual(new EngineFailure({ message }));
    }
  });
});

/** A private home, as the daemon gives each engine. */
const privateHome = async (dir: string) => {
  const home = join(dir, "home");
  await mkdir(home);
  return home;
};

describe("startEngine (real typescript@7.0.2 through the workspace add-on)", () => {
  it("negotiates UTF-16 and maps BOM, CRLF, lone CR and astral positions exactly", async () => {
    const dir = await tempDir();
    const project = join(dir, "project");
    await mkdir(project);
    // A lone CR splits gyst line 1 into LSP lines 0 and 1; CRLF ends gyst line 1 and LSP line 1.
    const text = "\uFEFFconst 𐐀x = 1; // lone\rconst z = 𐐀x;\r\nexport const y = 𐐀x + z;\r\n";
    await writeFile(join(project, "a.ts"), text);
    const { scope, close } = engineScope();
    const engine = await started(
      scope,
      startEngine({
        entry: addonCli,
        version: addonVersion,
        project,
        home: await privateHome(dir),
      }),
    );
    expect(engine.capabilities).toMatchObject({
      positionEncoding: "utf-16",
      definitionProvider: true,
      referencesProvider: true,
    });
    const uri = pathToFileURL(join(project, "a.ts")).href;
    await run(
      engine.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: lspLanguageId("a.ts"), version: 1, text },
      }),
    );
    const [line1, line2] = text.split("\n") as [string, string];
    const at = (line: number, lineText: string, from = 0) => {
      const character = lineText.indexOf("𐐀x", from);
      return { start: { line, character }, end: { line, character: character + 3 } };
    };
    const declaration = at(1, line1);
    const lonePrefixed = at(1, line1, declaration.end.character);
    const crlfLine = at(2, line2);
    expect(lonePrefixed.start.character).toBeGreaterThan(line1.indexOf("\r"));

    const position = toLspPosition(text, crlfLine.start);
    expect(position).toEqual({ line: 2, character: crlfLine.start.character });
    const references = (await run(
      engine.request("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      }),
    )) as ReadonlyArray<{ uri: string; range: { start: LspPosition; end: LspPosition } }>;
    expect(
      references.map(({ uri: target, range }) => ({
        target,
        start: fromLspPosition(text, range.start),
        end: fromLspPosition(text, range.end),
      })),
    ).toEqual([declaration, lonePrefixed, crlfLine].map((range) => ({ target: uri, ...range })));

    const pid = engine.pid;
    await close();
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("fails to start for another release, through the add-on's --expect", async () => {
    const dir = await tempDir();
    const { scope } = engineScope();
    expect(
      await failure(
        startEngine({
          entry: addonCli,
          version: "0.0.0",
          project: dir,
          home: await privateHome(dir),
        }).pipe(Scope.provide(scope)),
      ),
    ).toEqual(new EngineFailure({ message: "the engine exited with code 2" }));
  });

  it("turns type acquisition off: 7.0.2 runs npm without engineSettings and never with them", async () => {
    const dir = await tempDir();
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "project", dependencies: { jquery: "3.7.1", lodash: "4.17.21" } }),
    );
    const source = 'import $ from "jquery";\n$("body");\n';
    await writeFile(join(project, "index.js"), source);
    const bin = join(dir, "bin");
    const marker = join(dir, "npm-ran");
    await mkdir(bin);
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
    await chmod(join(bin, "npm"), 0o755);

    // The bare engine with npm on PATH, so only the settings stand between it and an install.
    const bare = async (settings: Record<string, unknown>, home: string) => {
      const { scope, close } = engineScope();
      const engine = await started(
        scope,
        startLanguageServer(
          {
            file: process.execPath,
            args: [tscBin, "--lsp", "--stdio"],
            env: { PATH: bin, HOME: home, XDG_CACHE_HOME: home, TMPDIR: home },
          },
          project,
          settings,
        ),
      );
      const uri = pathToFileURL(join(project, "index.js")).href;
      await run(
        engine.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "javascript", version: 1, text: source },
        }),
      );
      await run(
        engine.request("textDocument/definition", {
          textDocument: { uri },
          position: { line: 1, character: 0 },
        }),
      );
      return close;
    };

    const controlHome = await privateHome(await tempDir());
    const begun = Date.now();
    const closeControl = await bare({}, controlHome);
    expect(await until(() => existsSync(marker), 20_000)).toBe(true);
    const acquired = Date.now() - begun;
    expect(await readFile(marker, "utf8")).toContain("install");
    expect(existsSync(join(controlHome, "typescript", "7.0"))).toBe(true);
    await closeControl();
    await rm(marker);

    const home = await privateHome(dir);
    const closeSettled = await bare(engineSettings, home);
    expect(await until(() => existsSync(marker), Math.max(2 * acquired, 5000))).toBe(false);
    expect(existsSync(join(home, "typescript"))).toBe(false);
    await closeSettled();
  }, 60_000);
});
