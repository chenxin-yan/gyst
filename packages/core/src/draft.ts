import type { Group, Hunk, Session, StatusPayload } from "./session.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
type MutableGroup = Mutable<Omit<Group, "hunkIds">> & { hunkIds: string[] };
export type MutableSession = Mutable<
  Omit<Session, "hunks" | "groups" | "queue" | "acceptHistory" | "applyReceipts">
> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  queue: string[];
  acceptHistory: string[];
  applyReceipts: Array<{ key: string; digest: string; status: StatusPayload }>;
};

export function draftOf(session: Session): MutableSession {
  // SAFETY: structuredClone returns a detached copy, so dropping readonly cannot alias the caller's session.
  return structuredClone(session) as MutableSession;
}

export function groupedIds(session: Session): Set<string> {
  return new Set(session.groups.flatMap((group) => [...group.hunkIds]));
}
export function visibleItemIds(session: Session): string[] {
  const grouped = groupedIds(session);
  return [
    ...session.groups.map((group) => group.id),
    ...session.hunks.filter((hunk) => !grouped.has(hunk.id)).map((hunk) => hunk.id),
  ];
}

/** Hunks the human can focus inside an item: a group's members, or the hunk itself. */
export function focusableHunkIds(session: Session, itemId: string): readonly string[] {
  const group = session.groups.find(({ id }) => id === itemId);
  if (group) return group.hunkIds;
  return visibleItemIds(session).includes(itemId) ? [itemId] : [];
}

export function reconcileQueue(session: MutableSession): void {
  const visible = visibleItemIds(session);
  const visibleSet = new Set(visible);
  const available = new Set(visible);
  session.queue = [
    ...session.queue.filter((id) => available.delete(id)),
    ...visible.filter((id) => available.has(id)),
  ];
  // A grouped hunk is reviewed through its group, so a verdict of its own would be unreachable.
  for (const hunk of session.hunks) if (!visibleSet.has(hunk.id)) hunk.accepted = false;
  const acceptedIds = new Set([
    ...session.groups.filter(({ accepted }) => accepted).map(({ id }) => id),
    ...session.hunks
      .filter(({ accepted, title, id }) => accepted && title !== undefined && visibleSet.has(id))
      .map(({ id }) => id),
  ]);
  session.acceptHistory = session.acceptHistory.filter((id) => acceptedIds.has(id));
  const { itemId, expanded, hunkId } = session.cursor;
  if (itemId !== null && !visibleSet.has(itemId)) {
    session.cursor = { itemId: null, expanded: false };
  } else if (
    itemId !== null &&
    hunkId !== undefined &&
    !focusableHunkIds(session, itemId).includes(hunkId)
  ) {
    session.cursor = { itemId, expanded };
  }
}
