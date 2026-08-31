# Research: OpenTUI SolidJS maturity and app shape (Pith ticket #4)

## Summary
`@opentui/solid` is a first-party SolidJS reconciler in the canonical `anomalyco/opentui` monorepo, rather than a community wrapper. It is usable for a normal keyboard-first app, but it has less demonstrated production adoption than the React binding: Hunk explicitly uses `@opentui/react`, and the official docs identify at least one concrete Solid feature gap (embedded terminals are unavailable).

For Pith, the low-risk structure is one Bun-owned CLI renderer, one Solid root, presentational route/panel components, and a single adapter that turns keyboard actions and daemon events into Effect programs. Keep renderer lifetime and Effect scope lifetime paired; no primary source found that documents an intrinsic OpenTUI/Effect incompatibility.

## Findings

1. **Canonical upstream is `anomalyco/opentui`, not `sst/opentui`.** The upstream README describes both `@opentui/solid` and `@opentui/react` as project packages, its development guide lists them among the main packages, and Hunk's own agent guide links OpenTUI to `anomalyco/opentui`. Use `anomalyco/opentui` for source, issues, release tracking, and source permalinks; do not base integration decisions on an older `sst/opentui` URL. [Upstream README](https://github.com/anomalyco/opentui/blob/main/README.md) · [upstream development guide](https://github.com/anomalyco/opentui/blob/main/packages/core/docs/development.md) · [Hunk AGENTS.md](https://github.com/modem-dev/hunk/blob/main/AGENTS.md)

