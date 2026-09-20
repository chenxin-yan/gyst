import { Result, Schema } from "effect";
import { draftOf, groupedIds, visibleItemIds } from "./draft.ts";
import { ValidationFailed } from "./errors.ts";
import type { Session } from "./session.ts";

// A verdict names the frame the human saw; the daemon rejects it once that frame is stale.
const verdictFrameFields = { sessionId: Schema.String, revision: Schema.Number };
export const HumanActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cursor.move"), itemId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("expand.toggle") }),
  Schema.Struct({
    type: Schema.Literal("verdict.toggle"),
    itemId: Schema.String,
    ...verdictFrameFields,
  }),
  Schema.Struct({ type: Schema.Literal("verdict.undo"), ...verdictFrameFields }),
]);
export type HumanAction = typeof HumanActionSchema.Type;
/** Cursor moves and folds bump only `seq`; verdicts are review state and bump `revision` too. */
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
    draft.cursor = { itemId: action.itemId, expanded: false };
  } else if (action.type === "expand.toggle") {
    if (!session.cursor.itemId || !session.groups.some(({ id }) => id === session.cursor.itemId))
      return inapplicable;
    draft.cursor = { ...draft.cursor, expanded: !draft.cursor.expanded };
  } else {
    // Until the pre-pass finalizes the queue, the human is not looking at the reviewable set.
    if (!session.queueSet)
      return Result.fail(new ValidationFailed({ message: "review queue is not set" }));
    const itemId = action.type === "verdict.undo" ? draft.acceptHistory.at(-1) : action.itemId;
    if (!itemId) return inapplicable;
    const group = draft.groups.find(({ id }) => id === itemId);
    const grouped = groupedIds(draft);
    const hunk = draft.hunks.find(
      ({ id, tldr }) => id === itemId && tldr !== undefined && !grouped.has(id),
    );
    const item = group ?? hunk;
    if (!item || (action.type === "verdict.undo" && !item.accepted)) return inapplicable;
    if (action.type === "verdict.undo") {
      item.accepted = false;
      draft.acceptHistory.pop();
      draft.cursor = { itemId, expanded: false };
    } else {
      item.accepted = !item.accepted;
      draft.acceptHistory = draft.acceptHistory.filter((id) => id !== itemId);
      if (item.accepted) draft.acceptHistory.push(itemId);
    }
    draft.revision++;
  }

  draft.seq++;
  draft.updatedAt = updatedAt;
  return Result.succeed(draft);
}
