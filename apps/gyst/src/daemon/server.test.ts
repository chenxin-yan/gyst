import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  BadArgs,
  type BrowserRequest,
  navigationAddon,
  type Reply,
  ReplySchema,
  type Request,
  type Session,
} from "@gyst/core";
import {
  ConfigProvider,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Schedule,
  Schema,
} from "effect";
import * as Socket from "effect/socket/Socket";
import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freePort,
  indexHtml,
  openStream,
  type RawStream,
  send as sendHttp,
  webUiFixture,
} from "../../tests/http.ts";
import { WebUiDir } from "../web/server.ts";
import { manifestOf, noGitHub, publishingContent } from "./capture-doubles.ts";
import { Git } from "./git.ts";
import { Navigation } from "./navigation.ts";
import { Paths } from "./paths.ts";
import { DaemonInfoSchema, daemonVersion } from "./protocol.ts";
import { DaemonServer } from "./server.ts";
import { Sessions } from "./sessions.ts";
import { inspectSavedSessions, SessionStore } from "./store.ts";
import { DaemonClient } from "./client.ts";
import { lineReader, writeLine } from "./wire.ts";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;
/** An `open` from here holds the `Sessions` permit until the test releases it, then fails. */
const slowRoot = "/slow";

let dataDir: string;
let socketPath: string;
let fixture: Awaited<ReturnType<typeof webUiFixture>>;
/** Where this file's daemons start looking for a viewer port; never 4978, a real daemon's. */
let viewerStart: number;
let statusHeld: Deferred.Deferred<void>;
let statusRelease: Deferred.Deferred<void>;
let progressGate: Deferred.Deferred<void> | undefined;
const files = new Map<string, Session>();

const git = Layer.succeed(Git, {
  repoRoot: (cwd) =>
    cwd === slowRoot
      ? Deferred.succeed(statusHeld, undefined).pipe(
          Effect.andThen(Deferred.await(statusRelease)),
          Effect.andThen(Effect.fail(new BadArgs({ message: "not a repository" }))),
        )
      : Effect.succeed(cwd),
  // Two interim reports, then the manifest: the server must frame them before the reply. With
  // `progressGate` set, the capture waits on it between them.
  capture: (_root, scope, onProgress = () => Effect.void) =>
    Effect.suspend(() => {
      const gate = progressGate;
      return onProgress({ phase: "capture", done: 0, total: 1, bytes: 0 }).pipe(
        Effect.andThen(gate ? Deferred.await(gate) : Effect.void),
        Effect.andThen(onProgress({ phase: "diff", done: 1, total: 1, bytes: 4 })),
        Effect.as(manifestOf(patch, scope)),
      );
    }),
  capturePullRequest: () => Effect.die("no PR captures in this test"),
  pullRequestRange: () => Effect.die("no PR ranges in this test"),
});
const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  save: (session) => Effect.sync(() => void files.set(session.id, session)),
  remove: (id) => Effect.sync(() => void files.delete(id)),
  loadDeleteReceipts: Effect.succeed([]),
  saveDeleteReceipts: () => Effect.void,
});
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const paths = Layer.sync(Paths, () => ({
  dataDir,
  socketPath,
  pidPath: join(dataDir, "daemon.pid"),
  deleteReceiptsPath: join(dataDir, "delete-receipts"),
  sessionFile: (id: string) => join(dataDir, `${id}.json`),
}));
/** What reached the Navigation double, in order: navigation requests and retirements. */
const navigationCalls: Array<unknown> = [];
const located = (request: { session: string; snapshotId: string; side: "old" | "new" }) =>
  Effect.sync(() => {
    navigationCalls.push(request);
    return {
      sessionId: request.session,
      snapshotId: request.snapshotId,
      side: request.side,
      file: "a.ts",
      query: "definition" as const,
      position: { line: 1, character: 0 },
      outcome: { kind: "no-symbol" as const },
    };
  });
