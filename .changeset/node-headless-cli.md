---
"@gyst/cli": minor
---

Run the CLI and background daemon on Node.js 24 or later instead of Bun; install with `npm install -g @gyst/cli`. Remove the terminal review viewer: `gyst` without a command now prints help, and this release ships only the headless session CLI, daemon and agent skills. The CLI now sends validated structured operations to the daemon. Hunk identities are computed differently than in earlier versions and saved sessions are not migrated, so close existing sessions and create them again after upgrading.
