# Claude Code Plugin & Marketplace Format

Reference for the Claude Code plugin system and marketplace distribution format. Sourced from [Plugins Reference](https://code.claude.com/docs/en/plugins-reference) and [Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) (March 2026). Includes notes on how ASB adapts this format.

## Two-Level Hierarchy

```
Marketplace                          Plugin
┌────────────────────────┐           ┌──────────────────────┐
│ .claude-plugin/        │  lists    │ .claude-plugin/      │
│   marketplace.json     ├──────────►│   plugin.json        │
│                        │  N items  │ commands/ agents/    │
│ plugins/               │           │ skills/  hooks/      │
│   plugin-a/            │           │ .mcp.json .lsp.json  │
│   plugin-b/            │           └──────────────────────┘
└────────────────────────┘
```

A **plugin** is a self-contained directory of components (skills, agents, hooks, MCP servers, LSP servers). A **marketplace** is a catalog (`marketplace.json`) that lists multiple plugins and where to fetch them.

Detection rule: directory has `.claude-plugin/marketplace.json` => marketplace; otherwise => plugin.

## Plugin Directory Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest (optional)
├── commands/                # slash-command .md files
├── agents/                  # subagent .md files
├── skills/                  # each subdirectory has SKILL.md
│   └── code-reviewer/
│       ├── SKILL.md
│       └── scripts/
├── hooks/
│   └── hooks.json           # event handler config
├── .mcp.json                # MCP server definitions
├── .lsp.json                # Language Server Protocol configs
├── settings.json            # default plugin settings (agent settings only)
├── scripts/                 # hook / utility scripts
└── LICENSE
```

All component directories live at the plugin root; only `plugin.json` goes inside `.claude-plugin/`. If `plugin.json` is omitted, Claude Code auto-discovers components from default locations and derives the plugin name from the directory name.

## `plugin.json` Schema

Only `name` is required when the manifest is present.

```json
{
  "name": "deployment-tools",
  "version": "2.1.0",
  "description": "Deployment automation tools",
  "author": { "name": "Dev Team", "email": "dev@co.com", "url": "https://..." },
  "homepage": "https://docs.example.com",
  "repository": "https://github.com/user/plugin",
  "license": "MIT",
  "keywords": ["deployment", "ci-cd"],

  "commands":    "./custom/commands/",
  "agents":      ["./agents/reviewer.md", "./agents/tester.md"],
  "skills":      "./custom/skills/",
  "hooks":       "./config/hooks.json",
  "mcpServers":  "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers":  "./.lsp.json"
}
```

### Field Reference

| Category | Field | Type | Notes |
|----------|-------|------|-------|
| Identity | `name` | string | Required. kebab-case, used for namespacing (`plugin:component`) |
| Metadata | `version` | string | SemVer. Determines cache updates; bump to trigger re-install. If both `plugin.json` and marketplace entry specify version, `plugin.json` wins silently |
|          | `description` | string | |
|          | `author` | `{name, email?, url?}` | |
|          | `homepage`, `repository` | string | URLs |
|          | `license` | string | SPDX identifier |
|          | `keywords` | string[] | Discovery tags |
| Components | `commands` | string \| string[] | Additional command files/dirs (supplements `commands/`) |
|            | `agents` | string \| string[] | Additional agent files |
|            | `skills` | string \| string[] | Additional skill dirs |
|            | `hooks` | string \| string[] \| object | Path to hooks config, or inline config |
|            | `mcpServers` | string \| string[] \| object | Path to MCP config, or inline server defs |
|            | `outputStyles` | string \| string[] | Output style files/dirs |
|            | `lspServers` | string \| string[] \| object | LSP config path or inline |

### Path Rules

- All paths relative to plugin root, must start with `./`
- Custom paths **supplement** default directories, not replace them
- Use `${CLAUDE_PLUGIN_ROOT}` for absolute references in hooks, MCP, and scripts (resolved to plugin install location at runtime)
- Path traversal (`../`) is blocked after installation (plugins are copied to `~/.claude/plugins/cache`). Symlinks to external files are followed during copy; use them to include shared dependencies

## `marketplace.json` Schema

Located at `.claude-plugin/marketplace.json` in the marketplace repository root.

```json
{
  "name": "company-tools",
  "owner": { "name": "DevTools Team", "email": "devtools@example.com" },
  "metadata": {
    "description": "Internal dev tools",
    "version": "1.0.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "code-formatter",
      "source": "./plugins/formatter",
      "description": "Auto code formatting",
      "version": "2.1.0"
    },
    {
      "name": "deploy-tools",
      "source": { "source": "github", "repo": "company/deploy-plugin" },
      "strict": false,
      "mcpServers": {
        "deploy-db": {
          "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
          "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"]
        }
      }
    }
  ]
}
```

### Top-Level Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | kebab-case. Visible to users: `plugin@marketplace-name` |
| `owner` | `{name, email?}` | Yes | Marketplace maintainer |
| `metadata.description` | string | No | |
| `metadata.version` | string | No | |
| `metadata.pluginRoot` | string | No | Base dir prepended to relative source paths |
| `plugins` | array | Yes | Plugin entries |

Reserved names: `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`, `life-sciences`, and any names impersonating official Anthropic marketplaces.

### Plugin Entry Fields

Required: `name` + `source`. All other fields from `plugin.json` are also accepted here (description, version, author, commands, agents, hooks, mcpServers, lspServers, etc.), plus marketplace-specific fields:

| Field | Type | Notes |
|-------|------|-------|
| `source` | string \| object | Where to fetch the plugin (see Plugin Sources) |
| `category` | string | Organization category |
| `tags` | string[] | Search tags |
| `strict` | boolean | Controls authority for component definitions (default: `true`) |

## Plugin Sources

The `source` field in each plugin entry tells Claude Code where to fetch the plugin.

| Source | Format | Fields | Notes |
|--------|--------|--------|-------|
| Relative path | `"./plugins/my-plugin"` | -- | Must start with `./`. Only works for git-based marketplaces |
| GitHub | object | `source: "github"`, `repo`, `ref?`, `sha?` | `repo` is `"owner/repo"` |
| Git URL | object | `source: "url"`, `url` (must end `.git`), `ref?`, `sha?` | Any git host |
| Git subdirectory | object | `source: "git-subdir"`, `url`, `path`, `ref?`, `sha?` | Sparse clone for monorepos |
| npm | object | `source: "npm"`, `package`, `version?`, `registry?` | Installed via `npm install` |
| pip | object | `source: "pip"`, `package`, `version?`, `registry?` | Installed via pip |

Examples:

```json
{ "source": "./plugins/formatter" }

