import type { TextPoint } from "@gyst/core";
import { Cause, Data, Deferred, Effect, Queue, Schema, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

/** The TypeScript engine failed to start, answer or stay up, or broke the protocol. */
export class EngineFailure extends Data.TaggedError("EngineFailure")<{
  readonly message: string;
}> {}

/** Largest message body accepted from an engine; a bound on memory, not on any real reply. */
export const frameBytes = 64 * 1024 * 1024;
const headerBytes = 8 * 1024;
const shutdownWait = "500 millis";

/** The `Content-Length` framing of one JSON-RPC message. */
export const encodeFrame = (message: object): Uint8Array => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
};

const parseContentLength = (header: string, maxBytes: number) => {
  let length: number | undefined;
  for (const line of header.split("\r\n")) {
    const field = /^([!-9;-~]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (field === null)
      throw new EngineFailure({ message: "the engine sent a malformed message header" });
    if (field[1]!.toLowerCase() !== "content-length") continue;
    if (length !== undefined || !/^\d{1,10}$/.test(field[2]!))
      throw new EngineFailure({ message: "the engine sent an invalid Content-Length" });
    length = Number(field[2]);
  }
  if (length === undefined)
    throw new EngineFailure({ message: "the engine sent a message without Content-Length" });
  if (length > maxBytes)
    throw new EngineFailure({ message: `the engine sent a message over ${maxBytes} bytes` });
  return length;
};

/**
 * Splits an engine's stdout into message bodies, however chunks fall. A body is buffered only up to
 * its declared length, and a declared length over `maxBytes` fails before any of it is held.
 * Throws `EngineFailure` on a malformed header or a body that is not UTF-8.
 */
export const frameReader = (maxBytes = frameBytes) => {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let pending: Array<Uint8Array> = [];
  let size = 0;
  let bodyLength: number | undefined;
  return (chunk: Uint8Array): Array<string> => {
    pending.push(chunk);
    size += chunk.byteLength;
    const bodies: Array<string> = [];
    for (;;) {
      if (bodyLength === undefined) {
        const buffer = Buffer.concat(pending, size);
        const end = buffer.indexOf("\r\n\r\n");
        pending = [buffer];
        if (end === -1) {
          if (size > headerBytes)
            throw new EngineFailure({ message: "the engine sent an unterminated message header" });
          return bodies;
        }
        bodyLength = parseContentLength(buffer.subarray(0, end).toString("latin1"), maxBytes);
        pending = [buffer.subarray(end + 4)];
        size -= end + 4;
      }
      if (size < bodyLength) return bodies;
      const buffer = Buffer.concat(pending, size);
      try {
        bodies.push(utf8.decode(buffer.subarray(0, bodyLength)));
      } catch {
        throw new EngineFailure({ message: "the engine sent a message that is not UTF-8" });
      }
      pending = [buffer.subarray(bodyLength)];
      size -= bodyLength;
      bodyLength = undefined;
    }
  };
};

const MessageSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageSchema));
const decodeConfigurationParams = Schema.decodeUnknownOption(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ section: Schema.optional(Schema.String) })),
  }),
);

/** Answers to the engine's `workspace/configuration` pulls, by section; others get null. */
export type EngineSettings = Readonly<Record<string, unknown>>;

const typeAcquisitionOff = { tsserver: { automaticTypeAcquisition: { enabled: false } } };

/**
 * Turns off Automatic Type Acquisition, which in 7.0.2 otherwise runs `npm install` in its cache
 * for a JavaScript project's declared packages. 7.0.2 reads it from these pulled sections and
 * ignores `initializationOptions`; each section alone is enough, all are sent.
 */
export const engineSettings: EngineSettings = {
  "js/ts": typeAcquisitionOff,
  typescript: { disableAutomaticTypeAcquisition: true, ...typeAcquisitionOff },
  javascript: { disableAutomaticTypeAcquisition: true, ...typeAcquisitionOff },
};

const answer = (settings: EngineSettings, method: string, params: unknown) => {
  switch (method) {
    case "workspace/configuration": {
      const pulled = decodeConfigurationParams(params);
      if (pulled._tag === "None")
        return { error: { code: -32602, message: "invalid configuration params" } };
      return {
        result: pulled.value.items.map(({ section }) =>
          section !== undefined && Object.hasOwn(settings, section) ? settings[section] : null,
        ),
      };
    }
    case "client/registerCapability":
    case "window/workDoneProgress/create":
      return { result: null };
    default:
      return { error: { code: -32601, message: `${method} is not supported` } };
  }
};

