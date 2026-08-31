# Research: Ticket #3 — trees.software

## Summary
**trees.software is Pierre’s browser file-tree rendering library, published as `@pierre/trees`; it is not a terminal-tree library.** It includes path-to-tree/model preparation and stateful renderers, but its supported render targets are React and browser DOM/vanilla JavaScript—not SolidJS and not OpenTUI. It therefore does **not** fit Pith’s OpenTUI + SolidJS TUI; implementing Pith’s small tree directly is the lower-risk option.

## Findings
1. **Actual package surface — `@pierre/trees`, not a package named `trees.software`.** The official install instructions name `@pierre/trees`. The root import is the vanilla-browser API; `@pierre/trees/react` is a React-specific subpath export; and `@pierre/trees/ssr` contains its SSR payload/types. These are subpath APIs of the same package, not separate Solid or terminal packages. [`trees.software` docs](https://trees.software/docs#get-started-with-react) · [npm package metadata](https://registry.npmjs.org/@pierre%2ftrees/latest)

2. **It is primarily a UI renderer with a file-path/tree model, not a generic standalone tree-data-structure library.** The documented API takes a list of file paths, creates a `FileTree` (or React `useFileTree` model), and renders it with features such as expansion/search. That model logic is useful only coupled to its browser renderer; the public positioning is explicitly “A file tree rendering library.” [Official site](https://trees.software/) · [React and vanilla API examples](https://trees.software/docs)

3. **P0 / integration blocker — its rendered UI is DOM-only.** The vanilla integration requires `document.getElementById(...)`, checks for `HTMLElement`, and calls `render({ fileTreeContainer })`; styling is CSS/custom-property based. The React integration renders a React component. Neither is an ANSI/cell renderer nor a Solid component, and SSR still hydrates into the browser DOM. OpenTUI renders terminal UI rather than browser DOM, so this package cannot be mounted in Pith without writing a DOM emulation/adapter—which would be the wrong abstraction. [Vanilla and SSR examples](https://trees.software/docs#ssr-vanilla-flow) · [React example](https://trees.software/docs#ssr-react-flow) · [CSS-based styling](https://trees.software/#styling) · [OpenTUI documentation](https://opentui.com/docs)

4. **License — AGPL-3.0.** The upstream repository’s license file and the published package metadata are the authoritative declarations. This is also material if Pith ever copied source rather than merely evaluated the package: do not assume MIT/Apache terms. [Upstream `LICENSE`](https://github.com/pierrecomputer/pierre/blob/main/LICENSE) · [npm manifest](https://registry.npmjs.org/@pierre%2ftrees/latest)

5. **Maturity/activity — a real, maintained open-source project, but no evidence that it promises TUI compatibility or a stability/SLA suitable for making it a foundational Pith dependency.** It has official documentation, an npm publication, a public monorepo and public issue tracker (for example, issue #744). Those establish a live project; they do not turn its web/React API into a portable rendering primitive. Treat the registry version/timestamps and the repository commit feed as the live authority before any future adoption rather than pinning this conclusion to an aging blog post or aggregator. [Repository](https://github.com/pierrecomputer/pierre) · [issue tracker example](https://github.com/pierrecomputer/pierre/issues/744) · [commit feed](https://github.com/pierrecomputer/pierre/commits/main) · [npm metadata](https://registry.npmjs.org/@pierre%2ftrees/latest)

6. **Recommendation for Pith — do not add `@pierre/trees`.** The closest fit is Pith’s existing OpenTUI/Solid primitives: render a flattened visible-row list in a scrollable box/text rows, retain `expanded: Set<string>` and a selected row index, and handle left/right/enter plus up/down in the existing keyboard flow. For Pith’s stated co-review use case, a minimal own component is roughly **80–150 TypeScript LOC** (path insertion + flattening + row rendering + keys), excluding optional fuzzy search, filesystem watching, drag/drop, or accessibility work that browser Trees already solves. This is an estimate, not an upstream claim. [OpenTUI docs](https://opentui.com/docs) · [Trees feature/API scope](https://trees.software/docs)

## Sources
- **Kept:** [Trees official site](https://trees.software/) — first-party statement of purpose and CSS styling model.
- **Kept:** [Trees official documentation](https://trees.software/docs) — first-party installation, React, vanilla and SSR API evidence.
- **Kept:** [npm registry: `@pierre/trees` latest manifest](https://registry.npmjs.org/@pierre%2ftrees/latest) — publisher/package/version/license metadata authority.
- **Kept:** [Pierre upstream repository](https://github.com/pierrecomputer/pierre) and [license](https://github.com/pierrecomputer/pierre/blob/main/LICENSE) — upstream source and license authority.
- **Kept:** [Upstream issue #744](https://github.com/pierrecomputer/pierre/issues/744) and [commit feed](https://github.com/pierrecomputer/pierre/commits/main) — first-party activity evidence.
- **Kept:** [OpenTUI documentation](https://opentui.com/docs) — target renderer context.
- **Dropped:** daily.dev repost of the Trees announcement — third-party repost; excluded to keep the evidence set primary-only.
- **Dropped:** Socket/Yarn package mirrors — secondary mirrors; npm registry is authoritative.

## Gaps
- The live npm manifest and commit feed should be rechecked at the exact time of any dependency decision because package versions, publication times, and activity change.
- This ticket did not require a Pith implementation review. No Pith file path needs modification, and no external DOM-to-terminal adapter is recommended.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings identify the external package/API surface, the P0 DOM-versus-TUI integration blocker, and the applicable source locations/URLs; no Pith source file is implicated by this research-only ticket."
    }
  ],
  "changedFiles": [
    "/tmp/pith-research/r2-trees-software.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Primary-source web research: trees.software docs, npm registry, upstream GitHub repository/license/issues/commits, OpenTUI docs",
      "result": "passed",
      "summary": "Sources establish package surface, DOM/React rendering contract, license, and fit assessment."
    }
  ],
  "validationOutput": [
    "Review conclusion: P0 integration blocker — @pierre/trees requires browser DOM or React and is not suitable for an OpenTUI + SolidJS terminal renderer.",
    "Research artifact written to the required path."
  ],
  "residualRisks": [
    "Upstream npm version, release cadence, and source layout can change; verify the live registry manifest and commit feed before any future adoption.",
    "The 80–150 LOC own-component estimate excludes optional search, filesystem watching, drag/drop, and terminal-specific UX polish."
  ],
  "noStagedFiles": true,
  "diffSummary": "Research-only artifact; no Pith application or dependency files changed.",
  "reviewFindings": [
    "P0: external @pierre/trees integration — documented renderer requires document/HTMLElement/CSS or React, so it cannot render in Pith's OpenTUI terminal surface.",
    "No Pith source-file defect found or modification required."
  ],
  "manualNotes": "Primary sources only; third-party search results were excluded from findings."
}
```

One-line gist: `@pierre/trees` is an AGPL browser/React file-tree renderer, not a Solid/OpenTUI terminal component, so Pith should build its small keyboard tree with native OpenTUI primitives instead.
