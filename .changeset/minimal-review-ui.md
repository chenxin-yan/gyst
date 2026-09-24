---
"@gyst/cli": patch
---

Show a compact item sidebar beside the selected diff. Enter hides the sidebar, Esc restores it, and s toggles the same two-state view. Optional plain-text Agent notes appear above their owning hunks only while reading. Preserve member focus and reading position across sidebar reflow; remove the separate overview pane, Tab switching and z expansion.

Replace group overviews with notes throughout authoring, status, persistence and exact historical receipts. Notes have unique own-group hunk anchors and a 400-Unicode-code-point limit; empty arrays are valid. Partial refresh invalidation clears the affected group's notes and verdict while unrelated work survives. Existing saved sessions require recreation; files are left untouched rather than migrated. Use the updated CLI/TUI and daemon together.

Retain atomic progressive publication, group-only done-reviewing verdicts, frozen snapshots, guarded scroll-derived focus and synchronized editor handoff. Update gyst, gyst-refresh and gyst-ask authoring and focus guidance.

Update runtime dependencies and development tooling, including @pierre/diffs 1.4.3 and Effect 4 RC117. Git-quoted filename decoding still awaits an upstream release.
