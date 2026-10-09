import {
  BadArgs,
  DaemonUnreachable,
  InternalError,
  NoSession,
  SourceUnavailable,
  StaleRevision,
  ValidationFailed,
} from "@gyst/core/wire";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  events,
  isDaemonError,
  isExpectedFailure,
  isUncertain,
  newRequestId,
  operation,
  TransportError,
} from "./api.ts";

// Explicitly mocked transport: these tests pin the viewer's HTTP handling, not the daemon.
const respond = (status: number, body?: unknown) => {
  const fetch = vi.fn(async (_path: string, _init: RequestInit) =>
    body === undefined
      ? new Response(null, { status })
      : new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = {
  id: "s-1",
  repoRoot: "/repo",
  scope: { kind: "range", range: "main...feature" },
  snapshotId: "abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable("expected a failure"),
    (error: unknown) => error,
  );

describe("operation", () => {
  it("posts the raw browser request and decodes its payload", async () => {
    const fetch = respond(200, { ok: true, value: { sessions: [summary] } });
    expect(await operation({ command: "list" })).toEqual({ sessions: [summary] });
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/operation");
    expect(JSON.parse(String(init.body))).toEqual({ command: "list" });
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  });

  it("decodes captured file and code pages, including an unavailable side's reason", async () => {
    const snapshotId = "a".repeat(64);
    const identity = { sessionId: "s-1", snapshotId, file: "src/a.ts", side: "new" } as const;
    const page = {
      ...identity,
      content: {
        kind: "text",
        size: 7,
        start: { line: 1, offset: 0 },
        text: "\uFEFFa\r\n",
        next: { line: 2, offset: 6 },
      },
    };
    respond(200, { ok: true, value: page });
    const request = { command: "code", session: "s-1", snapshotId, file: "src/a.ts" } as const;
    expect(await operation({ ...request, side: "new" })).toEqual(page);
    const unavailable = { ...identity, content: { kind: "unavailable", reason: "binary" } };
    respond(200, { ok: true, value: unavailable });
    expect(await operation({ ...request, side: "new" })).toEqual(unavailable);
    const files = {
      sessionId: "s-1",
      snapshotId,
      total: 1,
      files: [
        {
          path: "src/a.ts",
          old: { kind: "absent" },
          new: { kind: "unavailable", reason: "symlink" },
        },
      ],
      next: null,
    };
    respond(200, { ok: true, value: files });
    expect(await operation({ command: "files", session: "s-1", snapshotId })).toEqual(files);
  });

  it("throws a domain error Reply as its DaemonError", async () => {
    respond(200, { ok: false, error: { code: "no_session", message: "no session with id x" } });
    expect(await reason(operation({ command: "open", session: "x" }))).toBeInstanceOf(NoSession);
  });

  it.each([
    [400, { ok: false, error: { code: "bad_args", message: "bad" } }, BadArgs],
    [503, { ok: false, error: { code: "daemon_unreachable", message: "down" } }, DaemonUnreachable],
  ])("uses the error Reply carried by HTTP %i", async (status, body, error) => {
    respond(status, body);
    expect(await reason(operation({ command: "list" }))).toBeInstanceOf(error);
  });

  it.each([
    [403, undefined, "forbidden"],
    [503, undefined, "unavailable"],
    [400, undefined, "unexpected"],
    [404, undefined, "unexpected"],
    [405, undefined, "unexpected"],
    [500, { ok: true, value: { sessions: [] } }, "unexpected"],
    [200, "<!doctype html>", "unexpected"],
    [200, { ok: true, value: { sessions: [], extra: 1 } }, "unexpected"],
  ])("maps HTTP %i with body %j to %s", async (status, body, expected) => {
    respond(status, body);
    const error = await reason(operation({ command: "list" }));
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ reason: expected });
  });

  it("reports an unreachable daemon", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await reason(operation({ command: "list" }))).toMatchObject({ reason: "unavailable" });
  });
});

