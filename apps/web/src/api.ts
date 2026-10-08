import { webPaths } from "@gyst/core/web";
import {
  type BrowserRequest,
  CodePayloadSchema,
  CommitsPayloadSchema,
  ConversationResultSchema,
  ConversationsPayloadSchema,
  DaemonError,
  DeletePayloadSchema,
  DiffPayloadSchema,
  FilesPayloadSchema,
  IdentifiersPayloadSchema,
  ListPayloadSchema,
  NavigationResultPayloadSchema,
  NavigationStatusPayloadSchema,
  OpenPayloadSchema,
  RefreshPayloadSchema,
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
 * The HTTP hop to the daemon failed before a Reply existed. Domain failures are not
 * TransportErrors: they arrive as the canonical Reply and are thrown as its DaemonError.
 */
export class TransportError extends Error {
  constructor(
    readonly reason: "forbidden" | "unavailable" | "unexpected",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const daemonError = Schema.is(DaemonError);

/** Whether a failure is the daemon's domain error, and the one with `tag` when that is given. */
export const isDaemonError = (error: unknown, tag?: DaemonError["_tag"]): error is DaemonError =>
  daemonError(error) && (tag === undefined || error._tag === tag);

/**
 * Failures the viewer explains in place and that say nothing about a gyst defect: host,
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
    ? error.reason !== "forbidden"
    : isDaemonError(error) && error._tag === "daemon_unreachable";

const unavailable = () =>
  new TransportError(
    "unavailable",
    "Can't reach gyst. Its daemon may have stopped; run gyst again to reopen this review.",
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

const payloadSchemas = {
  list: ListPayloadSchema,
  open: OpenPayloadSchema,
  status: StatusPayloadSchema,
  check: SourceCheckPayloadSchema,
  stack: StackPayloadSchema,
  layer: OpenPayloadSchema,
  diff: DiffPayloadSchema,
  files: FilesPayloadSchema,
  commits: CommitsPayloadSchema,
  code: CodePayloadSchema,
  delete: DeletePayloadSchema,
  refresh: RefreshPayloadSchema,
  viewed: ViewedPayloadSchema,
  conversations: ConversationsPayloadSchema,
  draft: ConversationResultSchema,
  send: ConversationResultSchema,
  edit: ConversationResultSchema,
  retract: ConversationResultSchema,
  resolve: ConversationResultSchema,
  discard: ConversationResultSchema,
  navigation: NavigationStatusPayloadSchema,
  definition: NavigationResultPayloadSchema,
  references: NavigationResultPayloadSchema,
  identifiers: IdentifiersPayloadSchema,
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
 * The session's committed-state invalidations as the daemon sends them over a WebSocket, `ready`
 * first, until the daemon ends them or `signal` aborts. Throws a TransportError when the connection
 * fails or breaks, or a message can't be read.
 */
export async function* events(
  session: string,
  signal: AbortSignal,
): AsyncGenerator<SubscriptionEvent, void, undefined> {
  const url = new URL(webPaths.events, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ session }).toString();
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  let closed: CloseEvent | undefined;
  let wake = () => {};
  socket.addEventListener("message", ({ data }) => {
    messages.push(data);
    wake();
  });
  socket.addEventListener("close", (event) => {
    closed = event;
    wake();
  });
  // Not waiting for the close event: a stalled connection's closing handshake may never finish.
  const abort = () => {
    socket.close();
    wake();
  };
  signal.addEventListener("abort", abort);
  try {
    for (;;) {
      if (signal.aborted) return;
      const data = messages.shift();
      if (data !== undefined) {
        let event: SubscriptionEvent;
        try {
          if (typeof data !== "string") throw new Error("not a text message");
          event = decodeEvent(data);
        } catch (cause) {
          throw new TransportError("unexpected", "gyst sent an event this viewer can't read.", {
            cause,
          });
        }
        yield event;
      } else if (closed !== undefined) {
        // Only the daemon ends a subscription cleanly; any other close is a lost connection.
        if (closed.code === 1000) return;
        throw unavailable();
      } else await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    signal.removeEventListener("abort", abort);
    socket.close();
  }
}

// Transport statuses come first: only 200 carries every domain result, while 400 (bad_args) and
// 503 (daemon_unreachable) may carry an error Reply or nothing at all.
async function replyOf(response: Response): Promise<Reply> {
  const body = await drain(response);
  if (response.status === 403) throw failureOf(response.status);
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
    case 403:
      return new TransportError(
        "forbidden",
        "gyst refused this address. Open the link gyst printed, on localhost or 127.0.0.1.",
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