export interface Engine {
  readonly pid: number;
  /** The engine's `initialize` capabilities. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  /** One request and its result; an error reply, exit or protocol break fails it. */
  request(method: string, params?: unknown): Effect.Effect<unknown, EngineFailure>;
  notify(method: string, params?: unknown): Effect.Effect<void, EngineFailure>;
}

const InitializeResultSchema = Schema.Struct({
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
});

/**
 * Runs a language server process over stdio and initializes it on `project` with UTF-16
 * positions. Closing the scope sends `shutdown` and `exit`, then kills the process group if it
 * is still running after `shutdownWait`.
 */
export const startLanguageServer = Effect.fnUntraced(function* (
  command: {
    readonly file: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  },
  project: string,
  settings: EngineSettings,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command.file, [...command.args], {
        cwd: project,
        env: { ...command.env },
        stdin: { stream: Stream.fromQueue(outgoing) },
        stderr: "ignore",
        forceKillAfter: shutdownWait,
      }),
    )
    .pipe(
      Effect.mapError(
        (error) => new EngineFailure({ message: `the engine could not start: ${error.message}` }),
      ),
    );

  const pending = new Map<number, Deferred.Deferred<unknown, EngineFailure>>();
  let nextId = 1;
  let failure: EngineFailure | undefined;
  const send = (message: object) => Queue.offerUnsafe(outgoing, encodeFrame(message));
  const fail = (error: EngineFailure) => {
    failure ??= error;
    for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(failure));
    pending.clear();
  };

  const receive = (body: string) => {
    const decoded = decodeMessage(body);
    if (decoded._tag === "None")
      throw new EngineFailure({ message: "the engine sent a message that is not JSON-RPC" });
    const { id, method, params, result, error } = decoded.value;
    if (method !== undefined) {
      // Notifications (diagnostics pushes, logs, progress) carry nothing a query waits on.
      if (id !== undefined) send({ id, ...answer(settings, method, params) });
      return;
    }
    const reply = typeof id === "number" ? pending.get(id) : undefined;
    if (reply === undefined) return;
    pending.delete(id as number);
    Deferred.doneUnsafe(
      reply,
      error === undefined
        ? Effect.succeed(result ?? null)
        : Effect.fail(new EngineFailure({ message: `the engine refused: ${error.message}` })),
    );
  };

  const read = frameReader();
  const ended = handle.exitCode.pipe(
    Effect.timeoutOption("1 second"),
    Effect.map((code) =>
      code._tag === "Some"
        ? `the engine exited with code ${code.value}`
        : "the engine closed its output",
    ),
    Effect.orElseSucceed(() => "the engine was stopped by a signal"),
  );
  yield* handle.stdout.pipe(
    Stream.mapError(
      (error) => new EngineFailure({ message: `the engine output failed: ${error.message}` }),
    ),
    Stream.runForEach((chunk) =>
      Effect.try({
        try: () => read(chunk).forEach(receive),
        catch: (error) =>
          error instanceof EngineFailure
            ? error
            : new EngineFailure({ message: "the engine sent a message that is not JSON-RPC" }),
      }),
    ),
    Effect.matchEffect({
      onFailure: (error) => Effect.sync(() => fail(error)),
      onSuccess: () =>
        Effect.flatMap(ended, (message) => Effect.sync(() => fail(new EngineFailure({ message })))),
    }),
    Effect.forkScoped,
  );

  const request = (method: string, params?: unknown) =>
    Effect.suspend(() => {
      if (failure !== undefined) return Effect.fail(failure);
      const id = nextId++;
      const reply = Deferred.makeUnsafe<unknown, EngineFailure>();
      pending.set(id, reply);
      // `shutdown` takes no params: 7.0.2 rejects an explicit null.
      send(params === undefined ? { id, method } : { id, method, params });
      return Deferred.await(reply).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    });
  const notify = (method: string, params?: unknown) =>
    Effect.suspend(() => {
      if (failure !== undefined) return Effect.fail(failure);
      send(params === undefined ? { method } : { method, params });
      return Effect.void;
    });

  // Registered after the spawn and the reader, so it runs before either is torn down.
  yield* Effect.addFinalizer(() =>
    request("shutdown").pipe(
      Effect.timeoutOption(shutdownWait),
      Effect.andThen(notify("exit")),
      Effect.andThen(handle.exitCode.pipe(Effect.timeoutOption(shutdownWait))),
      Effect.ignore,
      Effect.andThen(
        Effect.sync(() => fail(new EngineFailure({ message: "the engine was stopped" }))),
      ),
    ),
  );

  const root = pathToFileURL(project).href;
  const initialized = yield* request("initialize", {
    processId: process.pid,
    rootUri: root,
    workspaceFolders: [{ uri: root, name: "project" }],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      workspace: { configuration: true },
      textDocument: { diagnostic: {} },
    },
  });
  const decoded = Schema.decodeUnknownOption(InitializeResultSchema)(initialized);
  if (decoded._tag === "None")
    return yield* new EngineFailure({ message: "the engine sent an invalid initialize result" });
  const { capabilities } = decoded.value;
  // Every range crossing gyst is UTF-16; an engine counting otherwise would shift each one.
  if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== "utf-16")
    return yield* new EngineFailure({ message: "the engine does not use UTF-16 positions" });
  yield* notify("initialized", {});
  return { pid: handle.pid, capabilities, request, notify } satisfies Engine;
});

