---
"@gyst/cli": minor
---

Redesign the review TUI around a group list and a reading view. Start in the group list with the selected group's overview beside it; `Enter` replaces the list with the group's diff, keeping the overview on wide terminals and one pane at a time on narrow ones. `j`/`k` scroll while reading, `[`/`]` jump hunks, `p`/`n` jump groups without a verdict, `z` expands the focused pane while keeping the reading position, and `Esc` restores or returns to the list. The hunk heading the diff view becomes the shared focus for `/gyst-ask` and the editor without snapping the viewport. Remove repeated title/path chrome and readiness boilerplate, and let long hunks use the whole pane height.

Tighten the authoring guidance in the `gyst` skill: short titles, concise mixed-Markdown overviews with an example including a Mermaid fence, no template or word quota.
