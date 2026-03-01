# Agent Switchboard

[![npm version](https://img.shields.io/npm/v/agent-switchboard)](https://www.npmjs.com/package/agent-switchboard)
[![CI](https://github.com/qyhfrank/agent-switchboard/actions/workflows/ci.yml/badge.svg)](https://github.com/qyhfrank/agent-switchboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Manage MCP servers, rules, commands, agents, skills, and hooks from a single source of truth, then sync them to every AI coding agent you use.

Alias: `asb`

## Why

AI coding agents (Codex, Claude Code, Cursor, Gemini, OpenCode ...) each store MCP servers, prompt rules, slash commands, and skills in their own formats and locations. When you add a new MCP server or tweak a coding rule, you repeat the work for each agent. Configs drift, setups go stale.

Agent Switchboard solves this with **one library, one config, many targets**:

```
Libraries              Config Layers            Distribution
┌──────────────┐    ┌─────────────────────┐    ┌────────────────┐
│ mcp.json     │    │ User   config.toml  │    │ Claude Code    │
│ rules/       │    │ Profile <name>.toml │    │ Codex          │
│ commands/    │ ─► │ Project .asb.toml   │ ─► │ Cursor         │
│ agents/      │    │                     │    │ Gemini         │
│ skills/      │    │ Per-app overrides   │    │ OpenCode       │
│ hooks/       │    │                     │    │ Claude Desktop │
└──────────────┘    └─────────────────────┘    └────────────────┘
```

Library entries are agent-agnostic Markdown files (or directories for skills, JSON for hooks). Agent Switchboard reads them, applies layered configuration and per-application overrides, then writes the correct format to each agent's config location.

## Compatibility

| Feature          | Claude Code | Codex | Cursor | Gemini | OpenCode | Claude Desktop |
|:-----------------|:-----------:|:-----:|:------:|:------:|:--------:|:--------------:|
| MCP servers      | ✓           | ✓     | ✓      | ✓      | ✓        | ✓              |
| Project-level MCP| ✓           | ✓     | ✓      | ✓      | ✓        |                |
| Rules            | ✓           | ✓     | ✓ mdc  | ✓      | ✓        |                |
| Commands         | ✓           | ✓\*   | ✓      | ✓      | ✓        |                |
| Agents           | ✓           |       | ✓      |        | ✓        |                |
| Skills           | ✓           | ✓     | ✓      | ✓      | ✓        |                |
| Hooks            | ✓           |       |        |        |          |                |

\* Codex commands use deprecated `~/.codex/prompts/`; prefer skills instead.

Cursor rules are distributed as individual `.mdc` files to `~/.cursor/rules/` (native format), not as a single composed document.

## Quick Start

```bash
npm i -g agent-switchboard    # or: npx agent-switchboard@latest mcp
```

1. **Pick your agents** -- create `~/.agent-switchboard/config.toml`:

```toml
[applications]
active = ["claude-code", "codex", "cursor"]
```

2. **Manage MCP servers** -- launches an interactive checkbox UI:

```bash
asb mcp
```

3. **Sync everything** -- pushes all libraries (rules, commands, agents, skills, hooks) and MCP config to every active application:

```bash
asb sync
```

That's it. Library content lives under `~/.agent-switchboard/` and agent configs are updated in place.

## Command Reference

| Command              | Description                                             |
|:---------------------|:--------------------------------------------------------|
| `asb mcp`            | Interactive MCP server selector                         |
| `asb rule`           | Interactive rule snippet selector with ordering         |
| `asb command`        | Interactive command selector                            |
| `asb agent`          | Interactive agent selector                              |
| `asb skill`          | Interactive skill selector                              |
| `asb hook`           | Interactive hook selector (Claude Code only)            |
| `asb sync`           | Push all libraries + MCP to applications (no UI)        |
| `asb <lib> load`     | Import files from a platform into the library           |
| `asb <lib> list`     | Show inventory, activation state, and sync timestamps   |
| `asb source add`     | Add an external library source (local path or git URL)  |
| `asb source remove`  | Remove a library source                                 |
| `asb source list`    | List configured library sources                         |

`<lib>` = `rule`, `command`, `agent`, `skill`, or `hook`.

**Shared flags**: `-p, --profile <name>`, `--project <path>`, `--json` (on `list` and `source list`).

## Configuration

### `config.toml`

The central config file at `~/.agent-switchboard/config.toml` controls which applications and library entries are active:

```toml
[applications]
active = ["claude-code", "codex", "cursor", "gemini", "opencode"]

[rules]
includeDelimiters = false   # wrap each rule snippet in <!-- id:start/end --> markers
```

Supported application IDs: `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `opencode`.

### Per-Application Overrides

Fine-tune which library entries reach each application using `add` / `remove` / `active`:

```toml
[applications]
active = ["claude-code", "codex", "opencode"]

codex.skills.remove = ["skill-codex"]
codex.rules.remove  = ["skill-codex"]

gemini.commands.add    = ["cmd-gemini-only"]
gemini.skills.remove   = ["skill-go"]
```

| Syntax                          | Behavior                   |
|:--------------------------------|:---------------------------|
| `<app>.<section>.active = [...]`| Replace the global list    |
| `<app>.<section>.add = [...]`   | Append to the global list  |
| `<app>.<section>.remove = [...]`| Remove from the global list|

Sections: `mcp`, `rules`, `commands`, `agents`, `skills`, `hooks`.

### Layered Configuration

Three TOML layers merge in priority order (higher wins):

| Layer   | File                            | Scope                             |
|:--------|:--------------------------------|:----------------------------------|
| User    | `<ASB_HOME>/config.toml`        | Personal defaults                 |
| Profile | `<ASB_HOME>/<profile>.toml`     | Team or workflow presets (`-p`)    |
| Project | `<project>/.asb.toml`           | Per-repository overrides          |

```bash
asb command -p team                        # profile layer
asb rule --project /path/to/repo           # project layer
asb agent -p team --project /path/to/repo     # both
```

When `--project` is used, outputs target the project directory (e.g. `<project>/AGENTS.md`, `<project>/.claude/commands/`).

## Libraries

All library types follow the same pattern:

1. **Store** entries in `~/.agent-switchboard/<type>/` as Markdown files (or directories for skills).
2. **Import** existing platform files: `asb <type> load <platform> [path] [-r]`.
3. **Select** active entries: `asb <type>` (interactive fuzzy-search selector).
4. **Audit** inventory: `asb <type> list [--json]`.

Selections are saved into the highest-priority config layer. Distribution writes each entry in the format the target agent expects, skipping unchanged files (hash-based).

### Rules

Snippets in `~/.agent-switchboard/rules/` with optional YAML frontmatter:

```markdown
---
title: Prompt Hygiene
tags: [hygiene]
requires: [claude-code]
---
Keep commit messages scoped to the change.
```

Cursor-specific options can be set via `extras.cursor` in rule frontmatter:

```markdown
---
title: Python Rules
description: Python coding standards
extras:
  cursor:
    alwaysApply: false
    globs: "*.py"
---
Use type hints everywhere.
```

The interactive selector lets you **reorder** snippets. For most agents, rules are composed into a single document. For Cursor, each rule is written as an individual `.mdc` file with native frontmatter (`description`, `alwaysApply`, `globs`):

| Agent       | Global output                       | Project output                    |
|:------------|:------------------------------------|:----------------------------------|
| Claude Code | `~/.claude/CLAUDE.md`               | `<project>/.claude/CLAUDE.md`     |
| Codex       | `~/.codex/AGENTS.md`                | `<project>/AGENTS.md`             |
| Cursor      | `~/.cursor/rules/<id>.mdc`          | `<project>/.cursor/rules/<id>.mdc`|
| Gemini      | `~/.gemini/AGENTS.md`               | `<project>/.gemini/AGENTS.md`     |
| OpenCode    | `~/.config/opencode/AGENTS.md`      | `<project>/AGENTS.md`             |

### Commands

Markdown files in `~/.agent-switchboard/commands/` with optional `description` and `extras.<platform>`:

```bash
asb command load claude-code           # import from ~/.claude/commands/
asb command load gemini [path] -r      # import recursively
```

Platforms: `claude-code`, `codex`, `cursor`, `gemini`, `opencode`.

### Agents

Same format as commands, stored in `~/.agent-switchboard/agents/`.

```bash
asb agent load claude-code             # import from ~/.claude/agents/
```

Platforms: `claude-code`, `opencode`, `cursor`.

### Skills

Multi-file directory bundles in `~/.agent-switchboard/skills/<skill-id>/`, each containing a `SKILL.md` entry file:

```
~/.agent-switchboard/skills/my-skill/
├── SKILL.md          # name + description in frontmatter
├── helper.py
└── templates/
    └── template.txt
```

```bash
asb skill load claude-code             # import from ~/.claude/skills/
asb skill load codex                   # import from ~/.agents/skills/
```

Entire directories are copied to each agent's skill location. Deactivated skills are cleaned up automatically.

### Hooks

JSON-based hook definitions distributed to Claude Code's `settings.json`. Two storage formats:

- **Single file**: `~/.agent-switchboard/hooks/<id>.json`
- **Bundle**: `~/.agent-switchboard/hooks/<id>/hook.json` plus script files

```bash
asb hook load claude-code              # import from ~/.claude/settings.json
asb hook load /path/to/hook.json       # import a JSON file
asb hook load /path/to/hook-dir/       # import a bundle directory
```

Bundle scripts are copied to `~/.claude/hooks/asb/<id>/` and the `${HOOK_DIR}` placeholder in commands is resolved to the absolute path at distribution time.

## Library Sources

Pull library entries from external directories or git repos:

```bash
asb source add https://github.com/org/repo             # name defaults to "repo"
asb source add /path/to/team-library team              # explicit name
asb source list                                        # list configured sources
asb source remove repo                                 # remove
```

A source can be a flat directory containing `rules/`, `commands/`, `agents/`, `skills/`, or `hooks/` subdirectories, or a `.claude-plugin` marketplace (detected by the presence of `.claude-plugin/marketplace.json`). Entries from external sources appear with a namespace prefix (e.g. `team:my-rule`) in selectors and config.

## Sync

Push all libraries and MCP config to every active application in one step:

```bash
asb sync [-p <profile>] [--project <path>]
```

This merges layered config, applies per-application overrides, and writes target files in place. Files are only rewritten when content changes.

## Environment

| Variable         | Default                    | Purpose                                      |
|:-----------------|:---------------------------|:---------------------------------------------|
| `ASB_HOME`       | `~/.agent-switchboard`     | Library, config, and state directory          |
| `ASB_AGENTS_HOME`| OS user home               | Base path for agent config locations          |

## Development

```bash
pnpm install                # also activates git hooks via postinstall
pnpm build
pnpm link --global          # global `agent-switchboard` points to local build
```

Code changes take effect after `pnpm build`. To unlink: `pnpm uninstall -g agent-switchboard`.

Other scripts: `pnpm dev` (tsx), `pnpm test`, `pnpm lint`, `pnpm typecheck`.

### Git Hooks

`pnpm install` automatically sets `core.hooksPath` to `.githooks/`. The pre-commit hook runs `biome check --write --staged` on staged files, ensuring all committed code passes formatting and lint checks.

### Releasing

Use the release script instead of manually tagging:

```bash
pnpm release           # patch bump (default): 0.1.27 → 0.1.28
pnpm release minor     # minor bump: 0.1.27 → 0.2.0
pnpm release major     # major bump: 0.1.27 → 1.0.0
pnpm release 0.2.0     # explicit version
```

The script performs these steps in order:

1. Verify working tree is clean and main is in sync with origin
2. Run the full validation suite: lint, typecheck, test, build
3. Bump `version` in `package.json`
4. Commit and tag (`v<version>`)
5. Push commit and tag to origin

This guarantees the CI Release workflow will pass, since the exact same checks run locally first.

## License

MIT
