import { Struct } from "effect";
import type { Session, StatusPayload } from "./session.ts";

export function statusOf(session: Session): StatusPayload {
  const counts = new Map<string, number>();
  for (const hunk of session.hunks) counts.set(hunk.file, (counts.get(hunk.file) ?? 0) + 1);
  const grouped = new Set(session.groups.flatMap((group) => group.hunkIds));
  return {
    session: Struct.pick(session, ["id", "repoRoot", "source", "createdAt", "updatedAt"]),
    revision: session.revision,
    seq: session.seq,
    cursor: session.cursor,
    groups: session.groups.map((group) => ({
      ...group,
      count: group.hunkIds.length,
      accepted: false,
    })),
    spotlight: session.hunks
      .filter((hunk) => !grouped.has(hunk.id) && hunk.tldr !== undefined)
      .map((hunk) => ({ id: hunk.id, file: hunk.file, tldr: hunk.tldr!, accepted: false })),
    inbox: session.hunks
      .filter((hunk) => !grouped.has(hunk.id) && hunk.tldr === undefined)
      .map(({ id, file }) => ({ id, file })),
    files: [...counts].map(([path, hunkCount]) => ({ path, hunkCount })),
  };
}
