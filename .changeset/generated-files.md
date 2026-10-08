---
"@gyst/cli": minor
---

Record files Git attributes mark `linguist-generated` or `linguist-vendored` at capture, from the captured sides rather than the later checkout. `session files` entries and `session status` files carry `generated: true`, and `session diff` lists `generatedFiles`; the viewer starts those files folded with a Generated label. Refresh resolves the attributes again; reads and source checks never do.
