---
"@gyst/cli": minor
---

Read a session's captured snapshot without its checkout. `gyst session files` lists the current snapshot's files, including unchanged ones, with each side's availability, and `gyst session code` returns one side's exact captured text a page (up to 64 KiB) at a time by line or continuation offset; both name `--session` and `--snapshot`, and an older snapshot fails with `stale_revision`. `session diff` now includes its `snapshotId`. The browser viewer lists captured files and shows their code or why a side was not captured. On a terminal, capture shows its progress on stderr.
