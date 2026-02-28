# Agent Switchboard

[![npm version](https://img.shields.io/npm/v/agent-switchboard)](https://www.npmjs.com/package/agent-switchboard)
[![CI](https://github.com/qyhfrank/agent-switchboard/actions/workflows/ci.yml/badge.svg)](https://github.com/qyhfrank/agent-switchboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Manage MCP servers, rules, commands, subagents, and skills from a single source of truth, then sync them to every AI coding agent you use.

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
│ subagents/   │    │                     │    │ Gemini         │
│ skills/      │    │ Per-agent overrides │    │ OpenCode       │
└──────────────┘    └─────────────────────┘    │ Claude Desktop │
                                               └────────────────┘
```

All library entries are agent-agnostic Markdown files (or directories for skills). Agent Switchboard reads them, applies layered configuration and per-agent overrides, then writes the correct format to each agent's config location.

## Compatibility

| Feature          | Claude Code | Codex | Cursor | Gemini | OpenCode | Claude Desktop |
|:-----------------|:-----------:|:-----:|:------:|:------:|:--------:|:--------------:|
| MCP servers      | ✓           | ✓     | ✓      | ✓      | ✓        | ✓              |
| Project-level MCP| ✓           | ✓     | ✓      | ✓      | ✓        |                |
| Rules            | ✓           | ✓     | ✓ mdc  | ✓      | ✓        |                |
| Commands         | ✓           | ✓\*   | ✓      | ✓      | ✓        |                |
| Subagents        | ✓           |       | ✓      |        | ✓        |                |
| Skills           | ✓           | ✓     | ✓      | ✓      | ✓        |                |

\* Codex commands use deprecated `~/.codex/prompts/`; prefer skills instead.

Cursor rules are distributed as individual `.mdc` files to `~/.cursor/rules/` (native format), not as a single composed document.

## Quick Start

```bash
npm i -g agent-switchboard    # or: npx agent-switchboard@latest mcp
```

1. **Pick your agents** -- create `~/.agent-switchboard/config.toml`:

```toml
[agents]
active = ["claude-code", "codex", "cursor"]
```

2. **Manage MCP servers** -- launches an interactive checkbox UI:

```bash
asb mcp
```

3. **Sync everything** -- pushes all libraries (rules, commands, subagents, skills) and MCP config to every active agent:

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
| `asb subagent`       | Interactive subagent selector                           |
| `asb skill`          | Interactive skill selector                              |
| `asb sync`           | Push all libraries + MCP to agents (no UI)              |
| `asb <lib> load`     | Import files from a platform into the library           |
| `asb <lib> list`     | Show inventory, activation state, and sync timestamps   |
| `asb source add`     | Add an external library source (local path or git URL)  |
| `asb source remove`  | Remove a library source                                 |
| `asb source list`    | List configured library sources                         |

`<lib>` = `rule`, `command`, `subagent`, or `skill`.

**Shared flags**: `-p, --profile <name>`, `--project <path>`, `--json` (on `list` and `source list`).

## Configuration

### `config.toml`

The central config file at `~/.agent-switchboard/config.toml` controls which agents and library entries are active:

```toml
[agents]
active = ["claude-code", "codex", "cursor", "gemini", "opencode"]

[rules]
includeDelimiters = false   # wrap each rule snippet in <!-- id:start/end --> markers
```

Supported agent IDs: `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `opencode`.

### Per-Agent Overrides

Fine-tune which library entries reach each agent using `add` / `remove` / `active`:

```toml
[agents]
active = ["claude-code", "codex", "opencode"]

codex.skills.remove = ["skill-codex"]
codex.rules.remove  = ["skill-codex"]

gemini.commands.add    = ["cmd-gemini-only"]
gemini.skills.remove   = ["skill-go"]
```

| Syntax                            | Behavior                   |
|:----------------------------------|:---------------------------|
| `<agent>.<section>.active = [...]`| Replace the global list    |
| `<agent>.<section>.add = [...]`   | Append to the global list  |
| `<agent>.<section>.remove = [...]`| Remove from the global list|

Sections: `mcp`, `rules`, `commands`, `subagents`, `skills`.

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
asb subagent -p team --project /path/to/repo  # both
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

### Subagents

Same format as commands, stored in `~/.agent-switchboard/subagents/`.

```bash
asb subagent load claude-code          # import from ~/.claude/agents/
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

## Library Sources

Pull library entries from external directories or git repos:

```bash
asb source add team /path/to/team-library              # local directory
asb source add community https://github.com/org/repo   # git repository
asb source list                                        # list configured sources
asb source remove team                                 # remove
```

The source path must contain at least one of `rules/`, `commands/`, `subagents/`, or `skills/`. Entries from external sources appear with a namespace prefix (e.g. `team:my-rule`) in selectors and config.

## Sync

Push all libraries and MCP config to every active agent in one step:

```bash
asb sync [-p <profile>] [--project <path>]
```

This merges layered config, applies per-agent overrides, and writes target files in place. Files are only rewritten when content changes.

## Environment

| Variable         | Default                    | Purpose                                      |
|:-----------------|:---------------------------|:---------------------------------------------|
| `ASB_HOME`       | `~/.agent-switchboard`     | Library, config, and state directory          |
| `ASB_AGENTS_HOME`| OS user home               | Base path for agent config locations          |

## Development

```bash
pnpm install
pnpm build
pnpm link --global          # global `agent-switchboard` points to local build
```

Code changes take effect after `pnpm build`. To unlink: `pnpm uninstall -g agent-switchboard`.

Other scripts: `pnpm dev` (tsx), `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## License

MIT
