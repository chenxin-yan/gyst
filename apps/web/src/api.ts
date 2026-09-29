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
  StatusPayloadSchema,
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
 * outage, a missing session and a snapshot a refresh replaced. Everything else (an unreadable
 * reply, internal_error, rejected input, render exceptions) also deserves a console diagnostic.
 */
export const isExpectedFailure = (error: unknown) =>
  error instanceof TransportError
    ? error.reason !== "unexpected"
    : isDaemonError(error) &&
      (error._tag === "no_session" ||
        error._tag === "daemon_unreachable" ||
        error._tag === "stale_revision");

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
  diff: DiffPayloadSchema,
  files: FilesPayloadSchema,
  code: CodePayloadSchema,
  delete: DeletePayloadSchema,
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