const navigation = Layer.succeed(
  Navigation,
  Navigation.of({
    definition: located,
    references: (request) =>
      Effect.map(located(request), (payload) => ({ ...payload, query: "references" as const })),
    identifiers: (request) =>
      Effect.sync(() => {
        navigationCalls.push(request);
        return {
          sessionId: request.session,
          snapshotId: request.snapshotId,
          side: request.side,
          file: request.file,
          line: request.line,
          outcome: { kind: "identifiers" as const, identifiers: [], gaps: [] },
        };
      }),
    retire: (sessionId, keep) =>
      Effect.sync(() => void navigationCalls.push({ retire: sessionId, keep })),
    status: (request) =>
      Effect.sync(() => {
        navigationCalls.push(request);
        return {
          sessionId: request.session,
          snapshotId: request.snapshotId,
          addon: { kind: "available" as const, version: "1" },
          sides: { old: { kind: "stopped" as const }, new: { kind: "queued" as const } },
        };
      }),
  }),
);
/** The viewer's settings: the SPA fixture and `GYST_PORT`, by default this file's start port. */
const viewerSettings = (port: () => string = () => String(viewerStart)) =>
  Layer.unwrap(
    Effect.sync(() =>
      Layer.merge(
        Layer.succeed(WebUiDir, fixture.dir),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GYST_PORT: port() })),
      ),
    ),
  );
const serverLayerOver = (
  platform: Layer.Layer<Layer.Success<typeof NodeServices.layer>>,
  settings = viewerSettings(),
) =>
  DaemonServer.layer.pipe(
    Layer.provide(
      Sessions.layer.pipe(
        Layer.provide(Layer.mergeAll(git, noGitHub, store, crypto, publishingContent())),
      ),
    ),
    Layer.provide(navigation),
    Layer.provide(paths),
    Layer.provide(settings),
    Layer.provide(platform),
  );
const serverLayer = serverLayerOver(NodeServices.layer);

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySchema));
const exchange = Effect.fn("exchange")(function* (message: unknown) {
  const socket = yield* NodeSocket.makeNet({ path: socketPath });
  const next = lineReader(yield* Socket.readerBytes(socket));
  yield* writeLine(socket, JSON.stringify(message));
  // Interim progress lines come first; the reply is the line with `ok`.
  let line = yield* next;
  while (!("ok" in JSON.parse(line))) line = yield* next;
  return decodeReply(line);
}, Effect.scoped);
const send = Effect.fn("send")(function* (request: Request) {
  const hello = yield* exchange({ command: "daemon.info" });
  if (!hello.ok) return hello;
  const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
  return yield* exchange({ ...info, request });
});
const open = (cwd: string) => send({ command: "open", cwd, scope: { kind: "uncommitted" } });
const openedId = (reply: Reply) => {
  if (!reply.ok) throw new Error(`open failed: ${reply.error.message}`);
  return (reply.value as { session: { id: string } }).session.id;
};
const remove = (session: string) => send({ command: "delete", session, requestId: session });
const ok = (reply: Reply) => reply.ok;

/** The port a reply's viewer link names. */
const linkPort = (reply: Reply) => {
  if (!reply.ok) throw new Error(`open failed: ${reply.error.message}`);
  const { link } = reply.value as { link: string };
  const match = /^http:\/\/localhost:(\d+)\/session\/[^/]+$/.exec(link);
  if (!match) throw new Error(`not a viewer link: ${link}`);
  return Number(match[1]);
};

/** A browser on the daemon's viewer at `port`, as the link names it unless `host` says otherwise. */
const browserAt = (port: number, host = `localhost:${port}`) => {
  const headers = [
    ["host", host],
    ["origin", `http://${host}`],
  ] as const;
  return {
    operation: (request: BrowserRequest | Record<string, unknown>) =>
      Effect.promise(() =>
        sendHttp(port, {
          method: "POST",
          target: "/api/operation",
          headers: [...headers, ["content-type", "application/json"]],
          body: JSON.stringify(request),
        }),
      ).pipe(
        Effect.map((response) => ({
          status: response.status,
          // A refused request has no body.
          reply: response.body === "" ? undefined : decodeReply(response.body),
        })),
      ),
    events: (session: string) =>
      Effect.promise(() =>
        openStream(port, { target: "/api/events", headers, body: JSON.stringify({ session }) }),
      ),
    get: (target: string) =>
      Effect.promise(() => sendHttp(port, { target, headers: [["host", host]] })),
  };
};

/** Each event's frame in order; `undefined` once the daemon ends the stream. */
const framesOf = (stream: RawStream) => {
  const frames = stream.frames();
  return Effect.promise(() => frames.next()).pipe(
    Effect.map((frame) => (frame.done ? undefined : JSON.parse(frame.value))),
    Effect.timeout("5 seconds"),
  );
};

