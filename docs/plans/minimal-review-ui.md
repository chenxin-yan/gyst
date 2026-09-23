# Minimal review UI

Confirmed with the owner on 2026-09-23; rendered Mermaid was subsequently explicitly deferred after renderer feasibility checks. This plan changes presentation and authoring, not snapshot, group or verdict semantics.

## Experience

- Start in the group browser: ordered group titles and review status on the left, selected group's overview on the right. Keep inbox hunks browsable and distinguish preparation from review completion.
- Enter opens that group: replace the list with its diff, retaining the overview. On wide terminals show both panes; on narrow terminals show one, switched with Tab. Do not stack vertically.
- Use one short group title, one file heading per displayed hunk and compact position/progress. Remove repeated title/path chrome, GROUP labels, persistent instruction paragraphs and zero-inbox readiness boilerplate. Keep meaningful preparation, source-change, failure and editor notices.
- Diffs use all available pane height. Preserve normal diff syntax/added/removed coloring and an obvious but restrained focus indicator.
- Allow temporary full-width expansion of the focused reading pane, preserving reading position when restored.

## Interaction

| Key             | Behavior                                                        |
| --------------- | --------------------------------------------------------------- |
| j / k           | Select groups in the browser; scroll lines while reading        |
| [ / ]           | Previous/next member hunk                                       |
| p / n           | Previous/next group without a verdict                           |
| Tab / Shift-Tab | Switch reading panes                                            |
| z               | Expand/restore the focused reading pane                         |
| a / u           | Mark done and advance / undo                                    |
| Esc             | Restore an expanded pane, otherwise return to the group browser |
| ?               | Show full help                                                  |

Retain half-page scrolling, diff layout selection, editor, explicit refresh and quit controls. Hunk/group navigation must not alter verdicts. Acceptance still covers every member of the group; the inbox is not verdictable.

While scrolling the diff, focus follows the hunk at the top of its viewport, with a visible indication. The shared focus used by gyst-ask and the editor must agree with the displayed hunk. Overview scrolling does not move diff focus. Scroll-derived focus must not snap the viewport to a hunk boundary or create poll/reveal feedback loops. Preserve stale-session/revision/cursor guards and editor input/poll gating.

## Authoring

- Titles name the change briefly instead of explaining it in a sentence. Prefer a few meaningful words; existing schema limits are not a target length.
- An overview is a concise, skimmable breakdown. Mix short sentences, bullets, small headings, selected source context and diagrams when useful. There is no mandatory template, bullet count or artificial short word limit.
- Explain what the diff does not make obvious; do not narrate every line/test or turn the overview into a proof report. Preserve material caveats and distinguish actual execution from inspection when making verification claims.
- Use a positive mixed-Markdown example in the shared authoring skill. Keep refresh/ask references by skill name, existing invocation policies and publication/retry/verdict boundaries.
- Do not rewrite existing sessions or reset acceptance merely to shorten their titles or prose.

## Mermaid — deferred

The owner explicitly chose to defer rendered Mermaid and finish the UI. This delivery retains existing sanitized Mermaid source fences, adds no renderer dependency or private runtime adapter, and makes no diagram-rendering claim. Diagram-specific horizontal panning is deferred with rendering.

The bounded investigation found silent content loss in beautiful-mermaid 1.1.3 and grok-mermaid 0.2.3. A separately authorized read-only check of @mmds/wasm 2.6.1 found stronger diagnostics, but undiagnosed label/shape loss and a public package entry incompatible with Bun 1.4.2. No candidate was adopted.

Future adoption needs an exactly pinned, source-verified renderer with truthful unsupported-content diagnostics and supported initialization. Preserve source fallback, no-wrap geometry and reachable overflow; bound execution and sanitize output/errors. Verify the compiled binary, cancellation and stale-result handling before claiming native Mermaid support. No custom parser, dependency monkey patch or private adapter is authorized.

## Confirmed height defect

The diff-pane ScrollBox root currently sets flexDirection=column. OpenTUI's supported default is a row containing the viewport wrapper and vertical scrollbar. The override puts the scrollbar below the content.

A 263-line added-hunk diagnostic at 200x60 gives a 57-row pane but a 47-row viewport and nine fully blank rows before the footer. Removing only the root override in an external App copy restores a 57-row viewport, side-mounted scrollbar and zero blank rows. Keep the inner diff-content column layout. This is an app configuration fix, not an upstream workaround.

## Acceptance checks

- A tall, long-hunk regression fails before the height fix and passes after it.
- Browse/enter/back, wide/narrow resize, expansion/restore and scrolling show reachable content without repeated chrome or hidden focus.
- j/k scrolls without verdicts; brackets jump hunks; p/n changes groups; scrolling across hunk boundaries updates shared focus without jumping or looping. gyst-ask/editor targets remain coherent, including stale-action protection.
- Human done/advance/undo, progressive publication, inbox navigation, completion and explicit refresh behavior remain correct.
- Markdown formatting and sanitized source fences remain readable and vertically reachable; skills and release notes explicitly avoid claiming native Mermaid rendering.
- Updated authored skills package identically, examples validate, and invocation policy remains unchanged.
- Run relevant regression tests, lint/format/types, full tests, Linux editor PTY suite, host build and six-target packaging/build checks. Report real runtime evidence separately from cross-builds.

No commit, push, PR, merge or publication is authorized by this implementation request.
