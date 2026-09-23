import { Struct } from "effect";
import { groupedIds } from "./draft.ts";
import type { Session, StatusPayload } from "./session.ts";

export function statusOf(session: Session): StatusPayload {
  const counts = new Map<string, number>();
  for (const hunk of session.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
  const grouped = groupedIds(session);
  const inbox = session.hunks.filter((hunk) => !grouped.has(hunk.id));
  return {
    session: Struct.pick(session, ["id", "repoRoot", "source", "createdAt", "updatedAt"]),
    revision: session.revision,
    seq: session.seq,
    cursor: session.cursor,
    groups: session.groups.map((group) => ({ ...group, count: group.hunkIds.length })),
    inbox: inbox.map(({ id, file }) => ({ id, file })),
    queue: [...session.queue],
    queueSet: session.queueSet,
    ready: inbox.length === 0 && session.queueSet,
    files: [...counts].map(([path, hunkCount]) => ({ path, hunkCount })),
  };
}
