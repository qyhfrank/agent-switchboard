# Agent Switchboard

Manage MCP servers in one place and apply them to local agents (Codex, Claude Code/Desktop, Gemini) and opencode.

You can run with either `agent-switchboard` or the shorter alias `asb`.

## Installation

Global install:

```bash
npm i -g agent-switchboard
```

Run once without installing:

```bash
npx agent-switchboard@latest mcp
```

## Quick Start

1) Create `~/.agent-switchboard/mcp.json` (if missing).
2) Run the interactive UI:

```bash
agent-switchboard mcp
```

That’s it. The tool updates `~/.agent-switchboard/mcp.json` and writes agent configs.

## Configure Agents

Agent Switchboard only applies MCP servers to the agents you list in `~/.agent-switchboard/config.toml`.

Create the file if it does not exist:

```toml
# ~/.agent-switchboard/config.toml
agents = ["codex", "cursor"]

[rules]
includeDelimiters = false
```

Supported agent IDs:
- `codex` — Codex CLI
- `cursor` — Cursor IDE
- `claude-code` — Claude Code CLI
- `claude-desktop` — Claude Desktop app
- `gemini` — Gemini CLI
- `opencode` — opencode global config

Toggle `rules.includeDelimiters` to `true` if you want each snippet surrounded by markers such as:
```
<!-- your-rule-name:start -->
…
<!-- your-rule-name:end -->
```

Run `agent-switchboard mcp` again after updating the list.

### Layered configuration & scope

Agent Switchboard merges configuration from three TOML layers (higher priority wins):

- **User default**: `<ASB_HOME>/config.toml`
- **Profile**: `<ASB_HOME>/<profile>.toml`
- **Project**: `<project>/.asb.toml`

Every layer can define `[commands]`, `[subagents]`, and `[rules]` `active` lists. Use profiles to share team presets and project files to override per repository. The CLI honors these layers via scope flags:

```bash
# Profile only
agent-switchboard command -p team

# Project only
agent-switchboard rule --project /path/to/repo

# Merge profile + project
agent-switchboard subagent -p team --project /path/to/repo
```

`ASB_HOME` still defaults to `~/.agent-switchboard` but can be overridden through the environment variable.

Project-aware outputs (when using `--project <path>`):
- Rules: Codex writes `<project>/AGENTS.md`. Gemini writes `<project>/AGENTS.md`. OpenCode writes `<project>/AGENTS.md`.
- Commands (project-level supported):
  - Claude Code → `<project>/.claude/commands/`
  - Gemini → `<project>/.gemini/commands/`
  - OpenCode → `<project>/.opencode/command/`
  - Codex → global only (`~/.codex/prompts/`)
- Subagents (project-level supported):
  - Claude Code → `<project>/.claude/agents/`
  - OpenCode → `<project>/.opencode/agent/`

## Rule Library

Rule snippets live in `~/.agent-switchboard/rules/` (respects `ASB_HOME`). Each snippet is a Markdown file and can include YAML frontmatter with `title`, `description`, `tags`, and `requires` fields. Example:

```markdown
---
title: Prompt Hygiene
tags:
  - hygiene
requires:
  - claude-code
---
Keep commit messages scoped to the change.
```

### Selecting and Ordering Rules

Use the interactive selector (arrow keys, `Space` to toggle, just start typing to fuzzy filter) to choose the active snippets and adjust their order:

```bash
agent-switchboard rule [-p <profile>] [--project <path>]
```

The selected order is saved back to the highest-priority layer (project, profile, then user) before distribution. Once confirmed, Agent Switchboard composes the merged Markdown, stores the active order, and writes the document to:
- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md` (or `<project>/AGENTS.md` with `--project`)
- `~/.gemini/AGENTS.md`
- `~/.config/opencode/AGENTS.md` (or `%APPDATA%/opencode/AGENTS.md` on Windows)

Unsupportive agents such as Claude Desktop and Cursor are reported and left untouched. If you rerun the selector without changing the order, the tool refreshes the destination files to overwrite any manual edits.

### Auditing Rules

See the full inventory, activation state, and per-agent sync timestamps:

```bash
agent-switchboard rule list [-p <profile>] [--project <path>]
```

## Command Library

- Location: `~/.agent-switchboard/commands/<slug>.md` (respects `ASB_HOME`).
- Frontmatter: only global `description` (optional). Any platform-native options must live under `extras.<platform>` and are written through verbatim. No parsing, no key renaming, no documentation of platform keys here.

### Import

```bash
# Import an existing platform file or directory into the library
# Use -r/--recursive to traverse subdirectories when <path> is a directory
agent-switchboard command load <platform> [path] [-r]
# <platform>: claude-code | codex | gemini | opencode
# If [path] is omitted, defaults by platform:
#   claude-code → ~/.claude/commands
#   codex       → ~/.codex/prompts
#   gemini      → ~/.gemini/commands
#   opencode    → ~/.config/opencode/command (Windows: %APPDATA%/opencode/command)
```

### Select and Distribute

```bash
agent-switchboard command [-p <profile>] [--project <path>]
```

The selector supports fuzzy filtering—type any part of a title, ID, or model name to narrow the list. Confirming selections saves them back into the highest-priority configuration layer before distribution. Adapters then write each selected command to the corresponding platform output in your user home (platform defaults), using the file format that platform expects. The frontmatter consists of the global `description` (if present) plus `extras.<platform>` written as-is.

Files are only rewritten when content changes.

### Inventory

```bash
# Inventory
agent-switchboard command list [-p <profile>] [--project <path>]
```

## Subagent Library

- Location: `~/.agent-switchboard/subagents/<slug>.md` (respects `ASB_HOME`).
- Frontmatter: only global `description` (optional). Any platform-native options must live under `extras.<platform>` and are written through verbatim. We do not parse, validate, or showcase platform key names in this README. Platforms that do not support subagent files are skipped.

### Import

```bash
agent-switchboard subagent load <platform> [path] [-r]
# <platform>: claude-code | opencode
# If [path] is omitted, defaults by platform:
#   claude-code → ~/.claude/agents
#   opencode    → ~/.config/opencode/agent (Windows: %APPDATA%/opencode/agent)
```

### Select and Distribute

```bash
agent-switchboard subagent [-p <profile>] [--project <path>]
```

Type to fuzzy filter the list, then confirm to persist the selection into the active configuration layer. Adapters write each selected subagent to the corresponding platform output in your user home (platform defaults), using the file format that platform expects. The frontmatter consists of the global `description` (if present) plus `extras.<platform>` written as-is. Platforms that do not accept subagent files are skipped with a hint.

### Inventory

```bash
agent-switchboard subagent list [-p <profile>] [--project <path>]
```

## Sync

After curating your `active` lists in the selectors, run the unified sync command to push rules, commands, and subagents to every supported agent directory:

```bash
agent-switchboard sync [-p <profile>] [--project <path>]
```

The command merges the layered configuration, prints a warning that files will be overwritten without diffs, and rewrites the target files for each platform in place. Use profiles or project scopes to preview changes before applying them globally.

## Environment

- `ASB_HOME`: overrides `~/.agent-switchboard` for library/state files.

## License

MIT
