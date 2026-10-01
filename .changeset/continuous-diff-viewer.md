---
"@gyst/cli": minor
---

The browser viewer reads a session as one continuous diff of its captured changes. A file tree, with a walkthrough area above it, selects the whole snapshot, a folder or a file. Hidden unchanged ranges show their line counts and expand from the captured file contents, which load ahead for visible and nearby files within fixed request limits. The diff is split or stacked by available width, or set by hand. Each file header has a Viewed checkbox for the hunks in view; checking folds the file and moves to the next unviewed one. Vim and Mouse modes, folds, a ⌘K command menu and ? help cover reading by keyboard.
