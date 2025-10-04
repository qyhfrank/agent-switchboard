# Agent Switchboard

Manage MCP servers in one place and apply them to local agents (e.g., Codex, Cursor).

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
# or
asb mcp
```

That’s it. The tool updates `~/.agent-switchboard/mcp.json` and writes agent configs.

## Configure Agents

Agent Switchboard only applies MCP servers to the agents you list in `~/.agent-switchboard/config.toml`.

Create the file if it does not exist:

```toml
# ~/.agent-switchboard/config.toml
agents = ["codex", "cursor"]
```

Supported agent IDs:
- `codex` — Codex CLI
- `cursor` — Cursor IDE
- `claude-code` — Claude Code CLI
- `claude-desktop` — Claude Desktop app
- `gemini` — Gemini CLI

Run `agent-switchboard mcp` again after updating the list.

## License

MIT
