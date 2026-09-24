---
"@gyst/cli": patch
---

Check the running daemon's version and instance before sending review commands. Automatically restart an older cooperative daemon only after validating saved sessions and confirming that no request or saved-state change raced the restart. Preserve review files unchanged, refuse downgrades, and report legacy daemons or incompatible saved sessions without automatically restarting them. Never replay a mutation after losing its reply.
