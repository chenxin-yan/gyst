# Research: Markdown and Mermaid rendering in gyst

## Summary
- Use `react-markdown` with optional `remark-gfm`, **without raw HTML**. Route fenced `mermaid` through a lazily imported renderer and other fenced code through Shiki ([react-markdown](https://github.com/remarkjs/react-markdown#architecture)).
- Begin with **official Mermaid**, strict security, app-owned theme, and a visible source/error fallback. Consider its tiny build only after confirming supported diagram types ([Mermaid usage](https://mermaid.js.org/config/usage.html#tiny-mermaid)).
- Use Catppuccin palette colors for Latte, Frappé, Macchiato, Mocha; style Markdown with CSS, and regenerate Mermaid SVG when flavor changes ([palette](https://catppuccin.com/palette/), [Mermaid theming](https://mermaid.js.org/config/theming.html#customizing-themes-with-themevariables)).
- Agent/repository text remains untrusted despite loopback serving: do not enable embedded HTML or agent-controlled diagram configuration by default (researcher recommendation).

## Findings

1. **Markdown: direct evidence; high confidence.** `react-markdown` maps parsed Markdown to React elements, supports custom `code` components and optional `remark-gfm`, escapes raw HTML by default, and uses a default URL transform ([architecture](https://github.com/remarkjs/react-markdown#architecture), [HTML](https://github.com/remarkjs/react-markdown#appendix-a-html-in-markdown), [security](https://github.com/remarkjs/react-markdown#security)). Avoid `rehype-raw`: its documentation assumes trusted input and estimates **±60 KB minzipped** extra. If raw HTML becomes essential, pair it with `rehype-sanitize` *after* unsafe transforms; later transforms can invalidate sanitization ([rehype-sanitize security](https://github.com/rehypejs/rehype-sanitize#security)). **Inference:** block remote images by default and require a conscious policy for external links, which otherwise trigger network/navigation in the local app.

2. **Alternatives: direct evidence; high confidence.** `marked` expressly does **not** sanitize its output, advising DOMPurify on rendered HTML ([Marked README](https://github.com/markedjs/marked#usage)); `markdown-it` describes itself as safe by default but returns an HTML string ([README](https://github.com/markdown-it/markdown-it#usage)). **Interpretation:** either creates an extra HTML-insertion boundary in React. DOMPurify handles HTML and SVG, but warns that modifying already-sanitized markup can undo its guarantees ([README](https://github.com/cure53/DOMPurify#what-does-it-do), [foot-gun](https://github.com/cure53/DOMPurify#is-there-any-foot-gun-potential)). Do not add it solely for raw-HTML-disabled `react-markdown`.

3. **Mermaid safety: direct evidence; high confidence.** Mermaid's default `securityLevel: 'strict'` encodes HTML labels and disables click functions; `loose` allows both, while `sandbox` iframe mode is documented as beta ([usage](https://mermaid.js.org/config/usage.html#securitylevel)). Mermaid's render path DOMPurify-sanitizes resulting SVG except in loose/sandbox modes ([source](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaidAPI.ts)). Its protected config defaults include `securityLevel`, `maxTextSize`, `maxEdges`, `suppressErrorRendering`, so diagram directives cannot reset those values ([schema](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/schemas/config.schema.yaml)). **Inference:** size limits may need lowering for UI responsiveness. Appearance controls are *not* similarly protected: diagram frontmatter/directives outrank `initialize()` ([theming](https://mermaid.js.org/config/theming.html#per-diagram-defaults)). Strip/reject author config if uniform theming is required; do not rely on initialization alone. Avoid binding `render()`'s optional click handlers.

4. **Errors: direct evidence; high confidence.** `mermaid.parse()` validates without rendering and throws on invalid syntax unless suppression is selected; `render()` returns SVG; `suppressErrorRendering` prevents Mermaid's injected error drawing ([usage](https://mermaid.js.org/config/usage.html#syntax-validation-without-rendering), [API](https://mermaid.js.org/config/usage.html#api-usage), [schema](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/schemas/config.schema.yaml)). **Recommended inference:** `initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,...})`; try/catch `render()` per fenced block (optional pre-parse) and present escaped error text alongside the original, copyable Mermaid source. A broken graph must not hide agent guidance.

5. **Weight and syntax: direct evidence with limitations; medium confidence.** Official `mermaid-tiny` is described as **roughly half** the full library, excluding mindmaps, architecture, KaTeX, ELK and internal lazy loading ([usage](https://mermaid.js.org/config/usage.html#tiny-mermaid)). `beautiful-mermaid` claims six diagram families, synchronous SVG, Catppuccin Mocha/Latte presets and CSS-variable live theme switching, but not full Mermaid syntax ([README](https://github.com/lukilabs/beautiful-mermaid#features), [themes](https://github.com/lukilabs/beautiful-mermaid#theming)); its declared dependencies include `elkjs` and `entities`, so its actual shipped weight is unverified ([package.json](https://github.com/lukilabs/beautiful-mermaid/blob/main/package.json)). `@crafter/mermaid` self-reports **30.5 KB min+gzip**, eight diagram families and Mocha/Latte presets; this is a vendor claim, not an independent production benchmark ([README](https://github.com/crafter-station/mermaid#why)). **Inference:** dynamically import Mermaid only when a visible fence needs it; app-level chunk splitting differs from Mermaid's internal diagram lazy loading. Measure the built app before changing syntax engines.

6. **Themes and Shiki: direct evidence; high confidence.** Catppuccin has one light flavor (Latte) and three dark (Frappé, Macchiato, Mocha), with official palette CSS ([palette](https://catppuccin.com/palette/), [package](https://github.com/catppuccin/palette)). Mermaid custom `themeVariables` work with `theme:'base'`; use hex colors and `darkMode` to control derived colors ([theming](https://mermaid.js.org/config/theming.html#customizing-themes-with-themevariables)). **Inference:** map official `base`/`text`/`surface`/accent colors to diagram `background`/`primaryTextColor`/`primaryColor`/`lineColor`; set Latte to light and the other three to dark, regenerate Mermaid SVG on switch. No dedicated first-party Catppuccin Mermaid or generic Markdown port was verified. Catppuccin publishes four official VS Code JSON themes expressly usable by **Shiki** ([VS Code README](https://github.com/catppuccin/vscode#using-the-json-files)). `@pierre/diffs` depends on Shiki, but an API to share its *highlighter instance* was not established ([Pierre package](https://github.com/pierrecomputer/pierre/blob/main/packages/diffs/package.json)). Shiki recommends a cached instance and fine-grained `shiki/core`/selected language and theme imports for web size; its JavaScript regex engine can reduce browser startup ([guide](https://shiki.style/guide/best-performance)). **Inference:** lazy-load Markdown highlighting, render plain escaped code for unknown/loading languages, and avoid unsanitized Shiki HTML insertion.

## Comparison

| Option | Integration / trust | Weight / syntax |
|---|---|---|
| `react-markdown` | React nodes; HTML off by default ([README](https://github.com/remarkjs/react-markdown#security)) | GFM optional; `rehype-raw` adds ±60 KB minzipped ([README](https://github.com/remarkjs/react-markdown#appendix-a-html-in-markdown)) |
| `markdown-it` / `marked` | HTML string; `marked` needs output sanitizer ([Marked](https://github.com/markedjs/marked#usage)) | No comparable measured bundle figure |
| Mermaid / tiny | Strict mode and built-in output sanitization ([source](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaidAPI.ts)) | Broad syntax; tiny ~half but omits features ([usage](https://mermaid.js.org/config/usage.html#tiny-mermaid)) |
| `beautiful-mermaid` | SVG string; validate/sanitize insertion independently ([README](https://github.com/lukilabs/beautiful-mermaid#features)) | Six families, live CSS-variable theming; bundle unmeasured |

## Recommendation with trade-offs
Use `react-markdown` + optional GFM, official lazy-loaded Mermaid strict mode, and Shiki for non-Mermaid code. Keep Markdown HTML disabled, author Mermaid configuration out, and a source/error fallback in. Use app CSS/official Catppuccin colors and re-render SVG on flavor change. This favors broad Mermaid compatibility and its existing sanitizer over smaller but grammar-limited third-party renderers; trade-off is Mermaid's heavier optional chunk. If SVG insertion changes or another renderer is chosen, independently review SVG sanitization. Check Pierre for a supported shared Shiki API before creating a second highlighter.

## Contradictions
Mermaid claims tiny is approximately half full size, whereas a third-party README describes full Mermaid as ~2 MB and itself as 30.5 KB; these are **not** independently measured/comparable production builds ([Mermaid](https://mermaid.js.org/config/usage.html#tiny-mermaid), [crafter](https://github.com/crafter-station/mermaid#why)). Mermaid's secure config keys resist directives, but appearance settings can be overridden by frontmatter ([schema](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/schemas/config.schema.yaml), [theming](https://mermaid.js.org/config/theming.html#per-diagram-defaults)).

## Missing evidence / open questions for human decision
- Which diagram families are required? If only flowcharts/sequences, benchmark tiny or a restricted renderer with real agent diagrams.
- Should external Markdown links, images, or per-diagram styling be allowed? Conservative default: no remote images or author theme overrides.
- Actual bundled bytes, memory and rendering latency for gyst were not measured. `source_check` validation search failed because SearXNG was not configured; important facts were checked directly against first-party docs/source, but third-party performance claims remain unverified.

## Sources
- Kept: [react-markdown](https://github.com/remarkjs/react-markdown), [Mermaid documentation](https://mermaid.js.org/config/usage.html) and [source/schema](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaidAPI.ts), [Catppuccin palette](https://catppuccin.com/palette/), [Shiki](https://shiki.style/guide/best-performance) — primary implementation/security/theme evidence.
- Rejected/deprioritized: vendor bundle numbers as cross-library benchmarks; unverified unofficial Mermaid/Markdown Catppuccin ports.

## Next steps
Prototype malformed/malicious text and four flavor switches; inspect actual production chunks, diagram support and external URL behavior.

```acceptance-report
{
  "criteriaSatisfied": [{"id": "criterion-1", "status": "satisfied", "evidence": "Bound report gives concise primary-source recommendation and residual risks"}],
  "changedFiles": ["/home/cyan/.pi/agent/sessions/--home-cyan-dev-github.com-chenxin-yan-pith--/subagent-artifacts/outputs/90673039-7e21-4126-96c2-ee346260cc01/research/render.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [{"command": "web_search, fetch_content, source_check", "result": "passed", "summary": "First-party sources fetched; source_check provider unavailable, disclosed"}],
  "validationOutput": ["Bound output file written; repository unchanged"],
  "residualRisks": ["Actual bundle weight and partial-renderer syntax need benchmarking", "source_check provider unavailable; critical citations manually checked in primary sources"],
  "noStagedFiles": true,
  "diffSummary": "Research artifact only",
  "reviewFindings": ["no blockers"],
  "manualNotes": "No shell; used ticket question quoted by requester. No GitHub issue or repo edits."
}
```
