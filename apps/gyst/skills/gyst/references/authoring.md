# Authoring gyst guidance

The one authoring reference for both gyst workflows: `gyst` uses it to prepare and repair a walkthrough, `gyst-respond` to improve guidance while answering. [The examples](examples.md) show complete batches; the `gyst-cli` reference for `gyst session apply` lists the envelope and every op with its fields.

## What guidance is for

The reader knows the language but not this subsystem, and has only the walkthrough and the code: not your chat, your plan or any private instructions. Your job is to give them the mental model that makes the diff obvious, then point at the exact code that proves each step. Gyst does not judge the change; neither does your guidance. Explain what the code does and why, and say plainly what you did not verify.

Start short and orient first; give depth through precise links rather than long prose. Concise overviews and one- or two-sentence notes are defaults, not caps: use more words only where the reader would otherwise have to reconstruct something.

## The pieces

| Piece                | Says                                                                                                  | Typical length                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Walkthrough overview | The purpose of the whole change and the mental model connecting its groups; how to read them in order | A short paragraph, perhaps a list or diagram |
| Group title          | The change, named in a few words: `Reject expired credentials`                                        | Single line, 1–120 characters, plain text    |
| Group overview       | What this group contributes and how to read it: its entry point and the path through its files        | Two to four sentences                        |
| Note                 | One logical step, non-obvious consequence, caveat or connection, beside the code it explains          | One or two sentences                         |
| Reference            | A link to exact captured code supporting a claim                                                      | Inline link                                  |

The walkthrough and group overviews are complementary. The walkthrough says why the change exists and how the parts fit; a group overview says what this part contributes. Do not repeat one in the other, and do not summarize the diff line by line in either. A prepared walkthrough needs both: a walkthrough overview and an overview for every group, even when there is only one group.

## Mental model first

Open the walkthrough overview with the model the reader needs before any code: what the system did before, what it does now, and the one idea that connects the groups. Then follow the concrete flow, from where a request or call enters to where the effect is visible.

- **Behavior changes:** give a before/after or usage example of the observable difference, such as an input and its old and new result, or a call and what it now returns or refuses.
- **Refactors:** state the invariant that is preserved and where it is enforced, so the reader checks that rather than every moved line. Say what deliberately changed, if anything.
- **Edge cases:** name the boundary (empty, exactly at a limit, concurrent, missing) and point at the code or test that pins it.

Choose the smallest representation that works: a sentence, a short list, a compact table, a fenced snippet, or a diagram when a flow or state change is hard to follow in words. A diagram must clarify, not decorate.

## Notes and their ranges

A note explains a logical step, not every hunk or line; obvious mechanical changes speak for themselves. Notes sit beside the code in code order, so do not restate the code.

A note has a stable `id` and anchors to **one contiguous line range on one side** (`old` or `new`) of one file, numbered as in the snapshot's captured content:

- The range must include a changed line of its own group, on that side.
- It must include no changed line of another group or of an ungrouped hunk.
- It may span unchanged lines and several hunks of its own group.
- Explain removed code from the `old` side; a pure deletion is only reachable there.

Supporting code elsewhere, unchanged or not, is linked with a reference rather than annotated with its own note.

## Evidence: sketches, inspected and executed

Tell the reader what kind of evidence each claim rests on:

- **Captured code:** a reference to the snapshot is evidence. Prefer it.
- **Sketches:** an illustrative snippet you wrote, such as pseudo-code or a usage example, is not captured code. Label it, for example "Sketch:" or "For example:", and keep it consistent with the real code.
- **Tests inspected:** reading a test shows what it asserts, not that it passes. Say "Test inspected, not run."
- **Verification executed:** claim a run only when you ran it on the snapshot's code, and name it: "Ran `pnpm test src/auth.test.ts`: passes." Code changed after capture is not the reviewed snapshot.

Claims about other PRs in a stack, or about behavior outside the snapshot, need the same care: say how you checked, or say that you did not.

## References

Point at exact captured code with a `gyst:<side>/<path>#L<start>-L<end>` link (or `#L<line>` for one line), such as `[the retry loop](gyst:new/src/retry.ts#L40-L52)`. Write `%20` for spaces in a path, or wrap the target in `<…>`.

- The file may be an unchanged supporting one, but it must be captured in the snapshot: a file created after capture, or a side the snapshot lacks, is rejected.
- A reference is pinned to the snapshot of the batch that writes it. A later refresh never moves it; if the referenced lines change, the text is marked Outdated for you to recheck.
- Other links must be absolute `http(s)` URLs. Relative, fragment, `mailto:` and other schemes are rejected.

## Markdown and Mermaid

Overviews, notes and replies are ordinary Markdown: inline code, emphasis, lists, compact tables, fenced code and Mermaid diagrams in a `mermaid` fence. The viewer renders it safely:

- Raw HTML shows as text; images are rejected; terminal controls and directional overrides are rejected.
- Mermaid is rendered by the viewer with its own theme. Diagrams are rejected when they carry `%%{…}%%` directives, `---` frontmatter, `@{…}` shape data, `$$…$$` math, sequence `properties`, `details`, `links` or `link` statements, or styling (`style`, `classDef`, `linkStyle`, `cssClass`, C4 `Update…Style`, sequence `rect` or `box`).

## Standalone guidance

Write so the walkthrough still makes sense in a month, read by someone who never saw the session's chat: no "as discussed", "the user asked" or "see above in the conversation", and no names of private tools or skills. Use stable symbols and paths. Keep the walkthrough in the session, not in chat.

## Editing guidance

Guidance has stable identities; edit it in place by id (`group.update`, `note.update`, `walkthrough.update`) rather than removing and recreating it, which would also detach a note's conversation. Edits change what the human has read:

| Change                                                              | Effect on Viewed                     |
| ------------------------------------------------------------------- | ------------------------------------ |
| Add, edit or remove a note, or re-anchor it                         | The hunks it anchors become unviewed |
| Edit or remove a group overview                                     | That group's hunks become unviewed   |
| Edit or remove the walkthrough overview                             | The walkthrough becomes unviewed     |
| Reorder groups or files, post a reply, revalidate unchanged wording | None                                 |

So avoid no-op rewrites, and tell the human which parts you changed so they know what to reread.

## After a refresh

A refresh keeps a hunk's identity, group and Viewed only when its body is unchanged; new or changed hunks arrive ungrouped and unviewed. Groups keep their order, and a group that lost every hunk stays in place, empty, until you repair or dissolve it. Notes move with code that only shifted. Guidance whose code or referenced lines changed is kept and marked `outdated` with the reason (`code` or `references`); status lists it under `preparation`.

For each Outdated text, check it against the current snapshot, including the code its references point at:

- If it is still right, keep its wording with `walkthrough.revalidate`, `group.revalidate` or `note.revalidate`. Re-anchor a note to its current range with `note.update` and a new `anchor` in the same batch first, if its range moved or vanished. Revalidation changes no Viewed.
- If it is wrong, rewrite it with `walkthrough.update`, `group.update` or `note.update`.
- Never revalidate what you have not rechecked, or what references code the snapshot lacks.

Place every new hunk in a group, dissolve groups that no longer make sense, and continue until status reports `preparation.state` as `complete`.
