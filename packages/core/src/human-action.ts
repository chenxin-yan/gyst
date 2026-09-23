import { Result, Schema } from "effect";
import { draftOf, focusableHunkIds, visibleItemIds } from "./draft.ts";
import { ValidationFailed } from "./errors.ts";
import type { Session } from "./session.ts";

// A verdict names the frame the human saw; the daemon rejects it once that frame is stale.
const verdictFrameFields = { sessionId: Schema.String, revision: Schema.Number };
export const HumanActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cursor.move"), itemId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("cursor.focus"),
    itemId: Schema.String,
    pane: Schema.Literal("queue"),
    hunkId: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    type: Schema.Literal("cursor.focus"),
    itemId: Schema.String,
    pane: Schema.Literals(["diff", "overview"]),
    hunkId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("verdict.toggle"),
    itemId: Schema.String,
    ...verdictFrameFields,
  }),
  Schema.Struct({ type: Schema.Literal("verdict.undo"), ...verdictFrameFields }),
]);
export type HumanAction = typeof HumanActionSchema.Type;
/** Cursor focus bumps only `seq`; verdicts and their atomic navigation bump `revision` too. */
export function applyHumanAction(
  session: Session,
  action: HumanAction,
  updatedAt: string,
): Result.Result<Session, ValidationFailed> {
  const inapplicable = Result.fail(
    new ValidationFailed({ message: "TUI action does not apply to the current session" }),
  );
  const draft = draftOf(session);
  const visibleIds = new Set(visibleItemIds(session));

  if (action.type === "cursor.move") {
    if (!visibleIds.has(action.itemId)) return inapplicable;
    draft.cursor = { itemId: action.itemId, pane: "queue" };
  } else if (action.type === "cursor.focus") {
    const { itemId, pane } = action;
    if (!visibleIds.has(itemId)) return inapplicable;
    if (pane === "queue") draft.cursor = { itemId, pane };
    else if (focusableHunkIds(session, itemId).includes(action.hunkId))
      draft.cursor = { itemId, pane, hunkId: action.hunkId };
    else return inapplicable;
  } else {
    // Each publication sets the reviewable queue, even while inbox preparation continues.
    if (!session.queueSet)
      return Result.fail(new ValidationFailed({ message: "review queue is not set" }));
    const itemId = action.type === "verdict.undo" ? draft.acceptHistory.at(-1) : action.itemId;
    if (!itemId) return inapplicable;
    const item = draft.groups.find(({ id }) => id === itemId);
    if (!item || (action.type === "verdict.undo" && !item.accepted)) return inapplicable;
    if (action.type === "verdict.undo") {
      item.accepted = false;
      draft.acceptHistory.pop();
      draft.cursor =
        session.cursor.pane === "queue"
          ? { itemId, pane: "queue" }
          : { itemId, pane: "diff", hunkId: focusableHunkIds(draft, itemId)[0]! };
    } else {
      item.accepted = !item.accepted;
      draft.acceptHistory = draft.acceptHistory.filter((id) => id !== itemId);
      if (item.accepted) {
        draft.acceptHistory.push(itemId);
        // Another TUI may have moved focus since this explicitly named verdict was sent.
        if (session.cursor.itemId === itemId) {
          const pending = new Set(
            draft.groups
              .filter((candidate) => !candidate.accepted)
              .map((candidate) => candidate.id),
          );
          const start = draft.queue.indexOf(itemId);
          for (let offset = 1; offset <= draft.queue.length; offset++) {
            const destination = draft.queue[(start + offset) % draft.queue.length]!;
            if (!pending.has(destination)) continue;
            draft.cursor =
              session.cursor.pane === "queue"
                ? { itemId: destination, pane: "queue" }
                : {
                    itemId: destination,
                    pane: "diff",
                    hunkId: focusableHunkIds(draft, destination)[0]!,
                  };
            break;
          }
        }
      }
    }
    draft.revision++;
  }

  draft.seq++;
  draft.updatedAt = updatedAt;
  return Result.succeed(draft);
}
