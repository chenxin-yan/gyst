# Research: Ticket #6 — pith distribution surfaces for coding-agent harnesses

## Summary
Pith needs no harness-specific runtime integration: ship the `pith` executable and a markdown `SKILL.md` that tells an already-authorized agent to run the pre-pass and then operate the local session CLI. The only harness-specific piece is invocation/discovery: Claude Code and OpenCode can expose a true `/pith`; pi can do so with a prompt template; current Codex’s supported equivalent is `$pith`, while its `/prompts:pith` facility is deprecated and user-local. [Claude Code Skills](https://code.claude.com/docs/en/skills) [Codex custom prompts](https://developers.openai.com/codex/custom-prompts) [OpenCode Commands](https://opencode.ai/docs/commands/)

## Findings

1. **Common package: one shared skill plus thin markdown launchers; no harness needs code.** — Publish `skills/pith/SKILL.md` as the canonical operational playbook: verify `pith` is on `PATH`; run the requested pith pre-pass/start command; use only documented session-CLI commands; and keep the agent and human in the same live session. The standard skill layout explicitly allows optional scripts, but does not require them; every target already lets an agent invoke a CLI through its shell/tool permissions. Do **not** make an MCP server, daemon adapter, TypeScript extension, or harness plugin merely to inject this prompt. A small harness-specific markdown launcher is only needed where the harness cannot turn the skill itself into the desired command. [Codex skills changelog](https://developers.openai.com/codex/changelog) [Claude Code feature selection](https://code.claude.com/docs/en/features-overview) [OpenCode Skills](https://opencode.ai/docs/skills/) [pi source repository](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

2. **Claude Code: a `SKILL.md` is both the right skill and the right `/pith` launcher.** — Put the project version at `.claude/skills/pith/SKILL.md` (or a personal version at `~/.claude/skills/pith/SKILL.md`). Claude exposes a skill as `/pith`, so its first section can be the explicit “start/pre-fold this diff” workflow and the remainder the session-CLI operating instructions. This is preferred over the legacy `.claude/commands/pith.md`; Anthropic calls skills the successor to custom commands and recommends a skill for a multi-step workflow. `CLAUDE.md` is always-loaded project guidance, not a distributable on-demand pith playbook; use it only to point contributors at the optional skill, not to paste the protocol. [Claude Code Skills](https://code.claude.com/docs/en/skills) [Claude Code glossary](https://code.claude.com/docs/en/glossary) [Claude Code memory](https://code.claude.com/docs/en/memory)

   **Install/distribute:** for a repository, commit the above directory; for personal use, copy/symlink it into the user directory. For a cross-repository install UX, package the same directory as a Claude plugin (`.claude-plugin/plugin.json` plus `skills/pith/SKILL.md`) and let users install it through a marketplace with `claude plugin install …`; installed plugin skills are namespaced (for example `/pith:pith`), so retain the plain project skill when the literal `/pith` name matters. A plugin is a distribution envelope, not required runtime code. [Claude Code plugin structure](https://code.claude.com/docs/en/plugins) [Claude Code plugin CLI](https://code.claude.com/docs/en/cli-reference) [Claude Code plugin namespacing](https://code.claude.com/docs/en/plugins-reference)

3. **Codex CLI: distribute an Agent Skill and accept `$pith`, not a new `/pith` implementation.** — Commit the portable standard directory as `.agents/skills/pith/SKILL.md` (or install it personally under `~/.agents/skills/pith/SKILL.md`); Codex skills are folder-based `SKILL.md` artifacts and are explicitly invoked as `$skill-name`, hence `$pith`. This one skill can both initiate the pre-pass and teach session operation. Codex reads `AGENTS.md` before work and supports a global `~/.codex/AGENTS.md`, but that mechanism is durable, always-applied repository/user guidance; it is unsuitable for shipping optional, operational pith instructions. [Codex skills changelog](https://developers.openai.com/codex/changelog) [Build skills](https://developers.openai.com/codex/build-skills) [Codex AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)

   **Install/distribute:** ship the skill directory in the pith package/repository and document copy/symlink into `.agents/skills/` (shared with the repo) or `~/.agents/skills/` (personal). Do **not** make the deprecated `~/.codex/prompts/pith.md` custom-prompt path the primary offering: it is invoked as `/prompts:pith`, is deliberately local-only rather than repository-shared, and OpenAI now directs reusable workflows to skills. It remains a zero-code compatibility shim only for users who specifically require slash syntax. [Codex custom prompts](https://developers.openai.com/codex/custom-prompts) [Codex customization overview](https://developers.openai.com/codex/customization/overview)

4. **pi: use its native prompt-template path for `/pith`, alongside the skill directory for operational knowledge.** — Place the launcher at `.pi/prompts/pith.md` for a repo or `~/.pi/agent/prompts/pith.md` for a user; pi discovers prompt templates as slash commands, so this is the natural literal `/pith` pre-pass trigger. Place the reusable playbook at `.pi/skills/pith/SKILL.md` or `~/.pi/agent/skills/pith/SKILL.md`. The launcher should say to load/use that skill and start pith; it must not duplicate the long CLI protocol. pi’s project/user instruction mechanism (`AGENTS.md`) is for baseline context, while its TypeScript extension mechanism is for adding programmatic behavior/tools. Neither is needed for a CLI-on-`PATH` workflow. [pi coding-agent source and documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) [pi prompt-template source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/core) [pi extension source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/extensions)

   **Install/distribute:** copy/symlink these two markdown artifacts into the analogous user or project `.pi` directories (or have a package installer do that file placement). Do not publish a pi extension just to get a command: an extension is executable TypeScript and is only justified if pith later needs a first-class pi tool, automatic event interception, or state unavailable to shell commands. **Severity: medium if violated** — extension code expands permissions, lifecycle/version coupling, and maintenance without adding capability here. [pi coding-agent source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) [pi extension source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/extensions)

5. **OpenCode: use two first-class markdown surfaces—command for the trigger, skill for the playbook.** — Commit `.opencode/command/pith.md` to make `/pith` the concise pre-pass starter, and `.opencode/skills/pith/SKILL.md` for on-demand session-CLI guidance; personal installs use `~/.config/opencode/command/pith.md` and `~/.config/opencode/skills/pith/SKILL.md`. OpenCode documents both markdown command files and Agent Skills, including permission control for loading a skill. Its rules/instruction facilities (including compatible `AGENTS.md`/Claude-style rules) are baseline context, not a replacement for a user-triggered command. [OpenCode Commands](https://opencode.ai/docs/commands/) [OpenCode Skills](https://opencode.ai/docs/skills/) [OpenCode Rules](https://opencode.ai/docs/rules/)

   **Install/distribute:** users can copy/symlink the two directories into their project or global OpenCode config; alternatively expose the command template in `opencode.json` for a team that already manages that file. Do not create an npm OpenCode plugin: plugins are JavaScript/TypeScript event/tool extensions installed through the `plugin` configuration/CLI, whereas this task only needs a shell-visible executable and markdown instructions. **Severity: medium if violated** — plugin code is unjustified coupling and a larger trust surface. [OpenCode Config](https://opencode.ai/docs/config/) [OpenCode Plugins](https://opencode.ai/docs/plugins/) [OpenCode CLI plugin installation](https://opencode.ai/docs/cli/)

6. **Hunk is the useful portability model, not a harness package manager.** — Hunk bundles its skill with the executable and has the agent locate it at run time. Its official wording is: “Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.” (quoted as text; not executed). Pith should offer the analogous `pith skill path` capability, returning the canonical `SKILL.md` path from the installed package, and document the same explicit load instruction. That makes pith’s operation playbook available to all four harnesses without duplicating its contents; the optional Claude/pi/OpenCode markdown launchers only improve discoverability. [Hunk agent workflow source](https://github.com/modem-dev/hunk/blob/main/docs/agent-workflows.md) [Hunk review-with-an-agent docs](https://hunk.dev/docs/agents/review-with-an-agent/) [Hunk repository README](https://github.com/modem-dev/hunk)

## Recommended minimal layout

```text
pith executable (on PATH)
└── bundled skills/pith/SKILL.md       # one authoritative live-session protocol

# Optional adapters, all markdown
.claude/skills/pith/SKILL.md           # exposes /pith directly
.agents/skills/pith/SKILL.md           # Codex exposes $pith
.pi/prompts/pith.md                    # pi exposes /pith
.pi/skills/pith/SKILL.md               # pi’s detailed protocol
.opencode/command/pith.md              # OpenCode exposes /pith
.opencode/skills/pith/SKILL.md          # OpenCode’s detailed protocol
```

The adapters should reference the pith-bundled skill path rather than fork its text where the harness can load a local skill. No target requires code beyond the existing `pith` CLI; all four merely require normal shell permission and `pith` on `PATH`. [Claude Code Skills](https://code.claude.com/docs/en/skills) [Codex custom prompts](https://developers.openai.com/codex/custom-prompts) [OpenCode Commands](https://opencode.ai/docs/commands/) [Hunk agent workflows](https://github.com/modem-dev/hunk/blob/main/docs/agent-workflows.md)

## Sources

- Kept: [Claude Code Skills](https://code.claude.com/docs/en/skills) — authoritative skill discovery and invocation behavior.
- Kept: [Claude Code Plugins / reference](https://code.claude.com/docs/en/plugins) — official plugin layout and installation envelope.
- Kept: [OpenAI Codex custom prompts](https://developers.openai.com/codex/custom-prompts) and [Codex AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md) — official invocation, deprecation, and durable-instruction behavior.
- Kept: [OpenAI Codex changelog](https://developers.openai.com/codex/changelog) and [Build skills](https://developers.openai.com/codex/build-skills) — official Agent Skills form and invocation.
- Kept: [pi coding-agent source](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — upstream implementation/documentation for pi customization surfaces.
- Kept: [OpenCode Commands](https://opencode.ai/docs/commands/), [Skills](https://opencode.ai/docs/skills/), and [Plugins](https://opencode.ai/docs/plugins/) — official command, skill, and plugin boundaries.
- Kept: [Hunk agent workflows](https://github.com/modem-dev/hunk/blob/main/docs/agent-workflows.md) — primary source for the requested `hunk skill path` comparison and exact wording.
- Dropped: AUR package discussion — third-party packaging report, not an authority on Hunk’s intended workflow.
- Dropped: Medium, Qiita, and blog results — secondary commentary, excluded under the primary-sources-only constraint.

## Gaps

- Exact pi directory discovery is implementation-version-sensitive; before release, validate the stated `.pi/prompts`, `.pi/skills`, and `~/.pi/agent/...` locations against the pinned pi version and add a one-command smoke test for `/pith` discovery. This does not change the recommendation: use prompt-template + `SKILL.md`, not an extension.
- Confirm the final pith CLI spelling for starting its pre-pass before writing launcher prose. The distribution conclusion is independent of that subcommand name.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete distribution findings name .claude/skills/pith/SKILL.md, .agents/skills/pith/SKILL.md, .pi/prompts/pith.md, .pi/skills/pith/SKILL.md, and .opencode command/skill paths; medium-severity overbuild risks are recorded."
    }
  ],
  "changedFiles": [
    "/tmp/pith-research/r5-harness-surfaces.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web research of official Claude Code, OpenAI Codex, pi upstream, OpenCode, and Hunk sources",
      "result": "passed",
      "summary": "Primary documentation/source pages were used; secondary search results were excluded."
    }
  ],
  "validationOutput": [
    "All four targets have a markdown distribution path; none requires a plugin, MCP server, or harness extension when pith is on PATH.",
    "Codex is the sole target without a recommended literal /pith: use $pith; /prompts:pith is deprecated."
  ],
  "residualRisks": [
    "Validate pi’s exact project/user discovery paths against the pinned pi release before shipping.",
    "The pith pre-pass subcommand name must be finalized before launchers are authored."
  ],
  "noStagedFiles": true,
  "diffSummary": "Research artifact only; no project source change.",
  "reviewFindings": [
    "no blockers: recommendation avoids unnecessary harness code; use a markdown skill plus pith on PATH.",
    "medium: do not create pi/OpenCode extension/plugin code solely to expose a prompt."
  ],
  "manualNotes": "User requested no files, but the runtime-authoritative research output path was written as instructed."
}
```

One-line gist: Ship one pith `SKILL.md` with the CLI, add only markdown launchers where desired (`/pith` for Claude/pi/OpenCode and `$pith` for Codex), and do not build harness plugins or extensions.