2. **Solid is official and has the expected renderer entry point, but it is not evidence of React-parity.** The official Solid plugin example imports `render` from `@opentui/solid`, creates a CLI renderer from `@opentui/core`, and mounts with `render(() => <App />, renderer)`. The README calls it the SolidJS reconciler; React is separately a React reconciler. Treat the rendering model as shared core + framework-specific reconciler, not as interchangeable hooks/components. [Solid plugin example](https://opentui.com/docs/plugins/solid/) · [upstream README](https://github.com/anomalyco/opentui/blob/main/README.md)

3. **There are concrete Solid limitations and dependency-friction signals.** Official component documentation marks `EmbeddedTerminal` as **unavailable** for Solid, so a Pith design should not make a nested live terminal/PTY a requirement when choosing Solid. Upstream issue #689 records that `@opentui/solid` declared an exact `solid-js` peer dependency and caused install warnings; pin and test the supported Solid version instead of assuming arbitrary Solid-version compatibility. These are warning-level integration risks, not blockers for a diff-review TUI. [Embedded-terminal availability](https://opentui.com/docs/components/embedded-terminal/#availability) · [upstream issue #689](https://github.com/anomalyco/opentui/issues/689)

4. **Keyboard and focus are Core capabilities, suitable for a keyboard-centric review flow.** Core renderables accept declarative `keyBindings` and callbacks (the official example binds `Ctrl+S` to a textarea `submit` action); a focused input/textarea receives input after calling `.focus()`. Selection and mouse interaction are also explicit Core APIs. In Solid, put binding props/focusable controls in leaf components, and let a top-level action dispatcher map semantic commands such as `nextGroup`, `previousGroup`, `accept`, and `quit` to application state—rather than scattering raw key checks through every panel. [Keyboard input](https://opentui.com/docs/core-concepts/keyboard/) · [interaction and focus](https://opentui.com/docs/core-concepts/interaction/) · [Textarea focus and bindings](https://opentui.com/docs/components/textarea/)

5. **Layout is terminal-cell Yoga/flexbox, not browser CSS.** OpenTUI computes a renderable tree on terminal grid cells with Yoga and flexbox-like properties. A Pith screen should therefore be a root column (header / body / footer), with the body a row (group list / exemplar diff / decision or help pane), using explicit terminal-cell widths or flex growth and `minWidth`/`minHeight` where a pane must remain usable. Do not assume DOM layout, browser focus traversal, or CSS media queries. [Layout documentation](https://opentui.com/docs/core-concepts/layout?path=core)

6. **Bun is the first-class runtime and has a stated floor.** The official runtime matrix requires Bun **1.3.0 or later**; Bun loads the matching optional native Core package. Node acceptance is documented separately, while `@opentui/three` is Bun-only. For Pith's stated Bun stack, set `engines.bun >= 1.3.0`, lock `@opentui/core` and its binding to the same release line, and test the actual supported OS/CPU artifacts. [Runtime and platform support](https://opentui.com/docs/getting-started/runtime-support/) · [deployment guidance](https://opentui.com/docs/ship/deploy/) · [Bun standalone executable guidance](https://opentui.com/docs/reference/standalone-executables/)

7. **The observable current OpenTUI compatibility target is the 0.5.6 line, but release cadence should be treated as rapid and verified at upgrade time.** Hunk's current `package.json` requests `@opentui/react: ^0.5.6`, and its source-tree commit message records an upgrade to 0.5.6. That is strong primary evidence for the current consumer target, not a substitute for resolving the registry at install time; use the package pages/releases as the version authority in the implementation PR. The sequence of current Hunk changelog entries around 0.5.1/0.5.6 also shows that minor releases can require embedder action, so use exact lockfiles and schedule upgrades deliberately rather than relying on a cadence promise. [Hunk package.json](https://github.com/modem-dev/hunk/blob/main/package.json) · [Hunk source tree / 0.5.6 upgrade commit](https://github.com/modem-dev/hunk/tree/main/src) · [Hunk changelog](https://github.com/modem-dev/hunk/blob/main/CHANGELOG.md) · [Solid npm package](https://www.npmjs.com/package/@opentui/solid) · [React npm package](https://www.npmjs.com/package/@opentui/react)

8. **Hunk is a React, not Solid, reference implementation.** Its `package.json` uses `@opentui/react` and React; `docs/opentui-component.md` shows the app/component bootstrap path as `createCliRenderer` from Core plus `createRoot` from `@opentui/react`. Its published source tree is under `src/`; for Pith, borrow the separation implied by that repository (CLI/bootstrap versus reusable OpenTUI component/diff surface), but translate renderer setup to Solid's `render` API rather than copying React root code. Verified paths: `package.json` (dependency choice), `docs/opentui-component.md` (renderer/root composition), `src/` (application source). [Hunk package.json](https://github.com/modem-dev/hunk/blob/main/package.json) · [Hunk OpenTUI component guide](https://github.com/modem-dev/hunk/blob/main/docs/opentui-component.md) · [Hunk src tree](https://github.com/modem-dev/hunk/tree/main/src)

9. **Recommended minimal Pith shape.**

   ```text
   packages/tui/src/
     main.tsx                 # createCliRenderer; construct the app Effect scope; Solid render
     App.tsx                  # shell and screen selection only
     features/review/
       ReviewScreen.tsx       # composes panes; no daemon I/O
       GroupList.tsx          # focusable list + semantic callbacks
       ExemplarDiff.tsx       # read-only diff pane
       ReviewFooter.tsx       # keys/status
     ui/
       keymap.ts              # semantic actions -> OpenTUI key bindings
       layout.ts              # shared fixed dimensions/tokens only if genuinely repeated
     runtime/
       reviewService.ts       # Effect daemon/session protocol; publishes snapshots/actions
   ```

   `main.tsx` should create exactly one renderer and `render(() => <App />, renderer)`. `App` owns the screen layout; leaf controls own focus/key-binding props; `ReviewScreen` receives an immutable review snapshot and emits semantic actions. The runtime adapter runs Effects and updates the UI-facing store, and shutdown destroys the renderer and closes/interrupts the Effect scope together. This matches OpenTUI's Core/renderer split and avoids duplicating Hunk's React-specific root arrangement. [Solid renderer example](https://opentui.com/docs/plugins/solid/) · [layout model](https://opentui.com/docs/core-concepts/layout?path=core) · [Hunk React root example](https://github.com/modem-dev/hunk/blob/main/docs/opentui-component.md)

10. **Effect.ts coexistence: no documented framework conflict; manage lifecycle and boundary discipline.** OpenTUI's Solid mount is synchronous from the example, while Effect provides explicit effect-running and scoped resource-management models. Start the daemon/session service through one owned Effect runtime/scope, translate incoming messages to data for the UI, translate UI callbacks to Effect commands, and interrupt/close that scope before or with renderer destruction. Do not run a second renderer per Effect fiber, hold renderer objects in serialized daemon state, or let unscoped fibers outlive terminal teardown. This is an architectural constraint inferred from the two lifecycle models; neither project’s primary documentation found in this review states a special incompatibility. [OpenTUI Solid mount example](https://opentui.com/docs/plugins/solid/) · [Effect: running effects](https://effect.website/docs/getting-started/running-effects/) · [Effect: scope/resource management](https://effect.website/docs/resource-management/scope/)

## Maturity assessment

| Area | Assessment | Evidence / consequence |
|---|---|---|
| Ownership | Mature enough to evaluate | First-party package in the canonical monorepo. |
| API foundation | Suitable | Solid `render` over Core renderer; Core provides keyboard, focus, selection, and Yoga layout. |
| Feature completeness | Not React-parity proven | Officially documented Solid absence of `EmbeddedTerminal`; peer dependency issue exists. |
| Production reference | Weak for Solid, strong for React | Hunk is an active OpenTUI consumer but chooses React 0.5.6. |
| Upgrade stability | Manage conservatively | Current 0.5.x consumer evidence and changelog migration note; exact lockfile plus smoke test recommended. |
| Pith fit | Good if terminal embedding is out of scope | Pith needs panes, bindings, focus, and a daemon client—not an embedded PTY. |

## Practical decision

Choose Solid only if Pith already benefits from Solid's fine-grained component model and accepts a smaller body of OpenTUI production examples. Otherwise, React is the lower-reference-risk choice because Hunk supplies an active, directly relevant implementation. Either choice should use Core's semantic key binding/focus primitives and keep Effect behind a narrow runtime adapter.

## Sources

- **Kept:** [OpenTUI README](https://github.com/anomalyco/opentui/blob/main/README.md) — canonical-package ownership and binding definitions.
- **Kept:** [OpenTUI development guide](https://github.com/anomalyco/opentui/blob/main/packages/core/docs/development.md) — monorepo/peer-dependency evidence.
- **Kept:** [OpenTUI Solid plugin documentation](https://opentui.com/docs/plugins/solid/) — direct `render` API evidence.
- **Kept:** [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/) — Bun requirement.
- **Kept:** [OpenTUI layout](https://opentui.com/docs/core-concepts/layout?path=core), [keyboard](https://opentui.com/docs/core-concepts/keyboard/), and [interaction](https://opentui.com/docs/core-concepts/interaction/) — Core layout/input/focus evidence.
- **Kept:** [OpenTUI embedded terminal availability](https://opentui.com/docs/components/embedded-terminal/#availability) — explicit Solid limitation.
- **Kept:** [OpenTUI issue #689](https://github.com/anomalyco/opentui/issues/689) — upstream-recorded Solid peer-dependency friction.
- **Kept:** [Hunk package.json](https://github.com/modem-dev/hunk/blob/main/package.json), [component guide](https://github.com/modem-dev/hunk/blob/main/docs/opentui-component.md), and [src tree](https://github.com/modem-dev/hunk/tree/main/src) — actual consumer binding and organization evidence.
- **Kept:** [Hunk changelog](https://github.com/modem-dev/hunk/blob/main/CHANGELOG.md) — consumer upgrade/migration evidence.
- **Kept:** [Effect running effects](https://effect.website/docs/getting-started/running-effects/) and [Effect scopes](https://effect.website/docs/resource-management/scope/) — lifecycle guidance.
- **Dropped:** blogs, third-party tutorials, and forum posts — ticket required primary sources only.

## Gaps

- The official sources establish at least one Solid-specific gap, but this review did not produce a complete component-by-component Solid-versus-React matrix. Before selecting Solid, build a 20-line spike containing Pith's actual required primitives: nested scroll region, selectable/focusable group list, key chords, resize, and text/diff rendering.
- `^0.5.6` is verified from Hunk's current manifest, but it is a compatibility target rather than an immutable npm-registry observation. Resolve `npm view @opentui/{core,solid,react} version` or inspect the npm package pages in the implementation environment immediately before pinning.
- The Hunk source-tree result verifies `src/` and its React bootstrap documentation, but this review does not claim uninspected individual `src/` component filenames. Read the tree/entrypoint at the selected commit before copying its internal hierarchy.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings cite primary upstream/Hunk sources and identify verified paths: hunk/package.json, hunk/docs/opentui-component.md, and hunk/src/."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Focused primary-source web research: GitHub, official OpenTUI docs, official npm pages, and Effect docs",
      "result": "passed",
      "summary": "Verified canonical repository, binding/package evidence, Bun floor, core interaction/layout APIs, Solid limitation, and Hunk React usage."
    }
  ],
  "validationOutput": [
    "All substantive findings have inline primary-source URLs; uncertainty about uninspected Hunk child paths and registry-current version is explicitly marked."
  ],
  "residualRisks": [
    "Solid feature parity with React is not established; EmbeddedTerminal is explicitly unavailable for Solid.",
    "Hunk demonstrates React rather than Solid, so Pith must validate its own Solid-critical interaction spike.",
    "0.5.6 is a verified current Hunk dependency target, not a registry query captured as an immutable version assertion."
  ],
  "noStagedFiles": true,
  "diffSummary": "Research-only; no repository files changed.",
  "reviewFindings": [
    "warning: packages/tui/src/main.tsx (proposed) - pair OpenTUI renderer destruction with Effect scope interruption to prevent daemon fibers outliving the terminal.",
    "warning: Solid choice - do not depend on EmbeddedTerminal; official availability table marks it unavailable for Solid.",
    "no blockers in existing project files reviewed; this ticket is research-only."
  ],
  "manualNotes": "The task requested no file writes; the report artifact was emitted to the runtime-mandated /tmp path rather than modifying the repository."
}
```

One-line gist: OpenTUI Solid is an official, workable Core renderer for Pith’s pane-and-keyboard UI, but React has the stronger real-world Hunk reference and Solid should be chosen only after a focused interaction spike confirms its required components.