/** Listeners on `count` consecutive loopback ports from a free one, released after the test. */
const occupy = async (count: number) => {
  for (;;) {
    const first = await freePort();
    const servers: Server[] = [];
    const taken = await Promise.all(
      Array.from(
        { length: count },
        (_, n) =>
          new Promise<boolean>((resolve) => {
            const server = createServer();
            servers.push(server);
            server.once("error", () => resolve(false));
            server.listen(first + n, "127.0.0.1", () => resolve(true));
          }),
      ),
    );
    const release = () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) =>
              server.listening ? server.close(resolve) : resolve(undefined),
            ),
        ),
      );
    if (taken.every(Boolean)) return { first, release };
    await release();
  }
};

const refused = (port: number, address = "127.0.0.1") =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: address });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-server-"));
  socketPath = join(dataDir, "daemon.sock");
  fixture = await webUiFixture();
  viewerStart = await freePort();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(fixture.root, { recursive: true, force: true });
});

describe("DaemonServer", () => {
  it("keeps an open queued behind the idle check alive during final-session shutdown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        statusHeld = yield* Deferred.make<void>();
        statusRelease = yield* Deferred.make<void>();
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        yield* Effect.retry(send({ command: "list" }), {
          schedule: Schedule.spaced("10 millis"),
          times: 100,
        });

        expect(ok(yield* remove(openedId(yield* open("/first"))))).toBe(true);
        // The final delete opened the idle latch; a slow open now holds the permit, so the idle
        // check queues behind it after its debounce, and the replacement open queues behind that.
        const slow = yield* Effect.forkChild(open(slowRoot));
        yield* Deferred.await(statusHeld);
        yield* Effect.sleep("100 millis");
        const replacement = yield* Effect.forkChild(open("/replacement"));
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(statusRelease, undefined);

        expect(ok(yield* Fiber.join(slow))).toBe(false);
        const id = openedId(yield* Fiber.join(replacement));
        expect(ok(yield* send({ command: "status", session: id }))).toBe(true);
        expect(ok(yield* remove(id))).toBe(true);
        yield* Fiber.join(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("guards restart by identity, version, saved bytes and in-flight requests", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        statusHeld = yield* Deferred.make<void>();
        statusRelease = yield* Deferred.make<void>();
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        const saved = yield* inspectSavedSessions;
        const restart = {
          command: "daemon.restart",
          version: "999.0.0",
          instanceId: info.instanceId,
          fingerprint: saved.fingerprint,
        };
        for (const invalid of [
          { ...restart, instanceId: "another-daemon" },
          { ...restart, version: daemonVersion },
          { ...restart, version: "0.0.0" },
          { ...restart, fingerprint: "changed-after-inspection" },
        ])
          expect(yield* exchange(invalid)).toEqual({ ok: true, value: { restarting: false } });
        expect(
          ok(
            yield* exchange({
              ...info,
              instanceId: "another-daemon",
              request: { command: "open", cwd: "/wrong", scope: { kind: "uncommitted" } },
            }),
          ),
        ).toBe(false);
        expect(files.size).toBe(0);
        const fs = yield* FileSystem.FileSystem;
        const changed = join(dataDir, "changed.json");
        yield* fs.writeFileString(changed, "{}");
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: false } });
        expect(yield* fs.readFileString(changed)).toBe("{}");
        yield* fs.remove(changed);
        const slow = yield* Effect.forkChild(open(slowRoot));
        yield* Deferred.await(statusHeld);
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: false } });
        yield* Deferred.succeed(statusRelease, undefined);
        yield* Fiber.join(slow);
        expect(yield* exchange(restart)).toEqual({ ok: true, value: { restarting: true } });
        yield* Fiber.join(running);
      }).pipe(
        Effect.provide(serverLayer),
        Effect.provide(paths),
        Effect.provide(NodeServices.layer),
      ),
    );
    expect((await readdir(dataDir)).filter((name) => name.startsWith("daemon.sock"))).toEqual([]);
  }, 10_000);

  it("rejects argv, removed and human operations, directory selection and missing intent before any use case runs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        for (const request of [
          { command: "create", cwd: "/argv", revisions: [], patch },
          { command: "close", session: "x" },
          { command: "open", cwd: "/argv", scope: { kind: "uncommitted" }, args: ["--stat"] },
          { command: "open", cwd: "/argv", scope: { kind: "range", range: "a..b", pathspecs: [] } },
          { command: "status", cwd: "/argv" },
          { command: "status", session: "x", args: ["--session", "x"] },
          { command: "apply", session: "x", batch: "{}", file: "a.txt" },
          { command: "refresh", session: "x", patch },
          { command: "delete", session: "x" },
          { command: "apply", session: "x" },
          // Human and viewer operations arrive only through the HTTP adapter.
          {
            command: "viewed",
            session: "x",
            snapshotId: "0".repeat(64),
            revision: 0,
            requestId: "r",
            hunkIds: [],
            viewed: true,
          },
          { command: "layer", session: "x", number: 1 },
          { command: "navigation", session: "x", snapshotId: "0".repeat(64) },
          {
            command: "definition",
            session: "x",
            snapshotId: "0".repeat(64),
            side: "new",
            file: "a.ts",
            position: { line: 1, character: 0 },
          },
        ]) {
          const reply = yield* exchange({ ...info, request });
          expect(reply.ok ? reply : reply.error).toMatchObject({
            _tag: "bad_args",
            message: "invalid daemon request; update the CLI if its protocol is older",
          });
        }
        // Subscriptions are the viewer's too.
        const subscribed = yield* exchange({ ...info, subscribe: { session: "x" } });
        expect(subscribed.ok ? subscribed : subscribed.error).toMatchObject({ _tag: "bad_args" });
        expect(files.size).toBe(0);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("discovers the add-on on the PATH a session was last opened with and retires analysis on refresh and delete", async () => {
    const bin = await mkdtemp(join(dataDir, "bin-"));
    const later = await mkdtemp(join(dataDir, "later-"));
    // A stand-in add-on whose handshake answers as this release; it runs with an empty environment.
    const script = join(dataDir, "fake-addon.js");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify(${JSON.stringify({
        name: navigationAddon.name,
        version: daemonVersion,
        protocol: navigationAddon.protocol,
        engine: { ok: true, version: "7.0.2" },
      })}) + "\\n");\n`,
    );
    await chmod(script, 0o755);
    const available = { kind: "available", entry: await realpath(script), version: daemonVersion };
    // The daemon's own PATH holds an add-on; it must never be searched.
    const daemonBin = await mkdtemp(join(dataDir, "daemon-bin-"));
    await symlink(script, join(daemonBin, navigationAddon.bin));
    const inherited = process.env.PATH;
    process.env.PATH = `${daemonBin}:${inherited ?? ""}`;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          navigationCalls.length = 0;
          const server = yield* DaemonServer;
          const running = yield* Effect.forkChild(server.run);
          const opened = yield* send({
            command: "open",
            cwd: "/navigate",
            scope: { kind: "uncommitted" },
            path: `/nonexistent:${bin}`,
          }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }));
          const session = openedId(opened);
          const browser = browserAt(linkPort(opened));
          const status = yield* send({ command: "status", session });
          if (!status.ok) throw new Error("status failed");
          const snapshotId = (status.value as { session: { snapshotId: string } }).session
            .snapshotId;
          // Ordinary review operations never reach navigation.
          expect(navigationCalls).toEqual([]);

          const target = { session, snapshotId, side: "new", file: "a.ts" } as const;
          const position = { line: 1, character: 0 };
          const queries = [
            { command: "definition", ...target, position },
            { command: "references", ...target, position },
            { command: "identifiers", ...target, line: 1 },
            { command: "navigation", session, snapshotId },
          ] as const;
          for (const query of queries)
            expect((yield* browser.operation(query)).reply?.ok).toBe(true);
          expect(navigationCalls).toEqual(
            queries.map((query) => ({ ...query, addon: { kind: "missing" } })),
          );

          // Check again looks on the same PATH, so an install into one of its directories counts.
          yield* Effect.promise(() => symlink(script, join(bin, navigationAddon.bin)));
          navigationCalls.length = 0;
          yield* browser.operation(queries[0]);
          yield* browser.operation({ ...queries[3], recheck: true });
          yield* browser.operation(queries[0]);
          expect(navigationCalls).toEqual([
            { ...queries[0], addon: { kind: "missing" } },
            { ...queries[3], addon: available },
            { ...queries[0], addon: available },
          ]);

          // The latest CLI invocation's PATH replaces it; one without the add-on finds none.
          navigationCalls.length = 0;
          expect(ok(yield* send({ command: "open", session, path: later }))).toBe(true);
          yield* browser.operation(queries[3]);
          expect(navigationCalls).toEqual([{ ...queries[3], addon: { kind: "missing" } }]);

          navigationCalls.length = 0;
          const refreshed = yield* send({ command: "refresh", session });
          if (!refreshed.ok) throw new Error("refresh failed");
          const current = (refreshed.value as { session: { snapshotId: string } }).session
            .snapshotId;
          expect(navigationCalls).toEqual([{ retire: session, keep: current }]);
          expect(ok(yield* remove(session))).toBe(true);
          expect(navigationCalls).toEqual([
            { retire: session, keep: current },
            { retire: session, keep: undefined },
          ]);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(serverLayer)),
      );
    } finally {
      process.env.PATH = inherited;
    }
  }, 10_000);

  it("writes capture progress lines before the reply, which clients with or without a handler decode", async () => {
    const progress = [
      { phase: "capture", done: 0, total: 1, bytes: 0 },
      { phase: "diff", done: 1, total: 1, bytes: 4 },
    ];
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);

        // On the wire: one JSON line per report, in order, then the one Reply line.
        const lines = yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({ path: socketPath });
            const next = lineReader(yield* Socket.readerBytes(socket));
            yield* writeLine(
              socket,
              JSON.stringify({
                ...info,
                request: { command: "open", cwd: "/progress-raw", scope: { kind: "uncommitted" } },
              }),
            );
            return [yield* next, yield* next, yield* next];
          }),
        );
        expect(lines.slice(0, 2).map((line) => JSON.parse(line))).toEqual(
          progress.map((event) => ({ progress: event })),
        );
        expect(decodeReply(lines[2]!).ok).toBe(true);

        const client = yield* DaemonClient;
        const heard: unknown[] = [];
        const opened = (yield* client.request(
          { command: "open", cwd: "/progress-client", scope: { kind: "uncommitted" } },
          (event) => Effect.sync(() => void heard.push(event)),
        )) as { session: { id: string } };
        expect(heard).toEqual(progress);
        // Without a handler the interim lines are skipped and the reply still decodes.
        const refreshed = (yield* client.request({
          command: "refresh",
          session: opened.session.id,
        })) as { session: { id: string } };
        expect(refreshed.session.id).toBe(opened.session.id);
        // A reuse captures nothing, so it reports nothing.
        heard.length = 0;
        yield* client.request(
          { command: "open", cwd: "/progress-client", scope: { kind: "uncommitted" } },
          (event) => Effect.sync(() => void heard.push(event)),
        );
        expect(heard).toEqual([]);
        yield* Fiber.interrupt(running);
      }).pipe(
        Effect.provide(
          Layer.merge(
            serverLayer,
            DaemonClient.layer.pipe(Layer.provide(paths), Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
    );
  }, 10_000);

  it("finishes and publishes a capture whose client disconnected between progress reports", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const running = yield* Effect.forkChild(server.run);
        const hello = yield* exchange({ command: "daemon.info" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
        );
        if (!hello.ok) throw new Error("handshake failed");
        const info = Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value);
        const gate = yield* Deferred.make<void>();
        progressGate = gate;
        // Read the first report, then hang up while the capture is held.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({ path: socketPath });
            const next = lineReader(yield* Socket.readerBytes(socket));
            yield* writeLine(
              socket,
              JSON.stringify({
                ...info,
                request: { command: "open", cwd: "/disconnected", scope: { kind: "uncommitted" } },
              }),
            );
            expect(JSON.parse(yield* next)).toHaveProperty("progress");
          }),
        );
        progressGate = undefined;
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(gate, undefined);
        const published = () =>
          [...files.values()].some((session) => session.repoRoot === "/disconnected");
        yield* Effect.sync(published).pipe(
          Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("2 seconds"),
        );
        // The source lock was released: the next capture runs and reports to its own client.
        const reply = yield* open("/after-disconnect").pipe(Effect.timeout("2 seconds"));
        expect(reply.ok).toBe(true);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("lets a client skip interim lines it does not understand and still decode the reply", async () => {
    const fakeSocket = join(dataDir, "interim.sock");
    const peer = createServer((socket) => {
      let buffered = "";
      socket.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        if (!buffered.includes("\n")) return;
        const message = JSON.parse(buffered.slice(0, buffered.indexOf("\n")));
        const lines =
          message.command === "daemon.info"
            ? [{ ok: true, value: { version: daemonVersion, instanceId: "interim" } }]
            : [
                { future: "a line kind this client predates" },
                null,
                "a future string line",
                ["an", "array"],
                { progress: { phase: "a later phase", done: 1 } },
                { progress: { phase: "capture", done: 1, total: 2, bytes: 3 } },
                { ok: true, value: { sessions: [] } },
              ];
        const framed = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
        socket.end(message.command === "daemon.info" ? framed : `not json {\n${framed}`);
      });
    });
    await new Promise<void>((resolve) => peer.listen(fakeSocket, resolve));
    try {
      const heard: unknown[] = [];
      const reply = await Effect.runPromise(
        DaemonClient.use((client) =>
          client.request({ command: "list" }, (event) => Effect.sync(() => void heard.push(event))),
        ).pipe(
          Effect.provide(
            DaemonClient.layer.pipe(
              Layer.provide(
                Layer.succeed(Paths, {
                  dataDir,
                  socketPath: fakeSocket,
                  pidPath: join(dataDir, "interim.pid"),
                  deleteReceiptsPath: join(dataDir, "interim-receipts"),
                  sessionFile: (id: string) => join(dataDir, `interim-${id}.json`),
                }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
      expect(reply).toEqual({ sessions: [] });
      expect(heard).toEqual([{ phase: "capture", done: 1, total: 2, bytes: 3 }]);
    } finally {
      await new Promise((resolve) => peer.close(resolve));
    }
  });

  it("releases the published socket when startup fails after the link", async () => {
    // A failing unlink of the private name must not leave `daemon.sock` behind: the release for the
    // shared name has to be registered before anything else fallible runs.
    const failedOnce = { done: false };
    const brokenRemove = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) =>
        FileSystem.make({
          ...fs,
          remove: (path, options) =>
            path === `${socketPath}.${process.pid}` && options === undefined && !failedOnce.done
              ? Effect.sync(() => void (failedOnce.done = true)).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.badArgument({
                        module: "test",
                        method: "remove",
                        description: "injected",
                      }),
                    ),
                  ),
                )
              : fs.remove(path, options),
        }),
      ),
    );
    const exit = await Effect.runPromiseExit(
      DaemonServer.use((server) => server.run).pipe(
        Effect.provide(serverLayerOver(Layer.provideMerge(brokenRemove, NodeServices.layer))),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect((await readdir(dataDir)).filter((name) => name.startsWith("daemon.sock"))).toEqual([]);
  });
});

/** Starts the daemon and returns its fiber and identity once it answers. */
const started = Effect.gen(function* () {
  const server = yield* DaemonServer;
  const running = yield* Effect.forkChild(server.run);
  const hello = yield* exchange({ command: "daemon.info" }).pipe(
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }),
  );
  if (!hello.ok) throw new Error("handshake failed");
  return { running, info: Schema.decodeUnknownSync(DaemonInfoSchema)(hello.value) };
});
/** Opens `cwd`'s session over the socket, with a browser on the viewer its link names. */
const openViewed = Effect.fn("openViewed")(function* (cwd: string) {
  const reply = yield* open(cwd);
  return { id: openedId(reply), browser: browserAt(linkPort(reply)) };
});
const versionOf = (id: string) => {
  const session = files.get(id)!;
  return { sessionId: id, snapshotId: session.snapshotId, revision: session.revision };
};
/** The human toggles Viewed on the session's first hunk against its saved revision. */
const toggle = (browser: ReturnType<typeof browserAt>, id: string, n: number) => {
  const session = files.get(id)!;
  return browser
    .operation({
      command: "viewed",
      session: id,
      snapshotId: session.snapshotId,
      revision: session.revision,
      requestId: `${id}-${n}`,
      hunkIds: [session.hunks[0]!.id],
      viewed: n % 2 === 0,
    })
    .pipe(Effect.map(({ reply }) => reply!));
};

describe("DaemonServer viewer", () => {
  // Each test's daemon loads `files`; earlier tests leave sessions there.
  beforeEach(() => files.clear());

  it("serves the SPA and operations on loopback from the first free port, which every link names", async () => {
    const taken = await occupy(1);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { running } = yield* started;
          const opened = yield* open("/served");
          const port = linkPort(opened);
          expect(port).toBe(taken.first + 1);
          const id = openedId(opened);
          expect(opened.ok && opened.value).toMatchObject({
            created: true,
            link: `http://localhost:${port}/session/${id}`,
          });
          // Reopening names the same port: the daemon keeps it for its lifetime.
          expect(linkPort(yield* send({ command: "open", session: id }))).toBe(port);
          // Loopback IPv4 only.
          expect(yield* Effect.promise(() => refused(port, "::1"))).toBe(true);

          const browser = browserAt(port);
          const shell = yield* browser.get(`/session/${id}`);
          expect([shell.status, shell.body, shell.header("referrer-policy")]).toEqual([
            200,
            indexHtml,
            "no-referrer",
          ]);
          // A browser behind an SSH forward on another local port names that port.
          const forwarded = browserAt(port, "localhost:14978");
          expect((yield* forwarded.get(`/session/${id}`)).status).toBe(200);
          const listed = yield* forwarded.operation({ command: "list" });
          expect(listed.status).toBe(200);
          expect(listed.reply).toMatchObject({ ok: true, value: { sessions: [{ id }] } });
          const reopened = yield* browser.operation({ command: "open", session: id });
          expect(reopened.reply).toMatchObject({
            ok: true,
            value: {
              created: false,
              session: { id },
              link: `http://localhost:${port}/session/${id}`,
            },
          });
          // A DNS-rebinding name resolves to loopback too, but is not a loopback name.
          const rebound = browserAt(port, `attacker.example:${port}`);
          expect((yield* rebound.get(`/session/${id}`)).status).toBe(403);
          expect((yield* rebound.operation({ command: "list" })).status).toBe(403);
          yield* Fiber.interrupt(running);
          expect(yield* Effect.promise(() => refused(port))).toBe(true);
        }).pipe(
          Effect.provide(
            serverLayerOver(
              NodeServices.layer,
              viewerSettings(() => String(taken.first)),
            ),
          ),
        ),
      );
    } finally {
      await taken.release();
    }
  }, 10_000);

  it("fails opening with an error naming the range while every port is taken, then binds one", async () => {
    const taken = await occupy(10);
    const range = `127.0.0.1:${taken.first}-${taken.first + 9}`;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { running } = yield* started;
          // Socket operations need no viewer.
          expect(yield* send({ command: "list" })).toEqual({ ok: true, value: { sessions: [] } });
          const refusedOpen = yield* open("/no-port");
          expect(refusedOpen.ok ? refusedOpen : refusedOpen.error).toMatchObject({
            _tag: "daemon_unreachable",
            message: expect.stringContaining(range),
          });
          expect(files.size).toBe(0);
          yield* Effect.promise(() => taken.release());
          const opened = yield* open("/port-freed");
          expect(linkPort(opened)).toBe(taken.first);
          yield* Fiber.interrupt(running);
        }).pipe(
          Effect.provide(
            serverLayerOver(
              NodeServices.layer,
              viewerSettings(() => String(taken.first)),
            ),
          ),
        ),
      );
    } finally {
      await taken.release();
    }
  }, 10_000);

  it("names an invalid GYST_PORT when opening", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running } = yield* started;
        const reply = yield* open("/bad-port");
        expect(reply.ok ? reply : reply.error).toMatchObject({
          _tag: "daemon_unreachable",
          message: "GYST_PORT must be a port number from 1 to 65535",
        });
        yield* Fiber.interrupt(running);
      }).pipe(
        Effect.provide(
          serverLayerOver(
            NodeServices.layer,
            viewerSettings(() => "70000"),
          ),
        ),
      ),
    );
  }, 10_000);

  it("streams ready, each committed change, then deleted and the end", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running, info } = yield* started;
        const { id, browser } = yield* openViewed("/subscribed");
        const stream = yield* browser.events(id);
        expect([stream.status, stream.header("content-type")]).toEqual([200, "text/event-stream"]);
        const next = framesOf(stream);
        expect(yield* next).toEqual({ kind: "ready", daemon: info.instanceId, ...versionOf(id) });
        expect((yield* toggle(browser, id, 0)).ok).toBe(true);
        expect(yield* next).toEqual({ kind: "changed", ...versionOf(id) });
        expect((yield* toggle(browser, id, 1)).ok).toBe(true);
        expect(yield* next).toEqual({ kind: "changed", ...versionOf(id) });
        expect(ok(yield* remove(id))).toBe(true);
        expect(yield* next).toEqual({ kind: "deleted", sessionId: id });
        expect(yield* next).toBeUndefined();
        // Nothing else holds the daemon: the final delete still lets it exit idle.
        yield* Fiber.join(running).pipe(Effect.timeout("2 seconds"));
      }).pipe(Effect.scoped, Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("refuses an unknown session with one failed frame, and malformed browser input with bad_args", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running } = yield* started;
        const { id, browser } = yield* openViewed("/refused");
        const before = files.get(id);
        const unknown = framesOf(yield* browser.events("missing"));
        expect(yield* unknown).toMatchObject({ kind: "failed", error: { code: "no_session" } });
        expect(yield* unknown).toBeUndefined();
        const malformed = yield* browser.operation({ command: "list", extra: true });
        expect([malformed.status, malformed.reply?.ok]).toEqual([400, false]);
        expect(files.get(id)).toBe(before);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.scoped, Effect.provide(serverLayer)),
    );
  }, 10_000);

  it("never misses a mutation that races the subscription", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running } = yield* started;
        const { id, browser } = yield* openViewed("/race");
        const seen = { inReady: 0, asChange: 0 };
        for (let n = 0; n < 20; n++) {
          const [stream, mutated] = yield* Effect.all(
            [
              Effect.sleep(`${n % 4} millis`).pipe(Effect.andThen(browser.events(id))),
              toggle(browser, id, n),
            ],
            { concurrency: "unbounded" },
          );
          expect(mutated.ok).toBe(true);
          const final = versionOf(id).revision;
          const next = framesOf(stream);
          const ready = yield* next;
          if (ready.kind !== "ready") throw new Error(`expected ready, got ${ready.kind}`);
          if (ready.revision === final) seen.inReady++;
          else {
            expect(yield* next).toEqual({ kind: "changed", ...versionOf(id) });
            seen.asChange++;
          }
          stream.close();
        }
        expect(seen.inReady + seen.asChange).toBe(20);
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 20_000);

  it("coalesces changes for a subscriber that stops reading, which then catches up to the latest", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { running } = yield* started;
        const { id, browser } = yield* openViewed("/stalled");
        // Not read while the human keeps toggling: nothing may leave it silently behind.
        const stalled = yield* browser.events(id);
        for (let n = 0; n < 200; n++) expect((yield* toggle(browser, id, n)).ok).toBe(true);
        const latest = versionOf(id).revision;
        expect(latest).toBe(200);
        const next = framesOf(stalled);
        let frame = yield* next;
        expect(frame).toMatchObject({ kind: "ready" });
        while (frame.revision < latest) frame = yield* next;
        expect(frame).toEqual({ kind: "changed", ...versionOf(id) });
        stalled.close();
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(serverLayer)),
    );
  }, 30_000);

  it("admits a newer daemon's restart with a subscription open, which ends, and the next daemon serves the same port", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          const opened = yield* open("/restart");
          const id = openedId(opened);
          const browser = browserAt(linkPort(opened));
          expect((yield* toggle(browser, id, 0)).ok).toBe(true);
          const next = framesOf(yield* browser.events(id));
          expect(yield* next).toMatchObject({ kind: "ready", revision: versionOf(id).revision });
          const saved = yield* inspectSavedSessions;
          expect(
            yield* exchange({
              command: "daemon.restart",
              version: "999.0.0",
              instanceId: info.instanceId,
              fingerprint: saved.fingerprint,
            }),
          ).toEqual({ ok: true, value: { restarting: true } });
          expect(yield* next).toBeUndefined();
          yield* Fiber.join(running).pipe(Effect.timeout("2 seconds"));
          return { info, id, port: linkPort(opened) };
        }).pipe(Effect.scoped, Effect.provide(serverLayer));
        // The next daemon is a new generation over the same committed state, at the same address,
        // so an open tab's resubscription reaches it.
        yield* Effect.gen(function* () {
          const { running, info } = yield* started;
          expect(info.instanceId).not.toBe(first.info.instanceId);
          const next = framesOf(yield* browserAt(first.port).events(first.id));
          expect(yield* next).toEqual({
            kind: "ready",
            daemon: info.instanceId,
            ...versionOf(first.id),
          });
          expect(versionOf(first.id).revision).toBe(1);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.scoped, Effect.provide(serverLayer));
      }).pipe(Effect.provide(paths), Effect.provide(NodeServices.layer)),
    );
  }, 10_000);
});
