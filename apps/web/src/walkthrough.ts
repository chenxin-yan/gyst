// The walkthrough as the reader shows it: which files and hunks a view covers, progress derived from
// Viewed hunks, coverage, and where notes and other groups' changes sit in the diff. No React or
// DOM here, so each piece is unit tested on its own.
import {
  anchoredHunkIds,
  changedLinesOf,
  type CodeSide,
  type Hunk,
  type OutdatedReason,
  type StatusPayload,
} from "@gyst/core/wire";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { isUnder, type ReaderFile } from "./reader.ts";

/** What the main panel reads: every change under a path, or one group's files in its order. */
export type ReviewView = { kind: "files"; path: string } | { kind: "group"; id: string };

export type StatusGroup = StatusPayload["groups"][number];
export type StatusNote = StatusGroup["notes"][number];

/**
 * The files a view shows, and for each the hunks its Viewed checkbox covers: all of the file's in
 * a files view, only the group's own in a group view. A group view shows every hunk of its files
 * as a real change: the renderer cannot hide one, and dropping it would show its lines unchanged.
 */
export type ViewFiles = {
  files: readonly ReaderFile[];
  hunkIds: ReadonlyMap<string, readonly string[]>;
  /** The group a group view shows; undefined in a files view or once the group is gone. */
  group: StatusGroup | undefined;
};