describe("events", () => {
  const ready = {
    kind: "ready",
    daemon: "d1",
    sessionId: "s-1",
    snapshotId: "abc",
    revision: 2,
    conversations: "v1",
  };
  const changed = {
    kind: "changed",
    sessionId: "s-1",
    snapshotId: "abc",
    revision: 3,
    conversations: "v1",
  };
  const deleted = { kind: "deleted", sessionId: "s-1" };
  /** The viewer's WebSocket, driven by the test as the daemon would drive it. */
  class FakeSocket extends EventTarget {
    static last: FakeSocket;
    closedByViewer = false;
    constructor(readonly url: URL) {
      super();
      FakeSocket.last = this;
    }
    // A real socket then waits in CLOSING for the daemon's reply, which a stalled one never sends.
    close() {
      this.closedByViewer = true;
    }
    send(...messages: unknown[]) {
      for (const data of messages)
        this.dispatchEvent(
          new MessageEvent("message", {
            data: typeof data === "string" ? data : JSON.stringify(data),
          }),
        );
    }
    end(code: number) {
      this.dispatchEvent(new CloseEvent("close", { code }));
    }
  }
  const subscribe = (signal = new AbortController().signal) => {
    vi.stubGlobal("location", new URL("http://localhost:14978/session/s-1"));
    vi.stubGlobal("WebSocket", FakeSocket);
    const seen: unknown[] = [];
    const done = (async () => {
      for await (const event of events("s-1", signal)) seen.push(event);
    })();
    return { socket: FakeSocket.last, seen, done };
  };

  it("subscribes over a WebSocket on the page's own host and ends when the daemon closes cleanly", async () => {
    const { socket, seen, done } = subscribe();
    expect(String(socket.url)).toBe("ws://localhost:14978/api/events?session=s-1");
    socket.send(ready, changed, deleted);
    socket.end(1000);
    await done;
    expect(seen).toEqual([ready, changed, deleted]);
  });

  it("decodes a failed message's error as its DaemonError", async () => {
    const { socket, seen, done } = subscribe();
    socket.send({ kind: "failed", error: { code: "no_session", message: "gone" } });
    socket.end(1000);
    await done;
    const [event] = seen as [{ kind: string; error: unknown }];
    expect(event.kind).toBe("failed");
    expect(event.error).toBeInstanceOf(NoSession);
  });

  it.each([
    ["an excess field", { ...ready, extra: 1 }],
    ["an unknown kind", { kind: "other" }],
    ["a missing field", { kind: "changed", sessionId: "s-1", revision: 3 }],
    ["text that is not JSON", '{"kind":'],
  ])("refuses %s as unreadable", async (_name, event) => {
    const { socket, seen, done } = subscribe();
    socket.send(ready, event);
    expect(await reason(done)).toMatchObject({ reason: "unexpected" });
    expect(seen).toEqual([ready]);
    expect(socket.closedByViewer).toBe(true);
  });

  it("reports any other close, a refused handshake included, as an unreachable daemon", async () => {
    const { socket, seen, done } = subscribe();
    socket.send(ready);
    socket.end(1006);
    expect(await reason(done)).toMatchObject({ reason: "unavailable" });
    expect(seen).toEqual([ready]);
  });

  it("lets go of the connection when the reader stops or its signal aborts", async () => {
    vi.stubGlobal("location", new URL("http://localhost:14978/session/s-1"));
    vi.stubGlobal("WebSocket", FakeSocket);
    const reader = events("s-1", new AbortController().signal);
    const first = reader.next();
    FakeSocket.last.send(ready);
    expect((await first).value).toEqual(ready);
    await reader.return();
    expect(FakeSocket.last.closedByViewer).toBe(true);

    const controller = new AbortController();
    const { socket, seen, done } = subscribe(controller.signal);
    socket.send(ready);
    await vi.waitFor(() => expect(seen).toEqual([ready]));
    controller.abort();
    await done;
    expect(socket.closedByViewer).toBe(true);
  });
});

it("mints distinct 128-bit request ids", () => {
  const [a, b] = [newRequestId(), newRequestId()];
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
});

describe("isExpectedFailure", () => {
  it.each([
    new TransportError("forbidden", "m"),
    new TransportError("unavailable", "m"),
    new NoSession({ message: "m" }),
    new DaemonUnreachable({ message: "m" }),
    new StaleRevision({ message: "m" }),
    new SourceUnavailable({ message: "m", detail: { reason: "gh_missing" } }),
  ])("explains %s in place without a diagnostic", (error) => {
    expect(isExpectedFailure(error)).toBe(true);
  });

  it.each([
    new TransportError("unexpected", "m"),
    new InternalError({ message: "m" }),
    new BadArgs({ message: "m" }),
    new ValidationFailed({ message: "m" }),
    new TypeError("render failed"),
    "thrown string",
  ])("keeps a diagnostic for %s", (error) => {
    expect(isExpectedFailure(error)).toBe(false);
  });
});

describe("isDaemonError", () => {
  it("matches the daemon's domain errors, by tag when one is given", () => {
    const stale = new StaleRevision({ message: "m" });
    expect(isDaemonError(stale)).toBe(true);
    expect(isDaemonError(stale, "stale_revision")).toBe(true);
    expect(isDaemonError(stale, "no_session")).toBe(false);
    expect(isDaemonError(new TransportError("unavailable", "m"))).toBe(false);
    expect(isDaemonError({ _tag: "stale_revision" }, "stale_revision")).toBe(false);
    expect(isDaemonError(undefined, "stale_revision")).toBe(false);
  });
});

describe("isUncertain", () => {
  it.each([
    [new TransportError("unavailable", "m"), true],
    [new TransportError("unexpected", "m"), true],
    [new DaemonUnreachable({ message: "m" }), true],
    [new TransportError("forbidden", "m"), false],
    [new StaleRevision({ message: "m" }), false],
    [new ValidationFailed({ message: "m" }), false],
    [new NoSession({ message: "m" }), false],
    [new BadArgs({ message: "m" }), false],
    [new InternalError({ message: "m" }), false],
    [new TypeError("render failed"), false],
  ])("says whether %s may have been applied: %s", (error, expected) => {
    expect(isUncertain(error)).toBe(expected);
  });
});