{ "source": { "source": "github", "repo": "acme/tool", "ref": "v2.0.0", "sha": "a1b2c3..." } }

{ "source": { "source": "git-subdir", "url": "https://github.com/mono/repo.git", "path": "tools/plugin" } }

{ "source": { "source": "npm", "package": "@acme/claude-plugin", "version": "^2.0.0" } }
```

## Strict Mode

Controls which source is authoritative for component definitions when both `marketplace.json` and `plugin.json` declare components.

| `strict` | Authority | Behavior |
|----------|-----------|----------|
| `true` (default) | `plugin.json` | Marketplace entry supplements with additional components; both merged |
| `false` | Marketplace entry | Marketplace defines everything; `plugin.json` declaring components is a conflict (plugin fails) |

Use `strict: false` when the marketplace operator wants full control over which files are exposed as components. Use `strict: true` (default) when the plugin manages its own components and the marketplace just catalogs it.

## Component Types

| Component | Default Location | File Format |
|-----------|-----------------|-------------|
| Skills | `skills/<name>/SKILL.md` | Directory with SKILL.md + optional supporting files |
| Commands | `commands/*.md` | Markdown (legacy; use skills for new work) |
| Agents | `agents/*.md` | Markdown with YAML frontmatter (`name`, `description`) |
| Hooks | `hooks/hooks.json` | JSON with event matchers and hook actions |
| MCP servers | `.mcp.json` | JSON server definitions |
| LSP servers | `.lsp.json` | JSON with `command`, `extensionToLanguage`, options |
| Settings | `settings.json` | Default settings applied when plugin enabled (agent settings only) |
| Output styles | (custom path) | Style definitions |

### Hook Events

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `TaskCompleted`, `TeammateIdle`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `UserPromptSubmit`, `PermissionRequest`

Hook types: `command` (shell script), `prompt` (LLM evaluation), `agent` (agentic verifier with tools).

ASB distributes this Claude Code hook schema to each target within that target's current support boundary. Codex output is command-only and uses `~/.codex/hooks.json` or `<project>/.codex/hooks.json`. Codex-supported events are `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, and `Stop`; unsupported events and non-`command` hook types are filtered from Codex output and reported in sync results.

## MCP Server Declaration

Three ways to declare MCP servers in a plugin:

**1. `.mcp.json` file at plugin root**

```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data" }
    }
  }
}
```

**2. Inline in `plugin.json`**

```json
{
  "name": "my-plugin",
  "mcpServers": {
    "api-server": { "command": "npx", "args": ["-y", "@co/mcp-server"] }
  }
}
```

**3. File reference in `plugin.json`**

```json
{ "mcpServers": "./mcp-config.json" }
```

MCP servers follow the plugin lifecycle: enabled plugin = servers start; disabled = servers stop.

## LSP Server Declaration

Located at `.lsp.json` in plugin root, or inline in `plugin.json`:

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": { ".go": "go" }
  }
}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `command` | Yes | string | LSP binary (must be in PATH; not bundled) |
| `extensionToLanguage` | Yes | object | Maps file extensions to language IDs |
| `args` | No | string[] | CLI arguments |
| `transport` | No | string | `"stdio"` (default) or `"socket"` |
| `env` | No | object | Environment variables |
| `initializationOptions` | No | object | Passed during server initialization |
| `settings` | No | object | Sent via `workspace/didChangeConfiguration` |
| `workspaceFolder` | No | string | Workspace folder path |
| `startupTimeout` | No | number | Max startup wait (ms) |
| `shutdownTimeout` | No | number | Max graceful shutdown wait (ms) |
| `restartOnCrash` | No | boolean | Auto-restart on crash |
| `maxRestarts` | No | number | Max restart attempts |

## Validation

Validate plugin or marketplace manifests during development:

```bash
claude plugin validate .       # CLI
/plugin validate .             # within Claude Code TUI
```

## Installation & Caching

| Scope | Settings File | Use Case |
|-------|---------------|----------|
| `user` | `~/.claude/settings.json` | Personal, all projects (default) |
| `project` | `.claude/settings.json` | Team-shared via VCS |
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |
| `managed` | Managed settings | Admin-controlled, read-only |

Installed plugins are copied to `~/.claude/plugins/cache`. Version changes in `plugin.json` trigger cache updates.

## Team Distribution

Configure `extraKnownMarketplaces` in `.claude/settings.json` to auto-prompt marketplace installation:

```json
{
  "extraKnownMarketplaces": {
    "company-tools": {
      "source": { "source": "github", "repo": "your-org/claude-plugins" }
    }
  },
  "enabledPlugins": {
    "code-formatter@company-tools": true
  }
}
```

Admins can restrict marketplace sources via `strictKnownMarketplaces` in managed settings (supports exact match, `hostPattern` regex, `pathPattern` regex, or empty array for full lockdown).

## ASB Adaptations

ASB reads and adapts the Claude Code plugin format for cross-agent distribution. Key differences:

| Aspect | Claude Code Native | ASB |
|--------|-------------------|-----|
| Source registration | `/plugin marketplace add` | `[plugins.sources]` in TOML config |
| Source kinds | Claude marketplace or plugin | Claude or Codex marketplace, or standalone plugin |
| Plugin ID | `plugin-name@marketplace-name` | Standalone source: `source`; marketplace entry: `plugin@source` |
| Component ID | `plugin:component` | `source:component` or `plugin@source:component` |
| `.mcp.json` format | `{ "mcpServers": { ... } }` | Wrapped or flat server map |
| Portable lifecycle | Claude Code plugin enable or disable | Global `[plugins]` plus per-application plugin selection |
| Native lifecycle | Claude Code plugin manager | Target `native_plugins` selection for Claude Code or Codex |
| Distribution targets | Claude Code only | All active applications (Cursor, Codex, Gemini, etc.) |
| Name sanitization | N/A | `sanitizeServerKeys()` replaces `[^a-zA-Z0-9_-]` with `-` for Cursor/Codex |
| Hook runtime | Full Claude Code hook schema | Claude Code receives full hook config; Codex receives the command-only subset and requires `/hooks` review |
| `strict` authority | `plugin.json` when `true`; marketplace when `false` | Marketplace entry when `true`; `plugin.json` when `false`, with field-level fallback |

Hook bundle scripts are copied to each target's ASB-owned hook directory: `~/.claude/hooks/asb/<id>/` for Claude Code and `~/.codex/hooks/asb/<id>/` or `<project>/.codex/hooks/asb/<id>/` for Codex. Codex project hooks also require project trust in `~/.codex/config.toml`; ASB reports the trust gap instead of writing trust state.

### ASB Source and Materialization Lifecycle

Each immediate non-dotfile directory under `~/.asb/plugins/` is a first-class ASB source. A source can be a standalone plugin or a marketplace. `[plugins.sources]` registers sources elsewhere on disk or lets ASB manage a remote checkout at `~/.asb/plugins/<source>/`.

Marketplace discovery reads identities and source metadata without fetching external entries. Relative entries resolve within the marketplace checkout. A Git entry that names the same repository and a compatible ref or full SHA reuses that checkout, including its requested subdirectory. Files for another selected Git entry materialize under `ASB_HOME/state/marketplace-plugins/`; this derived state is outside `ASB_HOME/plugins/` and cannot participate in source discovery.

Portable plugin selection and direct component selection are materialization boundaries. Metadata-only inventory and native metadata lookup do not materialize external entries. ASB supports portable materialization for relative entries, GitHub sources, Git URL forms (`url`, `git`, or `github`), and `git-subdir`. Other declared source kinds remain visible as catalog or native metadata but fail with a materialization error if portable expansion requires files ASB cannot acquire.

The derived entry identity includes the configured source, canonical marketplace root, plugin name, Git URL, ref, full 40- or 64-character SHA, and subdirectory. Subdirectory entries use sparse checkout. A refresh writes and verifies a replacement before switching generations; a failed refresh preserves the prior verified entry. Exact SHA entries are immutable and reused. Updating a remote source refreshes only entries already materialized for that source, while source removal cleans only that source's derived entries. `asb sync --dry-run` uses temporary materialization and does not mutate the durable cache or update source checkouts.

### ASB `.mcp.json` Compatibility

Claude Code's official `.mcp.json` wraps servers under `"mcpServers"`:

```json
{ "mcpServers": { "my-server": { "command": "npx", "args": [...] } } }
```

ASB accepts that wrapped form and a flat server map:

```json
{ "my-server": { "command": "npx", "args": [...] } }
```

The wrapped form is portable between Claude Code and ASB. The flat form remains accepted for existing ASB plugins.
