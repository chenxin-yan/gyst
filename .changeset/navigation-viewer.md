---
"@gyst/cli": minor
---

Follow TS/JS definitions and usages in the browser viewer. With the optional `@gyst/navigation-typescript` add-on of the same release installed, `gd` and `gr` offer the identifiers on the cursor's line, declaration parameters included, and a right-click on a symbol offers its definition or usages; the answer opens as an inline peek under that line, with a vertical list of results beside a live preview (`j`/`k`, Enter to expand, Esc to close), Expand and nested Back. Queries cover the current snapshot only, say Preparing while gyst prepares them, mark potentially incomplete results with the project inputs they lack, and never change Viewed. Without a matching add-on the peek shows the exact install command, Check again and Continue without navigation.
