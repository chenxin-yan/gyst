import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  navigationAddon,
  navigationInstallCommand,
  type Session,
  type SnapshotManifest,
} from "@gyst/core";
import { Crypto, Effect, Fiber, Layer, Schedule, Tracer } from "effect";
import * as Socket from "effect/socket/Socket";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../daemon/client.ts";
import { manifestOf, noGitHub, publishingContent } from "../daemon/capture-doubles.ts";
import { CapturedContent } from "../daemon/content.ts";
import { Git } from "../daemon/git.ts";
import { Navigation } from "../daemon/navigation.ts";
import { Paths } from "../daemon/paths.ts";
import { daemonVersion } from "../daemon/protocol.ts";
import { DaemonServer } from "../daemon/server.ts";
import { Sessions } from "../daemon/sessions.ts";
import { SessionStore } from "../daemon/store.ts";
import { readLine, writeLine } from "../daemon/wire.ts";
import { browserOpener, serveViewer, type ViewerOpen } from "./launcher.ts";
import { indexHtml, openStream, type RawStream, send, webUiFixture } from "../../tests/http.ts";

const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+two
`;

let dataDir: string;
let fixture: Awaited<ReturnType<typeof webUiFixture>>;
const files = new Map<string, Session>();
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gyst-launcher-"));
  fixture = await webUiFixture();
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(fixture.root, { recursive: true, force: true });
});

// The real daemon (Sessions, socket server) and the real DaemonClient, over a private socket;
// only Git capture and the session files are in memory.
const paths = Layer.sync(Paths, () => ({
  dataDir,
  socketPath: join(dataDir, "daemon.sock"),
  pidPath: join(dataDir, "daemon.pid"),
  deleteReceiptsPath: join(dataDir, "delete-receipts"),
  sessionFile: (id: string) => join(dataDir, `${id}.json`),
}));
const git = Layer.succeed(Git, {
  repoRoot: (cwd) => Effect.succeed(cwd),
  capture: (_root, scope) => Effect.succeed(manifestOf(patch, scope)),
  capturePullRequest: () => Effect.die("no PR captures in this test"),
  pullRequestRange: () => Effect.die("no PR ranges in this test"),
});
const receipts: Array<{ requestId: string; sessionId: string }> = [];
const store = Layer.succeed(SessionStore, {
  loadAll: Effect.sync(() => [...files.values()]),
  save: (session) => Effect.sync(() => void files.set(session.id, session)),
  remove: (id) => Effect.sync(() => void files.delete(id)),
  loadDeleteReceipts: Effect.sync(() => receipts),
  saveDeleteReceipts: (next) => Effect.sync(() => void receipts.splice(0, Infinity, ...next)),
});
// Published manifests stay readable, so snapshot reads (navigation readiness) see them.
const manifests = new Map<string, SnapshotManifest>();
const content = Layer.effect(
  CapturedContent,
  Effect.map(CapturedContent, (publishing) => ({
    ...publishing,
    putManifest: (manifest: SnapshotManifest) =>
      Effect.tap(publishing.putManifest(manifest), (id) =>
        Effect.sync(() => void manifests.set(id, manifest)),
      ),
    loadManifest: (id: string) => Effect.sync(() => manifests.get(id)!),
  })),
).pipe(Layer.provide(publishingContent()));
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
/** One daemon generation: each build has its own instance id and loads the saved sessions anew. */
const daemonLayer = DaemonServer.layer.pipe(
  Layer.provideMerge(
    Navigation.layer.pipe(
      Layer.provideMerge(
        Sessions.layer.pipe(Layer.provide(Layer.mergeAll(git, noGitHub, store, crypto))),
      ),
      Layer.provide(publishingContent()),
    ),
  ),
  Layer.provide(paths),
  Layer.provide(NodeServices.layer),
);
const clientLayer = DaemonClient.layer.pipe(
  Layer.provide(paths),
  Layer.provideMerge(NodeServices.layer),
);
const layer = Layer.merge(daemonLayer, clientLayer);

/** A raw socket probe, so the client never has to spawn a daemon while this one starts. */
const daemonAnswers = Effect.gen(function* () {
  const socket = yield* NodeSocket.makeNet({ path: join(dataDir, "daemon.sock") });
  const pull = yield* Socket.readerBytes(socket);
  yield* writeLine(socket, JSON.stringify({ command: "daemon.info" }));
  return yield* readLine(pull);
}).pipe(Effect.scoped);

const viewerUrl = /^(http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+))(\/session\/[^#\s]+)#(\S+)$/m;

/** Starts a viewer and reads its printed private URL (kept out of assertion messages). */
const startViewer = (open: ViewerOpen, opener?: string, launchPath?: string) =>
  Effect.gen(function* () {
    const printed: string[] = [];
    const fiber = yield* Effect.forkChild(
      serveViewer(open, {
        webUiDir: fixture.dir,
        opener,
        stdout: (text) => printed.push(text),
        launchPath,
      }),
    );
    yield* Effect.sync(() => printed.length > 0).pipe(
      Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("10 millis") }),
      Effect.timeout("5 seconds"),
    );
    const match = viewerUrl.exec(printed[0]!);
    const port = Number(match?.[3]);
    const host = `${match?.[2]}:${port}`;
    const headers = [["host", host]] as Array<readonly [string, string]>;
    const origin = ["origin", match?.[1] ?? ""] as const;
    let cookie = "";
    const bootstrap = (token = match?.[5] ?? "") =>
      Effect.promise(() =>
        send(port, {
          method: "POST",
          target: "/bootstrap",
          headers: [...headers, origin, ["authorization", `Bearer ${token}`]],
        }),
      ).pipe(
        Effect.tap((response) =>
          Effect.sync(() => void (cookie ||= response.header("set-cookie")?.split(";")[0] ?? "")),
        ),
      );
    const operation = (body: unknown, withCookie = () => cookie) =>
      Effect.promise(() =>
        send(port, {
          method: "POST",
          target: "/api/operation",
          headers: [...headers, origin, ["cookie", withCookie()]],
          body: JSON.stringify(body),
        }),
      ).pipe(
        Effect.map((response) => ({
          status: response.status,
          reply: JSON.parse(response.body || "null"),
        })),
      );
    const events = (session: string) =>
      Effect.promise(() =>
        openStream(port, {
          target: "/api/events",
          headers: [...headers, origin, ["cookie", cookie]],
          body: JSON.stringify({ session }),
        }),
      );
    return {
      fiber,
      printed,
      events,
      match,
      port,
      host,
      sessionPath: match?.[4],
      cookie: () => cookie,
      bootstrap,
      operation,
      get: (target: string) => Effect.promise(() => send(port, { target, headers })),
    };
  });

/** Reads one bridge stream's frames in order; `undefined` once the bridge ends the response. */
const framesOf = (stream: RawStream) => {
  const frames = stream.frames();
  return Effect.promise(() => frames.next()).pipe(
    Effect.map((frame) => (frame.done ? undefined : JSON.parse(frame.value))),
    Effect.timeout("5 seconds"),
  );
};

/** A human Viewed toggle on the session's only hunk, against its saved snapshot and revision. */
const toggleViewed = (id: string, requestId: string) => {
  const session = files.get(id)!;
  return {
    command: "viewed",
    session: id,
    snapshotId: session.snapshotId,
    revision: session.revision,
    requestId,
    hunkIds: [session.hunks[0]!.id],
    viewed: session.viewedHunkIds.length === 0,
  } as const;
};
const versionOf = (id: string) => {
  const session = files.get(id)!;
  return { sessionId: id, snapshotId: session.snapshotId, revision: session.revision };
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

describe("browserOpener", () => {
  it("opens only for an interactive local desktop, else the operator gets the URL", () => {
    expect(browserOpener("darwin", {}, true)).toBe("open");
    expect(browserOpener("linux", { DISPLAY: ":0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", { WAYLAND_DISPLAY: "wayland-0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", {}, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":0" }, false)).toBeUndefined();
    expect(browserOpener("darwin", { SSH_CONNECTION: "1 2 3 4" }, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":10", SSH_TTY: "/dev/pts/1" }, true)).toBeUndefined();
    expect(browserOpener("win32", {}, true)).toBeUndefined();
  });
});

describe("serveViewer", () => {
  it("serves launches through the real daemon client; stopping one leaves the daemon and others", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });

        // Without the packaged SPA the launch fails before touching the daemon.
        const missing = yield* serveViewer(
          { command: "open", cwd: "/repo-a", scope: { kind: "uncommitted" } },
          {
            webUiDir: join(fixture.root, "absent"),
            opener: undefined,
            stdout: () => {},
            launchPath: undefined,
          },
        ).pipe(Effect.flip);
        expect(missing._tag).toBe("internal_error");
        expect(files.size).toBe(0);

        const a = yield* startViewer({
          command: "open",
          cwd: "/repo-a",
          scope: { kind: "uncommitted" },
        });
        const b = yield* startViewer({
          command: "open",
          cwd: "/repo-b",
          scope: { kind: "range", range: "main...feature" },
        });
        const [idA = "", idB = ""] = [...files.values()].map((session) => session.id);
        expect(a.match !== null && b.match !== null).toBe(true);
        expect(a.sessionPath).toBe(`/session/${idA}`);
        expect(b.sessionPath).toBe(`/session/${idB}`);
        // Printed text holds the bootstrap secret: assert booleans, never render it.
        expect(a.printed[0]!.endsWith("\nPress Ctrl-C to stop the viewer.")).toBe(true);
        // Loopback IPv4 only.
        expect(yield* Effect.promise(() => refused(a.port, "::1"))).toBe(true);

        const shell = yield* a.get(a.sessionPath!);
        expect([shell.status, shell.body]).toEqual([200, indexHtml]);
        expect((yield* a.operation({ command: "list" })).status).toBe(401);
        expect((yield* a.bootstrap()).status).toBe(204);
        expect((yield* b.bootstrap()).status).toBe(204);
        expect(a.cookie() !== b.cookie()).toBe(true);

        const listed = yield* a.operation({ command: "list" });
        expect(listed.status).toBe(200);
        expect(
          listed.reply.value.sessions.map((session: { id: string }) => session.id).toSorted(),
        ).toEqual([idA, idB].toSorted());
        const reopened = yield* a.operation({ command: "open", session: idA });
        expect(reopened.reply).toMatchObject({
          ok: true,
          value: { created: false, session: { id: idA } },
        });
        const diff = yield* a.operation({ command: "diff", session: idA });
        expect(
          diff.reply.value.hunks.map((hunk: { patch: string }) => hunk.patch).join(""),
        ).toContain("+two");
        const deleted = yield* a.operation({ command: "delete", session: idA, requestId: "r1" });
        expect(deleted.reply).toEqual({ ok: true, value: { deleted: true, sessionId: idA } });
        expect(
          (yield* a.operation({ command: "delete", session: idA, requestId: "r1" })).reply,
        ).toEqual(deleted.reply);
        expect((yield* a.operation({ command: "status", session: idA })).reply).toMatchObject({
          ok: false,
          error: { code: "no_session" },
        });

        // Cross-launch: A's credentials mean nothing to B.
        expect((yield* b.bootstrap(a.match?.[5])).status).toBe(401);
        expect((yield* b.operation({ command: "list" }, a.cookie)).status).toBe(401);

        // Ctrl-C on A ends A's HTTP lifetime only.
        yield* Fiber.interrupt(a.fiber);
        expect(yield* Effect.promise(() => refused(a.port))).toBe(true);
        expect(daemon.pollUnsafe()).toBeUndefined();
        const afterA = yield* b.operation({ command: "list" });
        expect(afterA.reply.value.sessions.map((session: { id: string }) => session.id)).toEqual([
          idB,
        ]);
        const client = yield* DaemonClient;
        expect(yield* client.request({ command: "status", session: idB })).toMatchObject({
          session: { id: idB },
        });

        yield* Fiber.interrupt(b.fiber);
        expect(yield* Effect.promise(() => refused(b.port))).toBe(true);
        expect(files.size).toBe(1);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 20_000);

  it("reports a successful opener without printing the private URL, and falls back when it fails", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });
        const open: ViewerOpen = {
          command: "open",
          cwd: "/repo-c",
          scope: { kind: "uncommitted" },
        };

        const opened = yield* startViewer(open, "true");
        expect(/^Opened session \S+ in your browser\. Press Ctrl-C/.test(opened.printed[0]!)).toBe(
          true,
        );
        expect(opened.printed.join("").includes("#")).toBe(false);
        yield* Fiber.interrupt(opened.fiber);

        const fallback = yield* startViewer(open, "false");
        expect(fallback.match !== null).toBe(true);
        yield* Fiber.interrupt(fallback.fiber);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 20_000);
  it("streams one session's committed changes to every launch until that launch or the daemon ends", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DaemonClient;
        let firstDaemon = "";
        const { b, id, saved } = yield* Effect.gen(function* () {
          const server = yield* DaemonServer;
          const daemon = yield* Effect.forkChild(server.run);
          yield* Effect.retry(daemonAnswers, {
            schedule: Schedule.spaced("10 millis"),
            times: 200,
          });
          const a = yield* startViewer({
            command: "open",
            cwd: "/repo-live",
            scope: { kind: "uncommitted" },
          });
          const id = decodeURIComponent(a.sessionPath!.slice("/session/".length));
          // A second launch of the same saved session, as `gyst web --session` opens it.
          const b = yield* startViewer({ command: "open", session: id });
          expect(b.sessionPath).toBe(a.sessionPath);
          expect((yield* a.bootstrap()).status).toBe(204);
          expect((yield* b.bootstrap()).status).toBe(204);

          // A stream opened without the launch cookie never reaches the daemon.
          const anonymous = yield* Effect.promise(() =>
            send(a.port, {
              method: "POST",
              target: "/api/events",
              headers: [
                ["host", a.host],
                ["origin", a.match?.[1] ?? ""],
              ],
              body: JSON.stringify({ session: id }),
            }),
          );
          expect(anonymous.status).toBe(401);

          // Initial race: a commit between the stream's head and its first frame is not missed.
          const raced = yield* a.events(id);
          expect([raced.status, raced.header("content-type")]).toEqual([200, "text/event-stream"]);
          const racedFrames = framesOf(raced);
          expect((yield* a.operation(toggleViewed(id, "race"))).reply).toMatchObject({ ok: true });
          const settled = versionOf(id);
          const first = yield* racedFrames;
          expect(first).toMatchObject({ kind: "ready", sessionId: id });
          if (first.revision < settled.revision)
            expect(yield* racedFrames).toEqual({ kind: "changed", ...settled });
          else expect(first.revision).toBe(settled.revision);
          raced.close();

          const streamA = framesOf(yield* a.events(id));
          const streamB = framesOf(yield* b.events(id));
          firstDaemon = JSON.parse(yield* daemonAnswers).value.instanceId;
          const ready = { kind: "ready", daemon: firstDaemon, ...versionOf(id) };
          expect(yield* streamA).toEqual(ready);
          expect(yield* streamB).toEqual(ready);
          expect((yield* b.operation(toggleViewed(id, "both"))).reply).toMatchObject({ ok: true });
          expect(yield* streamA).toEqual({ kind: "changed", ...versionOf(id) });
          expect(yield* streamB).toEqual({ kind: "changed", ...versionOf(id) });

          // Ctrl-C on A ends A's stream and listener only.
          yield* Fiber.interrupt(a.fiber);
          expect(yield* streamA).toBeUndefined();
          expect(yield* Effect.promise(() => refused(a.port))).toBe(true);
          const viaCli = yield* client.request(toggleViewed(id, "after-a"));
          expect(viaCli).toMatchObject({ sessionId: id, revision: versionOf(id).revision });
          expect(yield* streamB).toEqual({ kind: "changed", ...versionOf(id) });
          expect(daemon.pollUnsafe()).toBeUndefined();
          expect(yield* client.request({ command: "status", session: id })).toMatchObject({
            session: { id },
          });

          // The daemon stopping ends B's stream; B's launch stays up.
          yield* Fiber.interrupt(daemon);
          expect(yield* streamB).toBeUndefined();
          expect(b.fiber.pollUnsafe()).toBeUndefined();
          return { b, id, saved: { count: files.size, version: versionOf(id) } };
        }).pipe(Effect.provide(daemonLayer));

        yield* Effect.gen(function* () {
          const server = yield* DaemonServer;
          const daemon = yield* Effect.forkChild(server.run);
          yield* Effect.retry(daemonAnswers, {
            schedule: Schedule.spaced("10 millis"),
            times: 200,
          });
          const { instanceId } = JSON.parse(yield* daemonAnswers).value;
          // Resubscribing reaches the new daemon generation with the same session and revision,
          // and nothing is created anew.
          const again = framesOf(yield* b.events(id));
          const ready = yield* again;
          expect(ready).toEqual({ kind: "ready", daemon: instanceId, ...saved.version });
          expect(instanceId).not.toBe(firstDaemon);
          expect(files.size).toBe(saved.count);
          expect((yield* b.operation(toggleViewed(id, "next-daemon"))).reply).toMatchObject({
            ok: true,
          });
          expect(yield* again).toEqual({ kind: "changed", ...versionOf(id) });

          yield* Fiber.interrupt(b.fiber);
          expect(yield* again).toBeUndefined();
          expect(yield* Effect.promise(() => refused(b.port))).toBe(true);
          expect(daemon.pollUnsafe()).toBeUndefined();
          expect(files.get(id)?.revision).toBe(saved.version.revision + 1);
          yield* Fiber.interrupt(daemon);
        }).pipe(Effect.provide(daemonLayer));
      }).pipe(Effect.scoped, Effect.provide(clientLayer)),
    );
  }, 30_000);

  it("ends a launch's stream that stops reading, then resubscribes at the latest revision", async () => {
    // The daemon's subscription span ending tells the test it dropped the stalled stream.
    const subscription = { dropped: false };
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          if (span.name === "DaemonServer.subscription") subscription.dropped = true;
          end(time, exit);
        };
        return span;
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const sessions = yield* Sessions;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });
        const a = yield* startViewer({
          command: "open",
          cwd: "/repo-stalled",
          scope: { kind: "uncommitted" },
        });
        const id = decodeURIComponent(a.sessionPath!.slice("/session/".length));
        expect((yield* a.bootstrap()).status).toBe(204);

        // Never read: the bridge waits on the browser, its daemon subscription backs up, and the
        // daemon drops it once a change can't be written within a second.
        const stalled = yield* a.events(id);
        expect(stalled.status).toBe(200);
        const deadline = Date.now() + 60_000;
        for (let n = 0; !subscription.dropped && Date.now() < deadline; n++) {
          yield* sessions.viewed(toggleViewed(id, `stalled-${n}`));
          // A turn of the event loop, so each change is written as it commits.
          yield* Effect.promise(() => new Promise((done) => setImmediate(done)));
        }
        expect(subscription.dropped).toBe(true);

        // What was already on the way still arrives, then the stream ends short of the latest
        // revision, so the browser resubscribes rather than staying silently stale.
        const latest = versionOf(id);
        const frames = yield* Effect.promise(async () => {
          const read: Array<{ kind: string; revision: number }> = [];
          for await (const frame of stalled.frames()) read.push(JSON.parse(frame));
          return read;
        });
        expect(frames[0]).toMatchObject({ kind: "ready", sessionId: id });
        expect(frames.slice(1).every((frame) => frame.kind === "changed")).toBe(true);
        expect(frames.at(-1)!.revision).toBeLessThan(latest.revision);
        const again = framesOf(yield* a.events(id));
        expect(yield* again).toMatchObject({ kind: "ready", ...latest });

        yield* Fiber.interrupt(a.fiber);
        expect(yield* again).toBeUndefined();
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.withTracer(tracer), Effect.scoped, Effect.provide(layer)),
    );
  }, 90_000);

  it("looks for the add-on only when navigation is asked, and only on its launch PATH", async () => {
    const bin = await mkdtemp(join(dataDir, "bin-"));
    const log = join(dataDir, "handshakes.log");
    // A stand-in add-on that records each handshake; the handshake runs with an empty environment.
    const script = join(dataDir, "fake-addon.js");
    await writeFile(
      script,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, "ran\\n");\n` +
        `process.stdout.write(JSON.stringify(${JSON.stringify({
          name: navigationAddon.name,
          version: daemonVersion,
          protocol: navigationAddon.protocol,
          engine: { ok: true, version: "7.0.2" },
        })}) + "\\n");\n`,
    );
    await chmod(script, 0o755);
    const handshakes = () =>
      readFile(log, "utf8").then(
        (text) => text.split("\n").filter(Boolean).length,
        () => 0,
      );
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* DaemonServer;
        const daemon = yield* Effect.forkChild(server.run);
        yield* Effect.retry(daemonAnswers, { schedule: Schedule.spaced("10 millis"), times: 200 });
        const viewer = yield* startViewer(
          { command: "open", cwd: "/repo-navigation", scope: { kind: "uncommitted" } },
          undefined,
          `/nonexistent:${bin}`,
        );
        expect((yield* viewer.bootstrap()).status).toBe(204);
        const id = viewer.sessionPath!.slice("/session/".length);
        const status = yield* viewer.operation({ command: "status", session: id });
        const snapshotId: string = status.reply.value.session.snapshotId;
        yield* viewer.operation({ command: "diff", session: id });
        // Launching, opening and reviewing never look for the add-on.
        expect(yield* Effect.promise(handshakes)).toBe(0);

        const readiness = { command: "navigation", session: id, snapshotId };
        expect((yield* viewer.operation(readiness)).reply).toEqual({
          ok: true,
          value: {
            sessionId: id,
            snapshotId,
            addon: { kind: "missing", install: navigationInstallCommand(daemonVersion) },
            sides: {
              old: {
                kind: "unavailable",
                reason: {
                  kind: "addon",
                  addon: { kind: "missing", install: navigationInstallCommand(daemonVersion) },
                },
              },
              new: {
                kind: "unavailable",
                reason: {
                  kind: "addon",
                  addon: { kind: "missing", install: navigationInstallCommand(daemonVersion) },
                },
              },
            },
          },
        });
        yield* Effect.promise(() => symlink(script, join(bin, navigationAddon.bin)));
        const rechecked = yield* viewer.operation({ ...readiness, recheck: true });
        expect(rechecked.reply).toEqual({
          ok: true,
          value: {
            sessionId: id,
            snapshotId,
            addon: { kind: "available", version: daemonVersion },
            sides: { old: { kind: "stopped" }, new: { kind: "stopped" } },
          },
        });
        // The daemon's reply never names where the add-on is.
        expect(JSON.stringify(rechecked.reply)).not.toContain(
          yield* Effect.promise(() => realpath(script)),
        );
        expect(yield* Effect.promise(handshakes)).toBe(1);
        // The discovery is kept for later navigation.
        yield* viewer.operation(readiness);
        expect(yield* Effect.promise(handshakes)).toBe(1);

        yield* Fiber.interrupt(viewer.fiber);
        yield* Fiber.interrupt(daemon);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 20_000);
});
