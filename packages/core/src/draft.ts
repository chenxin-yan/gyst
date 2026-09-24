import type { ApplyReceipt, Group, Hunk, Session } from "./session.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
type MutableGroup = Mutable<Omit<Group, "hunkIds">> & { hunkIds: string[] };
export type MutableSession = Mutable<
  Omit<
    Session,
    "hunks" | "groups" | "queue" | "acceptHistory" | "receiptNoteTexts" | "applyReceipts"
  >
> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  queue: string[];
  acceptHistory: string[];
  receiptNoteTexts: string[];
  applyReceipts: ApplyReceipt[];
};

export function draftOf(session: Session): MutableSession {
  const { receiptNoteTexts, applyReceipts, ...live } = session;
  // SAFETY: structuredClone returns a detached copy, so dropping readonly cannot alias the caller's
  // session. Receipt history is append-only and its entries are never mutated, so sharing them is safe.
  return {
    ...(structuredClone(live) as Mutable<typeof live>),
    receiptNoteTexts: [...receiptNoteTexts],
    applyReceipts: [...applyReceipts],
  } as MutableSession;
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
  const acceptedIds = new Set(
    session.groups.filter(({ accepted }) => accepted).map(({ id }) => id),
  );
  session.acceptHistory = session.acceptHistory.filter((id) => acceptedIds.has(id));
  const { itemId, pane, hunkId } = session.cursor;
  if (itemId !== null && !visibleSet.has(itemId)) {
    session.cursor = { itemId: null, pane: "queue" };
  } else if (itemId !== null) {
    const members = focusableHunkIds(session, itemId);
    if (hunkId === undefined || !members.includes(hunkId))
      session.cursor = { itemId, pane, hunkId: members[0]! };
  }
}
