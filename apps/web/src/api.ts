import { webPaths } from "@gyst/core/web";
import {
  type BrowserRequest,
  CodePayloadSchema,
  DaemonError,
  DeletePayloadSchema,
  DiffPayloadSchema,
  FilesPayloadSchema,
  ListPayloadSchema,
  OpenPayloadSchema,
  type Reply,
  ReplySchema,
  SourceCheckPayloadSchema,
  StackPayloadSchema,
  StatusPayloadSchema,
  type SubscriptionEvent,
  SubscriptionEventSchema,
  ViewedPayloadSchema,
} from "@gyst/core/wire";
import { Schema } from "effect";

/**
 * The HTTP hop to the launcher failed before a daemon Reply existed. Domain failures are not
 * TransportErrors: they arrive as the canonical Reply and are thrown as its DaemonError.
 */
export class TransportError extends Error {
  constructor(
    readonly reason: "unauthorized" | "forbidden" | "unavailable" | "unexpected",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const isDaemonError = Schema.is(DaemonError);

/**
 * Failures the viewer explains in place and that say nothing about a gyst defect: sign-in, host,
 * outage, a missing session, a snapshot a refresh replaced and a PR source the host cannot read. Everything else (an unreadable
 * reply, internal_error, rejected input, render exceptions) also deserves a console diagnostic.
 */
export const isExpectedFailure = (error: unknown) =>
  error instanceof TransportError
    ? error.reason !== "unexpected"
    : isDaemonError(error) &&
      (error._tag === "no_session" ||
        error._tag === "daemon_unreachable" ||
        error._tag === "stale_revision" ||
        error._tag === "source_unavailable");

/**
 * Whether a failed write may still have been applied: its reply was lost on the way, so only a
 * resend with the same request id can tell. A refused browser or address never reached gyst.
 */
export const isUncertain = (error: unknown) =>
  error instanceof TransportError
    ? error.reason !== "unauthorized" && error.reason !== "forbidden"
    : isDaemonError(error) && error._tag === "daemon_unreachable";

// Whether this page's launch link was refused, which decides what a later 401 means.
let linkRefused = false;

const unavailable = () =>
  new TransportError(
    "unavailable",
    "Can't reach gyst. The launcher may have stopped; run gyst again to reopen this review.",
  );

const post = (path: string, init: RequestInit) =>
  fetch(path, {
    ...init,
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
  }).catch(() => {
    throw unavailable();
  });

/**
 * Exchanges the launch URL's bootstrap secret for this launch's cookie. Resolves false when the
 * launcher rejects the secret (for example, it expired): a cookie from an earlier exchange may
 * still authorize this browser, so the first operation decides.
 */
export async function bootstrap(secret: string): Promise<boolean> {
  const response = await post(webPaths.bootstrap, {
    headers: { authorization: `Bearer ${secret}` },
  });
  await drain(response);
  if (response.status === 204) return true;
  if (response.status === 401) {
    linkRefused = true;
    return false;
  }
  throw failureOf(response.status);
}

const payloadSchemas = {
  list: ListPayloadSchema,
  open: OpenPayloadSchema,
  status: StatusPayloadSchema,
  check: SourceCheckPayloadSchema,
  stack: StackPayloadSchema,
  layer: OpenPayloadSchema,
  diff: DiffPayloadSchema,
  files: FilesPayloadSchema,
  code: CodePayloadSchema,
  delete: DeletePayloadSchema,
  viewed: ViewedPayloadSchema,
} satisfies Record<BrowserRequest["command"], Schema.Top>;
export type Payload<Command extends BrowserRequest["command"]> =
  (typeof payloadSchemas)[Command]["Type"];

const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplySchema));

/** Sends one browser operation; throws a TransportError or the Reply's DaemonError. */
export async function operation<Request extends BrowserRequest>(
  request: Request,
): Promise<Payload<Request["command"]>> {
  const response = await post(webPaths.operation, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const reply = await replyOf(response);
  if (!reply.ok) throw reply.error;
  try {
    return Schema.decodeUnknownSync(payloadSchemas[request.command], {
      onExcessProperty: "error",
    })(reply.value);
  } catch (cause) {
    throw new TransportError("unexpected", "gyst sent a reply this viewer can't read.", { cause });
  }
}

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SubscriptionEventSchema), {
  onExcessProperty: "error",
});

/**
 * The session's committed-state invalidations as the launcher streams them, `ready` first, until
 * the stream ends or `signal` aborts. Throws a TransportError when it can't be opened or read.
 */
export async function* events(
  session: string,
  signal: AbortSignal,
): AsyncGenerator<SubscriptionEvent, void, undefined> {
  const response = await post(webPaths.events, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session }),
    signal,
  });
  if (response.status !== 200) {
    await drain(response);
    throw failureOf(response.status);
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream") {
    await drain(response);
    throw new TransportError("unexpected", "gyst sent a stream this viewer can't read.");
  }
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw unavailable();
      });
      // An event cut off by the end was never sent whole, so it is dropped.
      if (done) return;
      buffered += value;
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        const data = buffered
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
          .join("\n");
        buffered = buffered.slice(end + 2);
        if (data === "") continue;
        let event: SubscriptionEvent;
        try {
          event = decodeEvent(data);
        } catch (cause) {
          throw new TransportError("unexpected", "gyst sent an event this viewer can't read.", {
            cause,
          });
        }
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// Transport statuses come first: only 200 carries every domain result, while 400 (bad_args) and
// 503 (daemon_unreachable) may carry an error Reply or nothing at all.
async function replyOf(response: Response): Promise<Reply> {
  const body = await drain(response);
  if (response.status === 401 || response.status === 403) throw failureOf(response.status);
  let reply: Reply | undefined;
  try {
    reply = decodeReply(body);
  } catch {
    reply = undefined;
  }
  if (reply && (response.status === 200 || (!reply.ok && [400, 503].includes(response.status))))
    return reply;
  throw failureOf(response.status);
}

// Always finish reading, even a body that is ignored, so the request completes rather than aborts.
const drain = (response: Response) => response.text().catch(() => "");

function failureOf(status: number): TransportError {
  switch (status) {
    case 401:
      return new TransportError(
        "unauthorized",
        linkRefused
          ? "This link's sign-in has expired or belongs to another gyst launch."
          : "This browser is not signed in to this gyst launch.",
      );
    case 403:
      return new TransportError(
        "forbidden",
        "gyst refused this address. Open the exact link gyst printed, including its host name.",
      );
    case 503:
      return unavailable();
    default:
      return new TransportError("unexpected", `gyst answered with HTTP ${status}.`);
  }
}

/** A delete's caller-stable id: minted once per confirmed intent and reused for its retries. */
export const newRequestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
