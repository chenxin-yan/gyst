import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Request } from "@gyst/core";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "./client.ts";
import { Paths } from "./paths.ts";
import { daemonVersion } from "./protocol.ts";

/** Zero-based client dials whose daemon side is destroyed after connecting and before the client writes. */
const dials = vi.hoisted(() => ({
  count: 0,
  hungUp: new Set<number>(),
  server: undefined as Server | undefined,
}));

vi.mock("@effect/platform-node/NodeSocket", async (importOriginal) => {
  const NodeSocket = await importOriginal<typeof import("@effect/platform-node/NodeSocket")>();
  const { createConnection } = await import("node:net");
  const { EventEmitter } = await import("node:events");
  const { Effect } = await import("effect");
  return {
    ...NodeSocket,
    makeNet: (options: { readonly path: string }) => {
      if (!dials.hungUp.has(dials.count++)) return NodeSocket.makeNet(options);
      // The peer's fd is closed before this resolves, so the client's first write gets EPIPE.
      return NodeSocket.fromDuplex(
        Effect.promise(async () => {
          const accepted = EventEmitter.once(dials.server!, "connection");
          const conn = createConnection(options.path);
          const [[peer]] = await Promise.all([accepted, EventEmitter.once(conn, "connect")]);
          (peer as Socket).destroy();
          return conn;
        }),
      );
    },
  };
});

let socketPath: string;
let dataDir: string;
let commands: string[];
/** Handshakes the daemon hangs up on after reading them, instead of replying. */
let lostHandshakes = 0;

/** Answers the handshake as this version; `review` handles every review command's socket. */
async function fakeDaemon(review: (socket: Socket) => void) {
  const server = createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      const message = JSON.parse(buffered.slice(0, end));
      commands.push(message.command ?? message.request.command);
      if (message.command === "daemon.info" && lostHandshakes-- > 0) socket.destroy();
      else if (message.command === "daemon.info")
        socket.end(
          `${JSON.stringify({ ok: true, value: { version: daemonVersion, instanceId: "same" } })}\n`,
        );
      else review(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  dials.server = server;
}

async function closeFakeDaemon() {
  const server = dials.server;
  dials.server = undefined;
  if (server) await new Promise((resolve) => server.close(resolve));
}

const withClient = <A, E>(effect: Effect.Effect<A, E, DaemonClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(DaemonClient.layer),
      Effect.provide(
        Layer.succeed(Paths, {
          dataDir,
          socketPath,
          pidPath: join(dataDir, "daemon.pid"),
          deleteReceiptsPath: join(dataDir, "delete-receipts"),
          sessionFile: (id) => join(dataDir, `${id}.json`),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
const request = (input: Request) =>
  withClient(DaemonClient.use((client) => client.request(input)).pipe(Effect.flip));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-client-"));
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));
afterEach(async () => {
  await closeFakeDaemon();
  dials.count = 0;
  dials.hungUp.clear();
  lostHandshakes = 0;
});

describe("DaemonClient", () => {
  it("redials a handshake whose write failed because the daemon hung up first", async () => {
    socketPath = join(dataDir, "handshake.sock");
    commands = [];
    await fakeDaemon((socket) =>
      socket.end(
        `${JSON.stringify({ ok: false, error: { code: "no_session", message: "none" } })}\n`,
      ),
    );
    dials.hungUp.add(0);
    expect(await request({ command: "status", session: "s1" })).toMatchObject({
      _tag: "no_session",
    });
    expect(commands).toEqual(["daemon.info", "status"]);
  });

  it("redials a handshake whose reply was lost because the daemon hung up after reading it", async () => {
    socketPath = join(dataDir, "handshake-read.sock");
    commands = [];
    await fakeDaemon((socket) =>
      socket.end(
        `${JSON.stringify({ ok: false, error: { code: "no_session", message: "none" } })}\n`,
      ),
    );
    lostHandshakes = 1;
    expect(await request({ command: "status", session: "s1" })).toMatchObject({
      _tag: "no_session",
    });
    expect(commands).toEqual(["daemon.info", "daemon.info", "status"]);
  });

  it("sends a review command once, whether the daemon drops it before or after reading it", async () => {
    for (const hungUp of [false, true]) {
      socketPath = join(dataDir, `review-${hungUp}.sock`);
      commands = [];
      dials.count = 0;
      if (hungUp) dials.hungUp.add(1);
      // Reading the whole frame admits the command: the reply is lost, the mutation may have run.
      await fakeDaemon((socket) => socket.destroy());
      const error = await request({ command: "apply", session: "s1", batch: "{}" });
      expect(error).toMatchObject({
        _tag: "daemon_unreachable",
        message: expect.stringContaining("after sending the command"),
      });
      expect(commands).toEqual(hungUp ? ["daemon.info"] : ["daemon.info", "apply"]);
      expect(dials.count).toBe(2);
      await closeFakeDaemon();
    }
  });
});
