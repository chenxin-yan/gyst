// PROTOTYPE, throwaway. Builds sample.json from a real commit using the real core parser.
// Run from repo root: bun prototype/web/make-data.ts
import { parseSnapshot } from "../../packages/core/src/index.ts";

const files = [
  "packages/core/src/metadata.ts",
  "packages/core/src/session.ts",
  "packages/core/src/apply.ts",
  "packages/core/src/human-action.ts",
  "packages/core/src/draft.ts",
  "packages/core/src/refresh.ts",
  "packages/core/src/index.ts",
  "packages/core/src/apply.test.ts",
  "packages/core/src/human-action.test.ts",
  "apps/gyst/src/daemon/sessions.ts",
  "apps/gyst/skills/gyst/SKILL.md",
  "apps/gyst/skills/gyst-ask/SKILL.md",
  "CONTEXT.md",
  ".changeset/minimal-review-ui.md",
];
const patch = await Bun.$`git show 7239806 --format= -- ${files}`.text();
const parsed = parseSnapshot(patch);
if (parsed._tag !== "Success") throw new Error(String(parsed.failure));
const hunks = parsed.success;
const id = (index: number) => hunks[index]!.id;
// A line-level note anchor: the first line of the hunk containing `match`, on the side it exists
// (context and added lines anchor to the new file, removed lines to the old one).
function anchor(hunkIndex: number, match: string) {
  const lines = hunks[hunkIndex]!.patch.split("\n");
  const [, oldStart, newStart] = lines[0]!.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)!;
  let oldLine = Number(oldStart);
  let newLine = Number(newStart);
  for (const line of lines.slice(1)) {
    if (line.includes(match))
      return line[0] === "-"
        ? { side: "deletions", line: oldLine }
        : { side: "additions", line: newLine };
    if (line[0] !== "+") oldLine++;
    if (line[0] !== "-") newLine++;
  }
  throw new Error(`no line matching ${JSON.stringify(match)} in hunk ${hunkIndex}`);
}
const group = (
  key: string,
  title: string,
  members: number[],
  notes: [number, string, string][],
  accepted = false,
) => ({
  id: key,
  title,
  hunkIds: members.map(id),
  notes: notes.map(([hunk, match, text]) => ({ hunkId: id(hunk), ...anchor(hunk, match), text })),
  accepted,
});

// Hand-authored walkthrough over the real hunks of 7239806; the changeset and glossary stay in the inbox.
const groups = [
  group(
    "notes-schema",
    "Replace overviews with hunk notes",
    [33, 34, 36, 38, 18, 32],
    [
      [34, "NOTE_MAX_CODE_POINTS", "Notes cap at 400 code points and reject terminal controls, so agent prose stays readable inline without a Markdown sanitizer."],
      [38, "receiptNoteTexts: Schema.Array", "Receipts still intern text, so exact historical replay survives progressive publication without repeating every note."],
    ],
    true,
  ),
  group(
    "anchors",
    "Validate note anchors on publish",
    [11, 12, 13, 14, 15, 16, 17, 9, 10],
    [
      [13, "validAnchors", "A note must anchor to a member of its own group; the whole batch is rejected rather than silently retargeting a note."],
      [16, "op.notes ?? group.notes", "Omitting notes keeps the old ones; an update replaces them only when it supplies an array."],
      [16, "|| !validAnchors(notes, members)", "Anchors are rechecked against the updated membership, so moving a hunk out of a group can't strand its note."],
      [17, "group changes require a complete queue.set", "Until the first queue exists, any group change must arrive with a queue.set in the same batch."],
    ],
  ),
  group(
    "focus",
    "Keep the focused hunk across sidebar toggles",
    [37, 27, 28, 29, 30, 31, 19, 20, 21, 22, 23, 24, 25, 26],
    [
      [37, "cursor.itemId === null", "Every active item now carries a focused hunk, so hiding the sidebar returns to the same member instead of the first."],
      [28, "action.type === \"cursor.follow\"", "Scroll observations apply only to the exact session, revision and sequence they saw; explicit navigation stays unconditional."],
      [22, "follows only the observed session", "These cases pin the guard: a stale follow is a no-op, never an error."],
    ],
  ),
  group(
    "refresh",
    "Drop notes when refresh loses a member",
    [35],
    [[35, "hunkIds.length === group.hunkIds.length", "A surviving note may describe the vanished sibling, so any lost member clears the group's notes."]],
  ),
  group(
    "noop",
    "Skip saving unchanged cursor actions",
    [7, 8],
    [[8, "updated === session", "A cursor action that changes nothing no longer rewrites the session file."]],
  ),
  group(
    "skills",
    "Teach the skills to write notes",
    [3, 4, 5, 6, 2],
    [
      [4, "**Title**", "Titles name the change in a few words; explanation moves into notes on the hunks that need it."],
      [2, "title and notes", "/gyst-ask now reads the focused hunk's note before answering."],
    ],
  ),
];
const grouped = new Set(groups.flatMap((group) => group.hunkIds));

// Full old/new contents per changed file, so the viewer can expand context around hunks.
// A snapshot of a git range can capture these from the same two revisions it diffed.
const show = (spec: string) => Bun.$`git show ${spec}`.quiet().nothrow().text();
const contents = Object.fromEntries(
  await Promise.all(
    [...new Set(hunks.map((hunk) => hunk.file))].map(async (file) => {
      const added = hunks.some((hunk) => hunk.file === file && hunk.header.startsWith("@@ -0,0 "));
      return [file, { old: added ? null : await show(`7239806^:${file}`), new: await show(`7239806:${file}`) }] as const;
    }),
  ),
);

await Bun.write(
  new URL("./sample.json", import.meta.url),
  JSON.stringify(
    {
      scope: "7239806",
      scopeTitle: "Simplify the review UI",
      repo: "chenxin-yan/gyst",
      groups,
      inbox: hunks.filter((hunk) => !grouped.has(hunk.id)).map((hunk) => hunk.id),
      hunks: Object.fromEntries(hunks.map((hunk) => [hunk.id, hunk])),
      contents,
    },
    null,
    2,
  ),
);
console.log(`wrote ${hunks.length} hunks, ${groups.length} groups, ${hunks.length - grouped.size} in inbox`);
