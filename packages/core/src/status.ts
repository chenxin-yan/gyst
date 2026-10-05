import { Struct } from "effect";
import type { Session, SessionSummary, StatusPayload } from "./session.ts";

export const summaryOf = (session: Session): SessionSummary =>
  Struct.pick(session, ["id", "repoRoot", "scope", "snapshotId", "createdAt", "updatedAt"]);

export function statusOf(session: Session): StatusPayload {
  const viewed = new Set(session.viewedHunkIds);
  const files = new Map<string, { hunkCount: number; viewed: boolean }>();
  for (const hunk of session.hunks) {
    const file = files.get(hunk.file) ?? { hunkCount: 0, viewed: true };
    files.set(hunk.file, {
      hunkCount: file.hunkCount + 1,
      viewed: file.viewed && viewed.has(hunk.id),
    });
  }
  return {
    session: summaryOf(session),
    revision: session.revision,
    groups: session.groups.map((group) => ({ ...group, count: group.hunkIds.length })),
    viewedHunkIds: [...session.viewedHunkIds],
    files: [...files].map(([path, file]) => ({ path, ...file })),
  };
}
