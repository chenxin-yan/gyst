---
"@gyst/cli": minor
---

Replace `gyst session create` and `close` with `gyst session open [<range>]`, `list` and `delete`. A session is identified by its repository and recorded scope (uncommitted changes or a Git range as written): reopening returns the saved session without refreshing it, even after refs move, and different scopes coexist. `open` prints the session and snapshot identity as JSON without launching a viewer. Every other session command requires `--session <id>`; the current directory no longer selects a session. `delete --session <id> --request-id <id>` is retry-safe across daemon restarts. Stdin patches and pathspec scopes are removed, and sessions saved by earlier versions are not migrated.
