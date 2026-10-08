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
  const ready = { kind: "ready", daemon: "d1", sessionId: "s-1", snapshotId: "abc", revision: 2 };
  const changed = { kind: "changed", sessionId: "s-1", snapshotId: "abc", revision: 3 };
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  // A stream answering with these chunks as they are split on the wire, then ending unless held
  // open; `seen.cancelled` says whether the reader let go of it.
  const stream = (
    chunks: string[],
    contentType = "text/event-stream; charset=utf-8",
    held = false,
  ) => {
    const seen = { cancelled: false };
    const encoder = new TextEncoder();
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (!held) controller.close();
        },
        cancel() {
          seen.cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    });
    vi.stubGlobal("fetch", fetch);
    return Object.assign(fetch, { seen });
  };
  const all = async (signal = new AbortController().signal) => {
    const seen: unknown[] = [];
    for await (const event of events("s-1", signal)) seen.push(event);
    return seen;
  };

  it("posts the session with the operation's credentials and the caller's signal", async () => {
    const fetch = stream([frame(ready)]);
    const signal = new AbortController().signal;
    expect(await all(signal)).toEqual([ready]);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/events");
    expect(JSON.parse(String(init.body))).toEqual({ session: "s-1" });
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init.signal).toBe(signal);
  });

  it("reads frames split across chunks and several in one chunk, and ends with the stream", async () => {
    const text = frame(ready) + frame(changed) + frame({ kind: "deleted", sessionId: "s-1" });
    stream([text.slice(0, 7), text.slice(7, 40), text.slice(40, -1), text.slice(-1)]);
    expect(await all()).toEqual([ready, changed, { kind: "deleted", sessionId: "s-1" }]);
    stream([frame(ready) + frame(changed)]);
    expect(await all()).toEqual([ready, changed]);
  });

  it("drops an event the stream ended before finishing, and skips frames without data", async () => {
    stream([": comment\n\n", frame(ready), 'data: {"kind":']);
    expect(await all()).toEqual([ready]);
  });

  it("decodes a failed frame's error as its DaemonError", async () => {
    stream([frame({ kind: "failed", error: { code: "no_session", message: "gone" } })]);
    const [event] = (await all()) as [{ kind: string; error: unknown }];
    expect(event.kind).toBe("failed");
    expect(event.error).toBeInstanceOf(NoSession);
  });

  it.each([
    ["an excess field", { ...ready, extra: 1 }],
    ["an unknown kind", { kind: "other" }],
    ["a missing field", { kind: "changed", sessionId: "s-1", revision: 3 }],
  ])("refuses %s as unreadable", async (_name, event) => {
    stream([frame(ready), frame(event)]);
    const seen: unknown[] = [];
    const error = await reason(
      (async () => {
        for await (const next of events("s-1", new AbortController().signal)) seen.push(next);
      })(),
    );
    expect(seen).toEqual([ready]);
    expect(error).toMatchObject({ reason: "unexpected" });
  });

  it("refuses a reply that is not an event stream", async () => {
    stream([JSON.stringify({ ok: true, value: {} })], "application/json");
    expect(await reason(all())).toMatchObject({ reason: "unexpected" });
  });

  it.each([
    [403, "forbidden"],
    [503, "unavailable"],
    [400, "unexpected"],
    [405, "unexpected"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    respond(status);
    const error = await reason(all());
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ reason: expected });
  });

  it("reports an unreachable daemon, and lets go of the stream when the reader stops", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await reason(all())).toMatchObject({ reason: "unavailable" });
    const fetch = stream([frame(ready), frame(changed)], undefined, true);
    for await (const event of events("s-1", new AbortController().signal)) {
      expect(event).toEqual(ready);
      break;
    }
    await vi.waitFor(() => expect(fetch.seen.cancelled).toBe(true));
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
