import {
  BadArgs,
  DaemonUnreachable,
  InternalError,
  NoSession,
  ValidationFailed,
} from "@gyst/core/wire";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bootstrap, isExpectedFailure, newRequestId, operation, TransportError } from "./api.ts";

// Explicitly mocked transport: these tests pin the viewer's HTTP handling, not the launcher.
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

describe("bootstrap", () => {
  it("posts the secret as a bearer credential and accepts 204", async () => {
    const fetch = respond(204);
    expect(await bootstrap("secret-1")).toBe(true);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/bootstrap");
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer secret-1" } });
    expect(init.body).toBeUndefined();
  });

  it("leaves a rejected secret to the existing cookie", async () => {
    respond(401);
    expect(await bootstrap("expired")).toBe(false);
  });

  it("reports a refused host without echoing the secret", async () => {
    respond(403);
    const error = await reason(bootstrap("secret-2"));
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ reason: "forbidden" });
    expect((error as Error).message).not.toContain("secret-2");
  });
});

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
    [401, undefined, "unauthorized"],
    [401, { ok: true, value: { sessions: [] } }, "unauthorized"],
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

  it("reports an unreachable launcher", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await reason(operation({ command: "list" }))).toMatchObject({ reason: "unavailable" });
  });
});

it("mints distinct 128-bit request ids", () => {
  const [a, b] = [newRequestId(), newRequestId()];
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
});

describe("isExpectedFailure", () => {
  it.each([
    new TransportError("unauthorized", "m"),
    new TransportError("forbidden", "m"),
    new TransportError("unavailable", "m"),
    new NoSession({ message: "m" }),
    new DaemonUnreachable({ message: "m" }),
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