/**
 * Starts the add-on's engine on one materialized side: gyst's own Node runs the add-on `entry`,
 * which refuses any release but `version`. Its environment is only the private `home` (which must
 * exist) as home, cache, config, data and temp directory: no PATH, so type acquisition can find no
 * npm, and no NODE_OPTIONS or other host variables.
 */
export const startEngine = (options: {
  readonly entry: string;
  readonly version: string;
  readonly project: string;
  readonly home: string;
}): Effect.Effect<Engine, EngineFailure, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  startLanguageServer(
    {
      file: process.execPath,
      args: [options.entry, "lsp", "--expect", options.version],
      env: {
        HOME: options.home,
        XDG_CACHE_HOME: options.home,
        XDG_CONFIG_HOME: options.home,
        XDG_DATA_HOME: options.home,
        TMPDIR: options.home,
      },
    },
    options.project,
    engineSettings,
  );

const languageIds: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

/** The LSP language of a TS/JS source path, or undefined for anything navigation does not query. */
export const lspLanguageId = (path: string): string | undefined => {
  const extension = extname(path);
  return Object.hasOwn(languageIds, extension) ? languageIds[extension] : undefined;
};

/** An LSP position: 0-based line split at CRLF, LF and lone CR, and UTF-16 character. */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

const lf = 10;
const cr = 13;

/**
 * The LSP position of a point in `text`, through its absolute UTF-16 offset. Undefined when the
 * point is past its line's end (its terminating CRLF or LF excluded) or past the last line.
 */
export const toLspPosition = (text: string, point: TextPoint): LspPosition | undefined => {
  let start = 0;
  for (let line = 1; line < point.line; line++) {
    const next = text.indexOf("\n", start);
    if (next === -1) return undefined;
    start = next + 1;
  }
  const next = text.indexOf("\n", start);
  const end =
    next === -1 ? text.length : next > start && text.charCodeAt(next - 1) === cr ? next - 1 : next;
  if (point.character > end - start) return undefined;
  const offset = start + point.character;
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    const code = text.charCodeAt(index);
    if (code === lf || (code === cr && text.charCodeAt(index + 1) !== lf)) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
};

/**
 * The point in `text` of an LSP position, through its absolute UTF-16 offset. Undefined when the
 * position is past its line's end or past the last line.
 */
export const fromLspPosition = (text: string, position: LspPosition): TextPoint | undefined => {
  let start = 0;
  let end = text.length;
  for (let line = 0, index = 0; ; index++) {
    if (index === text.length) {
      if (line < position.line) return undefined;
      break;
    }
    const code = text.charCodeAt(index);
    if (code !== lf && code !== cr) continue;
    if (line === position.line) {
      end = index;
      break;
    }
    if (code === cr && text.charCodeAt(index + 1) === lf) index++;
    line++;
    start = index + 1;
  }
  if (position.character > end - start) return undefined;
  const offset = start + position.character;
  let line = 1;
  let lineStart = 0;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < offset;
    index = text.indexOf("\n", index + 1)
  ) {
    line++;
    lineStart = index + 1;
  }
  return { line, character: offset - lineStart };
};
