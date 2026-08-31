# Research: TICKET #2 — `@pierre/diffs` for Pith's terminal co-review

## Summary
`@pierre/diffs` is a JavaScript/React **diff-and-file rendering library**, built on Shiki: it owns the web-oriented diff/file presentation layer and the diff data needed to drive it, rather than being a terminal UI toolkit. It can be a useful source of parsed/tokenized diff information for a TUI, as hunk demonstrates by depending on it alongside OpenTUI, but Pith must still own terminal layout/input/rendering and its product-specific pattern-group folding (`exemplar + count`). [npm](https://www.npmjs.com/package/@pierre/diffs) [Diffs documentation](https://diffs.com/)

## Findings

1. **It provides rendering as well as diff/file data; it is not merely a patch parser.** The publisher describes the package as an open-source “diff and file rendering library,” says it is built on Shiki, and distributes both vanilla-JavaScript and React components. The official site describes the same scope as “Render diffs and code, now with edit.” Therefore the safe integration boundary is: Pierre can supply its own web renderers and the model/processing behind them; Pith should not treat it as a small, terminal-neutral `git diff` parser alone. [npm package README](https://www.npmjs.com/package/@pierre/diffs) [Diffs home/docs](https://diffs.com/)

2. **The supported renderer targets are web/DOM targets, not a terminal cell renderer.** The documented delivery forms are vanilla JavaScript and React components, while Diffs.com demonstrates browser code/diff views; neither official source documents ANSI output, an OpenTUI renderer, terminal-width layout, keyboard focus, or a curses-like drawing surface. A terminal application can reuse non-DOM data/processing only where the package's exported API permits it, but it cannot drop a Pierre view into OpenTUI/Solid and get a TUI. **Severity: architectural constraint (not a defect).** [npm package README](https://www.npmjs.com/package/@pierre/diffs) [Diffs home/docs](https://diffs.com/)

3. **hunk uses Pierre as a dependency within a separately-built terminal product, rather than evidence that Pierre itself is a terminal renderer.** hunk's tracked `package.json` declares `@pierre/diffs` version `1.3.5`; hunk's own repository describes hunk as a terminal diff viewer built on OpenTUI and Pierre diffs. Those two primary-source facts support the architectural reading: OpenTUI is the terminal rendering/input layer, and Pierre is a consumed diff package. The dependency declaration is at `modem-dev/hunk/package.json`. [hunk package.json (raw)](https://raw.githubusercontent.com/modem-dev/hunk/main/package.json) [hunk repository README](https://github.com/modem-dev/hunk)

4. **Syntax highlighting is Shiki-backed and theming is part of the web renderer story.** The package's official npm description explicitly says it is “built on Shiki,” so syntax colours/tokens come from the Shiki ecosystem rather than terminal colour handling. Diffs.com markets a customizable code/diff renderer; that makes its themes/options relevant only if Pith adopts Pierre’s web renderer or maps its token/theme output to an OpenTUI palette. Pith should retain one terminal theme mapping and should not assume Pierre CSS or browser theme controls apply to terminal cells. [npm package README](https://www.npmjs.com/package/@pierre/diffs) [Diffs home/docs](https://diffs.com/)

5. **Pith's minimum remaining work is substantial but narrow.**
   - **Terminal adapter/rendering:** draw file headers, hunk separators, line numbers, add/delete/context backgrounds, inline changes, wrapping/scrolling, focus, and keyboard actions using OpenTUI + SolidJS. Pierre's documented React/vanilla renderers do not supply this target. [npm package README](https://www.npmjs.com/package/@pierre/diffs)
   - **Git/session adapter:** obtain the daemon/session's revision and file contents or unified patch, preserve file/hunk identity, and normalize that into whichever Pierre input API Pith elects to use. The public package description establishes rendering scope but does not promise that every raw Git patch form is a stable terminal-ready API. [npm package README](https://www.npmjs.com/package/@pierre/diffs)
   - **Pattern-group folding:** introduce Pith-owned group metadata, e.g. `{ key, exemplarHunkId, occurrenceCount, memberHunkIds, expanded }`, render one exemplar plus a count, and expand/navigate members on demand. This is review-product semantics; no Pierre official source claims to perform semantic/pattern grouping or `exemplar + count` folding. [Diffs home/docs](https://diffs.com/)

## Recommended decision
Use Pierre only after a spike proves that its **non-renderer exports** are stable and usable without a browser. Keep a small Pith adapter boundary around it. Do not base the TUI architecture on Pierre React/DOM components, and do not wait for Pierre to implement grouping: Pith must own grouping and terminal presentation either way.

## Sources
- **Kept:** [@pierre/diffs on npm](https://www.npmjs.com/package/@pierre/diffs) — publisher-controlled package description; establishes rendering scope, web component forms, and Shiki.
- **Kept:** [Diffs.com](https://diffs.com/) — publisher-controlled product/docs site; establishes its code/diff rendering focus.
- **Kept:** [modem-dev/hunk `package.json` (raw)](https://raw.githubusercontent.com/modem-dev/hunk/main/package.json) — direct dependency evidence (`@pierre/diffs: 1.3.5`).
- **Kept:** [modem-dev/hunk README](https://github.com/modem-dev/hunk) — repository's primary statement that hunk is a terminal viewer built on OpenTUI and Pierre diffs.
- **Dropped:** third-party articles, GitHub mirrors, and forum posts — not primary sources and unnecessary for these claims.

## Gaps
- The available primary material establishes the package and hunk dependency, but not a stable, documented contract for a standalone raw-unified-diff parser or a terminal renderer. Before committing, inspect the exact `@pierre/diffs` version's export map/types and hunk's source imports at the locked hunk commit; record the particular non-DOM import(s) used. Do not infer that a package dependency means every hunk display feature is provided by Pierre.
- Theme names, CSS variables, and exact token object shapes were not asserted because the public landing/package descriptions do not constitute a version-pinned API reference. Validate them against the package's shipped declarations before writing the OpenTUI adapter.

## Acceptance report
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings identify the primary-source hunk file path `modem-dev/hunk/package.json`, distinguish the DOM/web rendering constraint, and label the architectural constraint severity."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web_search (primary-source discovery: npm, Diffs.com, modem-dev/hunk)",
      "result": "passed",
      "summary": "Located publisher npm/docs pages and hunk repository/package evidence."
    }
  ],
  "validationOutput": [
    "All retained citations are publisher-controlled or upstream repository primary sources.",
    "No repository files were changed."
  ],
  "residualRisks": [
    "The exact non-DOM exports and source-level imports for the current hunk commit require a version-pinned source inspection before implementation.",
    "Pierre's web theme/token API may not map one-to-one to OpenTUI terminal colours."
  ],
  "noStagedFiles": true,
  "diffSummary": "Research only; no project-code diff.",
  "reviewFindings": [
    "architectural constraint: @pierre/diffs documents web/React rendering, not an ANSI/OpenTUI terminal renderer.",
    "no blockers in Pith source: no Pith files were modified or reviewed as part of this research ticket."
  ],
  "manualNotes": "The ticket's requested hunk source-level consumption conclusion should be confirmed against a locked commit before selecting a Pierre parser/token API."
}
```

One-line gist: Pierre Diffs is a Shiki-backed web diff/file renderer with useful underlying diff processing, while Pith must build the OpenTUI terminal view and its exemplar-plus-count folding itself.
