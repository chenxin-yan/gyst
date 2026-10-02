import { Result } from "effect";
import { draftOf } from "./draft.ts";
import { BadArgs, StaleRevision, ValidationFailed } from "./errors.ts";
import { hash } from "./hash.ts";
import type { Session, ViewedPayload } from "./session.ts";
import type { BrowserRequest } from "./wire.ts";

export type ViewedRequest = Extract<BrowserRequest, { readonly command: "viewed" }>;
/** A replayed request returns its recorded result and no session to persist. */
export type ViewedOutcome = { readonly result: ViewedPayload; readonly session?: Session };

/**
 * Sets Viewed on exactly `request.hunkIds`: all of them or none. A recorded `requestId` answers
 * first, so a retry after the state moved on still gets its original result.
 */
export function setViewed(
  session: Session,
  request: ViewedRequest,
  updatedAt: string,
): Result.Result<ViewedOutcome, BadArgs | StaleRevision | ValidationFailed> {
  const { requestId } = request;
  if (!requestId) return Result.fail(new BadArgs({ message: "viewed needs a request id" }));
  // Schema decoding already ordered the keys, so the JSON text is a canonical form of the request.
  const digest = hash(JSON.stringify(request));
  // ponytail: every request keeps a receipt, found by linear scan; prune or index if a session
  // collects thousands.
  const receipt = session.viewedReceipts.find((candidate) => candidate.requestId === requestId);
  if (receipt) {
    if (receipt.digest === digest) return Result.succeed({ result: receipt.result });
    return Result.fail(
      new ValidationFailed({
        message: "request id reused with a different payload",
        detail: { requestId },
      }),
    );
  }
  if (request.snapshotId !== session.snapshotId || request.revision !== session.revision)
    return Result.fail(
      new StaleRevision({
        message: "viewed was based on an older snapshot or revision; read the session again",
        detail: { snapshotId: session.snapshotId, revision: session.revision },
      }),
    );
  const current = new Set(session.hunks.map(({ id }) => id));
  const unknown = request.hunkIds.filter((id) => !current.has(id));
  if (
    request.hunkIds.length === 0 ||
    new Set(request.hunkIds).size !== request.hunkIds.length ||
    unknown.length
  )
    return Result.fail(
      new ValidationFailed({
        message: "viewed needs distinct current hunk ids",
        detail: { unknown },
      }),
    );

  const draft = draftOf(session);
  const viewed = new Set(session.viewedHunkIds);
  for (const id of request.hunkIds) {
    if (request.viewed) viewed.add(id);
    else viewed.delete(id);
  }
  draft.viewedHunkIds = session.hunks.flatMap(({ id }) => (viewed.has(id) ? [id] : []));
  draft.revision++;
  draft.updatedAt = updatedAt;
  const result: ViewedPayload = {
    sessionId: session.id,
    snapshotId: session.snapshotId,
    revision: draft.revision,
    hunkIds: [...request.hunkIds],
    viewed: request.viewed,
  };
  draft.viewedReceipts.push({ requestId, digest, result });
  return Result.succeed({ session: draft, result });
}
