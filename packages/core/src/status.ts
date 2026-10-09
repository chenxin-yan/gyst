import { Struct } from "effect";
import type { Preparation, Session, SessionSummary, StatusPayload } from "./session.ts";

export const summaryOf = (session: Session): SessionSummary =>
  Struct.pick(session, ["id", "repoRoot", "scope", "snapshotId", "createdAt", "updatedAt"]);

function preparationOf(session: Session): Preparation {
  const current = new Set(session.hunks.map(({ id }) => id));
  const memberships = session.groups.flatMap(({ hunkIds }) => hunkIds);
  const groupedHunks = new Set(memberships.filter((id) => current.has(id))).size;
  const overviewMissing = session.overview === null;
  const groupsMissingOverview = session.groups.flatMap(({ id, overview }) =>
    overview === null ? [id] : [],
  );
  const covered = groupedHunks === current.size && memberships.length === groupedHunks;
  const overviewOutdated = session.overview?.outdated !== undefined;
  // An emptied group is Outdated, never complete by having nothing left to read.
  const groupsOutdated = session.groups.flatMap(({ id, hunkIds, overview }) =>
    hunkIds.length === 0 || overview?.outdated ? [id] : [],
  );
  const notesOutdated = session.groups.flatMap(({ notes }) =>
    notes.flatMap(({ id, outdated }) => (outdated ? [id] : [])),
  );
  return {
    state:
      session.groups.length === 0 && overviewMissing
        ? "plain"
        : covered &&
            !overviewMissing &&
            groupsMissingOverview.length === 0 &&
            !overviewOutdated &&
            groupsOutdated.length === 0 &&
            notesOutdated.length === 0
          ? "complete"
          : "incomplete",
    groupedHunks,
    totalHunks: current.size,
    overviewMissing,
    groupsMissingOverview,
    overviewOutdated,
    groupsOutdated,
    notesOutdated,
  };
}

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
    overview: session.overview,
    groups: session.groups.map((group) => ({ ...group, count: group.hunkIds.length })),
    preparation: preparationOf(session),
    viewedHunkIds: [...session.viewedHunkIds],
    files: [...files].map(([path, file]) => ({ path, ...file })),
  };
}
