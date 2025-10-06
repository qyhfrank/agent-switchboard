# Agent Switchboard

Manage MCP servers in one place and apply them to local agents (Codex, Claude Code/Desktop, Gemini) and opencode.

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

## Rule Library (v0.1.2)

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

Use the interactive selector to choose the active snippets and adjust their order:

```bash
agent-switchboard rule
```

Once confirmed, Agent Switchboard composes the merged Markdown, stores the active order, and writes the document to:
- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.gemini/AGENTS.md`
- `~/.config/opencode/AGENTS.md` (or `%APPDATA%/opencode/AGENTS.md` on Windows)

Unsupportive agents such as Claude Desktop and Cursor are reported and left untouched. Existing files are backed up to `<name>.bak` before overwriting. If you rerun the selector without changing the order, the tool still refreshes the destination files to overwrite any manual edits.

### Auditing Rules

See the full inventory, activation state, and per-agent sync timestamps:

```bash
agent-switchboard rule list
agent-switchboard rule list --json
```

## License

MIT
