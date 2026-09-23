---
"@gyst/cli": minor
---

Use groups of one or more hunks as the only reviewable walkthrough steps. Plan the whole diff before publishing complete groups in order, with self-contained explanations and source-located context.

Add informational Git-source checks in the TUI and `gyst session check`. Checks respect the recorded scope, preserve the frozen snapshot and review progress, and never refresh automatically. Stdin and unavailable sources are reported explicitly.
