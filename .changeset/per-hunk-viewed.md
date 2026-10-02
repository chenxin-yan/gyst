---
"@gyst/cli": minor
---

Replace group acceptance and the review queue with per-hunk Viewed progress. Groups no longer carry `accepted`, and `apply` no longer takes `queue.set`: groups keep the order they were created in. `session status` drops `cursor`, `seq`, `inbox`, `queue`, `queueSet` and `ready`, and reports `viewedHunkIds` and, per file, whether all its hunks are Viewed. Refresh keeps a hunk's Viewed only when it matches exactly. Sessions saved by earlier versions are not migrated.