export function viewFiles(
  view: ReviewView,
  files: readonly ReaderFile[],
  status: StatusPayload,
): ViewFiles {
  const group =
    view.kind === "group" ? status.groups.find((candidate) => candidate.id === view.id) : undefined;
  if (group === undefined) {
    // A group a reload removed falls back to the whole snapshot.
    const path = view.kind === "files" ? view.path : "";
    const shown = files.filter((file) => isUnder(file.path, path));
    return {
      files: shown,
      hunkIds: new Map(shown.map((file) => [file.path, file.hunks.map((hunk) => hunk.id)])),
      group: undefined,
    };
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const own = new Set(group.hunkIds);
  const shown = group.files.flatMap((path) => byPath.get(path) ?? []);
  return {
    files: shown,
    hunkIds: new Map(
      shown.map((file) => [
        file.path,
        file.hunks.filter((hunk) => own.has(hunk.id)).map((hunk) => hunk.id),
      ]),
    ),
    group,
  };
}

/** A group's reading progress, derived from its Viewed hunks; a group is never marked done itself. */
export function groupProgress(group: Pick<StatusGroup, "hunkIds">, viewed: ReadonlySet<string>) {
  const total = group.hunkIds.length;
  const count = group.hunkIds.filter((id) => viewed.has(id)).length;
  return { viewed: count, total, done: total > 0 && count === total };
}

/**
 * What an incomplete walkthrough still lacks, in words, or undefined when it is plain or complete.
 * Ungrouped hunks stay readable under Files; there is no separate list of them.
 */
export function coverageOf(status: StatusPayload): string[] | undefined {
  const { preparation } = status;
  if (preparation.state !== "incomplete") return undefined;
  const lines = ["Walkthrough in progress."];
  if (preparation.groupedHunks < preparation.totalHunks)
    lines.push(
      `${preparation.groupedHunks} of ${preparation.totalHunks} hunks are in groups; the rest are under Files.`,
    );
  if (preparation.overviewMissing) lines.push("The walkthrough has no overview yet.");
  const titleOf = (id: string) => status.groups.find((group) => group.id === id)?.title ?? id;
  for (const id of preparation.groupsMissingOverview)
    lines.push(`${titleOf(id)} has no overview yet.`);
  if (preparation.overviewOutdated) lines.push("The walkthrough overview is Outdated.");
  for (const id of preparation.groupsOutdated) lines.push(`${titleOf(id)} is Outdated.`);
  const notes = preparation.notesOutdated.length;
  if (notes > 0) lines.push(`${notes} ${notes === 1 ? "note is" : "notes are"} Outdated.`);
  return lines;
}

const outdatedBecause = {
  code: "the code it explains changed",
  references: "code it references changed",
} satisfies Record<OutdatedReason, string>;

/**
 * Why guidance is Outdated, in words, or undefined when it is current. A group a refresh emptied is
 * Outdated by having no changes left, whatever its overview says.
 */
export function outdatedReason(
  outdated: readonly OutdatedReason[] | undefined,
  emptied = false,
): string | undefined {
  const reasons = [
    ...(emptied ? ["its changes are gone since a refresh"] : []),
    ...(outdated ?? []).map((reason) => outdatedBecause[reason]),
  ];
  return reasons.length === 0 ? undefined : `Outdated: ${reasons.join("; ")}.`;
}

/**
 * What a diff annotation shows: a note, a thread or composer on code, the owner of a change another
 * group explains, or the row an open reference peek reserves under its note (peek.tsx).
 */
export type DiffAnnotation =
  | { kind: "note"; note: StatusNote }
  /** An open code thread, or a new comment's composer, by id: their state is read when drawn. */
  | { kind: "thread"; threadId: string }
  | { kind: "draft"; draftId: string }
  /** `owner` is the owning group's title; undefined while no group has the hunk. */
  | { kind: "foreign"; hunkId: string; owner: string | undefined }
  | { kind: "peek" };

const sideOf = (side: CodeSide) => (side === "old" ? "deletions" : "additions");

/** One note where the reader shows it: its file's place in the view and the line it sits under. */
export type NotePlace = {
  note: StatusNote;
  file: string;
  fileIndex: number;
  side: "deletions" | "additions";
  line: number;
};

/**
 * The line a note sits under: the last changed line inside its range on its side, so it is always
 * beside visible code even when the range runs into hidden unchanged lines.
 */
export function noteLine(note: StatusNote, hunks: readonly Hunk[]) {
  const { side, startLine, endLine } = note.anchor;
  let line: number | undefined;
  for (const hunk of hunks)
    for (const changed of changedLinesOf(hunk)[side])
      if (changed >= startLine && changed <= endLine && (line === undefined || changed > line))
        line = changed;
  return line ?? endLine;
}

/**
 * The view's notes in code order: file order, then the first anchored hunk, old side first, then
 * start line, as the core stores a group's notes. A group view shows its own notes; a files view
 * shows every group's. Notes pinned to another snapshot are not on this diff.
 */
export function noteSequence(shown: ViewFiles, status: StatusPayload): NotePlace[] {
  const groups = shown.group ? [shown.group] : status.groups;
  const notes = groups.flatMap((group) => group.notes);
  const places = shown.files.flatMap((file, fileIndex) =>
    notes
      .filter(
        ({ anchor }) =>
          anchor.path === file.path && anchor.snapshotId === status.session.snapshotId,
      )
      .map((note) => {
        const first = anchoredHunkIds(file.hunks, note.anchor)[0];
        return {
          place: {
            note,
            file: file.path,
            fileIndex,
            side: sideOf(note.anchor.side),
            line: noteLine(note, file.hunks),
          } satisfies NotePlace,
          hunk: first === undefined ? -1 : file.hunks.findIndex((hunk) => hunk.id === first),
        };
      }),
  );
  return places
    .sort(
      (a, b) =>
        a.place.fileIndex - b.place.fileIndex ||
        a.hunk - b.hunk ||
        (a.place.note.anchor.side === b.place.note.anchor.side
          ? 0
          : a.place.note.anchor.side === "old"
            ? -1
            : 1) ||
        a.place.note.anchor.startLine - b.place.note.anchor.startLine,
    )
    .map(({ place }) => place);
}

/**
 * The annotations of each shown file that has any: its notes, and in a group view a label on every
 * hunk the group does not own, at that hunk's first changed line, so it reads as a real change with
 * an owner. A file without any has no entry, so its renderer item stays as it was.
 */
export function annotationsOf(
  shown: ViewFiles,
  notes: readonly NotePlace[],
  status: StatusPayload,
): Map<string, DiffLineAnnotation<DiffAnnotation>[]> {
  const owners = new Map(
    status.groups.flatMap((group) => group.hunkIds.map((id) => [id, group.title] as const)),
  );
  const own = new Set(shown.group?.hunkIds);
  const byFile = new Map<string, DiffLineAnnotation<DiffAnnotation>[]>();
  const add = (path: string, annotation: DiffLineAnnotation<DiffAnnotation>) =>
    byFile.set(path, [...(byFile.get(path) ?? []), annotation]);
  for (const place of notes)
    add(place.file, {
      side: place.side,
      lineNumber: place.line,
      metadata: { kind: "note", note: place.note },
    });
  if (shown.group)
    for (const file of shown.files)
      for (const hunk of file.hunks) {
        if (own.has(hunk.id)) continue;
        const changed = changedLinesOf(hunk);
        const [side, line] =
          changed.new.length > 0
            ? (["additions", changed.new[0]!] as const)
            : (["deletions", changed.old[0]] as const);
        if (line === undefined) continue;
        add(file.path, {
          side,
          lineNumber: line,
          metadata: { kind: "foreign", hunkId: hunk.id, owner: owners.get(hunk.id) },
        });
      }
  return byFile;
}

/** Where the reader is, to step to the next or previous note from: a file of the view and a line. */
export type NoteFrom = { fileIndex: number; side: "deletions" | "additions"; line: number };

/**
 * The note `direction` steps from the reader's place, by index into `sequence`, or undefined past
 * either end. A place on a note's own line steps from that note; `current` names the note the
 * reader last went to when its place cannot say (Mouse mode scrolls it below the panel's top).
 */
export function noteStep(
  sequence: readonly Pick<NotePlace, "fileIndex" | "side" | "line">[],
  from: NoteFrom | undefined,
  direction: 1 | -1,
  current?: number,
): number | undefined {
  const inRange = (index: number) => (index >= 0 && index < sequence.length ? index : undefined);
  const on =
    current ??
    (from &&
      sequence.findIndex(
        (place) =>
          place.fileIndex === from.fileIndex &&
          place.side === from.side &&
          place.line === from.line,
      ));
  if (on !== undefined && on >= 0) return inRange(on + direction);
  if (from === undefined) return inRange(direction === 1 ? 0 : sequence.length - 1);
  const order = (place: (typeof sequence)[number]) =>
    place.fileIndex - from.fileIndex || place.line - from.line;
  return inRange(
    direction === 1
      ? sequence.findIndex((place) => order(place) > 0)
      : sequence.findLastIndex((place) => order(place) < 0),
  );
}
