import { draftOf } from "./draft.ts";
import type { Hunk, Session } from "./session.ts";

export function refreshSession(
  session: Session,
  freshHunks: readonly Hunk[],
  updatedAt: string,
): Session {
  const draft = draftOf(session);
  const oldByMatch = Map.groupBy(session.hunks, (hunk) => `${hunk.file}\0${hunk.contentHash}`);
  const freshMatchCounts = new Map<string, number>();
  for (const hunk of freshHunks) {
    const key = `${hunk.file}\0${hunk.contentHash}`;
    freshMatchCounts.set(key, (freshMatchCounts.get(key) ?? 0) + 1);
  }
  const freshById = new Map(freshHunks.map((hunk) => [hunk.id, hunk]));
  const stableDuplicates = new Map<string, Hunk>();
  // An exact ID is safe for duplicates only when none of its peers moved or vanished.
  for (const [key, matches] of oldByMatch) {
    if (matches.length < 2 || matches.length !== freshMatchCounts.get(key)) continue;
    if (
      matches.every((old) => {
        const fresh = freshById.get(old.id);
        return fresh?.file === old.file && fresh.patch === old.patch;
      })
    ) {
      for (const old of matches) stableDuplicates.set(old.id, old);
    }
  }
  const survivingIds = new Set<string>();
  draft.hunks = freshHunks.map((fresh) => {
    const key = `${fresh.file}\0${fresh.contentHash}`;
    const matches = oldByMatch.get(key);
    const old =
      matches?.length === 1 && freshMatchCounts.get(key) === 1
        ? matches[0]
        : stableDuplicates.get(fresh.id);
    if (!old) return { ...fresh };
    survivingIds.add(old.id);
    return { ...fresh, id: old.id };
  });

  const fileOf = new Map(draft.hunks.map(({ id, file }) => [id, file]));
  draft.groups = draft.groups.flatMap((group) => {
    const hunkIds = group.hunkIds.filter((id) => survivingIds.has(id));
    if (hunkIds.length === 0) return [];
    const files = new Set(hunkIds.map((id) => fileOf.get(id)));
    return [
      {
        ...group,
        hunkIds,
        files: group.files.filter((file) => files.has(file)),
        // Interim until #91 reconciles guidance: a note survives only on its own snapshot.
        notes: group.notes.filter(({ anchor }) => anchor.snapshotId === draft.snapshotId),
      },
    ];
  });
  // Viewed survives only on an exactly matched hunk; changed, ambiguous and new hunks start
  // unviewed. Full reconciliation (guidance-driven invalidation) is #91.
  draft.viewedHunkIds = draft.viewedHunkIds.filter((id) => survivingIds.has(id));
  draft.revision++;
  draft.updatedAt = updatedAt;
  return draft;
}
