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
      .filter(({ accepted, tldr, id }) => accepted && tldr !== undefined && visibleSet.has(id))
      .map(({ id }) => id),
  ]);
  session.acceptHistory = session.acceptHistory.filter((id) => acceptedIds.has(id));
  if (session.cursor.itemId !== null && !visibleSet.has(session.cursor.itemId)) {
    session.cursor = { itemId: null, expanded: false };
  }
}
