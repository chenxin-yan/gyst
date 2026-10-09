---
"@gyst/cli": minor
---

The browser viewer shows the change author's own explanation beside the agent's. A PR session has a Description entry above the walkthrough that shows the PR's description as GitHub last reported it, with a link to the PR on GitHub; it comes with the PR's stack metadata, so opening a session makes no extra request and a stack recheck updates it like the title. A recorded range session captures the messages of the commits it contains, oldest first, with each snapshot and shows them in the same place: refresh recaptures them, a source check does not. A description renders as untrusted Markdown (raw HTML as text, no images, web links opened only by a click); commit messages render as plain text. Uncommitted sessions have neither. Range snapshots captured by earlier versions are not migrated.
