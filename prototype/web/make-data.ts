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
const group = (
  key: string,
  title: string,
  members: number[],
  notes: [number, string][],
  accepted = false,
) => ({
  id: key,
  title,
  hunkIds: members.map(id),
  notes: notes.map(([hunk, text]) => ({ hunkId: id(hunk), text })),
  accepted,
});

// Hand-authored walkthrough over the real hunks of 7239806; the changeset and glossary stay in the inbox.
const groups = [
  group(
    "notes-schema",
    "Replace overviews with hunk notes",
    [33, 34, 36, 38, 18, 32],
    [
      [34, "Notes cap at 400 code points and reject terminal controls, so agent prose stays readable inline without a Markdown sanitizer."],
      [38, "Receipts still intern text, so exact historical replay survives progressive publication without repeating every note."],
    ],
    true,
  ),
  group(
    "anchors",
    "Validate note anchors on publish",
    [11, 12, 13, 14, 15, 16, 17, 9, 10],
    [
      [13, "A note must anchor to a member of its own group; the whole batch is rejected rather than silently retargeting a note."],
      [17, "Until the first queue exists, any group change must arrive with a queue.set in the same batch."],
    ],
  ),
  group(
    "focus",
    "Keep the focused hunk across sidebar toggles",
    [37, 27, 28, 29, 30, 31, 19, 20, 21, 22, 23, 24, 25, 26],
    [
      [37, "Every active item now carries a focused hunk, so hiding the sidebar returns to the same member instead of the first."],
      [28, "Scroll observations apply only to the exact session, revision and sequence they saw; explicit navigation stays unconditional."],
      [22, "These cases pin the guard: a stale follow is a no-op, never an error."],
    ],
  ),
  group(
    "refresh",
    "Drop notes when refresh loses a member",
    [35],
    [[35, "A surviving note may describe the vanished sibling, so any lost member clears the group's notes."]],
  ),
  group(
    "noop",
    "Skip saving unchanged cursor actions",
    [7, 8],
    [[8, "A cursor action that changes nothing no longer rewrites the session file."]],
  ),
  group(
    "skills",
    "Teach the skills to write notes",
    [3, 4, 5, 6, 2],
    [
      [4, "Titles name the change in a few words; explanation moves into notes on the hunks that need it."],
      [2, "/gyst-ask now reads the focused hunk's note before answering."],
    ],
  ),
];
const grouped = new Set(groups.flatMap((group) => group.hunkIds));

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
    },
    null,
    2,
  ),
);
console.log(`wrote ${hunks.length} hunks, ${groups.length} groups, ${hunks.length - grouped.size} in inbox`);
