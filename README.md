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

| Feature          | Claude Code | Codex | Cursor | Gemini | OpenCode | Trae | Claude Desktop |
|:-----------------|:-----------:|:-----:|:------:|:------:|:--------:|:----:|:--------------:|
| MCP servers      | ✓           | ✓     | ✓      | ✓      | ✓        | ✓    | ✓              |
| Project-level MCP| ✓           | ✓     | ✓      | ✓      | ✓        | ✓    |                |
| Rules            | ✓           | ✓     | ✓ mdc  | ✓      | ✓        | ✓    |                |
| Commands         | ✓           | ✓\*   | ✓      | ✓      | ✓        |      |                |
| Agents           | ✓           | ✓     | ✓      |        | ✓        |      |                |
| Skills           | ✓           | ✓     | ✓      | ✓      | ✓        | ✓    |                |
| Hooks            | ✓           | ✓†    |        |        |          |      |                |

\* Codex commands use deprecated `~/.codex/prompts/`; prefer skills instead.
† ASB currently distributes Codex hooks as command handlers. It writes `~/.codex/hooks.json` or `<project>/.codex/hooks.json`, filters unsupported hook entries, and reports config, trust, and review prerequisites. Trae column applies to both `trae` and `trae-cn` variants.

Cursor rules are composed into a single `asb-rules.mdc` file at `~/.cursor/rules/` with `alwaysApply: true`.

## Quick Start

```bash
npm i -g agent-switchboard    # or: npx agent-switchboard@latest mcp
```

1. **Pick your agents** -- create `~/.asb/config.toml`:

```toml
[applications]
enabled = ["claude-code", "codex", "cursor"]
```

2. **Manage MCP servers** -- launches an interactive checkbox UI:

```bash
asb mcp
```

3. **Add a plugin source** (optional) -- pull components from a local directory, git repo, or Claude Code marketplace:

```bash
asb plugin marketplace add /path/to/my-plugin
asb plugin marketplace add https://github.com/org/marketplace-repo
```

4. **Sync everything** -- pushes all libraries (rules, commands, agents, skills, hooks) and MCP config to every active application:

```bash
asb sync
```

Preview without writing:

```bash
asb sync --dry-run
```

Library content lives under `~/.asb/` and agent configs are updated in place.

## Command Reference

| Command                         | Description                                          |
|:--------------------------------|:-----------------------------------------------------|
| `asb mcp`                       | Interactive MCP server selector                      |
| `asb rule`                      | Interactive rule snippet selector with ordering      |
| `asb command`                   | Interactive command selector                         |
| `asb agent`                     | Interactive agent selector                           |
| `asb skill`                     | Interactive skill selector                           |
| `asb hook`                      | Interactive hook selector (Claude Code and Codex)    |
| `asb sync`                      | Push all libraries + MCP to applications (no UI)     |
| `asb <lib> load`                | Import files from a platform into the library        |
| `asb <lib> list`                | Show inventory, enabled state, and sync timestamps   |
| `asb plugin list`               | List all discovered plugins and their states         |
| `asb plugin info <ref>`         | Show catalog metadata and resolved components        |
| `asb plugin enable <ref>`       | Enable a plugin                                      |
| `asb plugin disable <ref>`      | Remove a plugin from the enabled list                |
| `asb plugin uninstall <ref>`    | Alias for `disable`                                  |
| `asb plugin marketplace add`    | Add a plugin source (local path or git URL)          |
| `asb plugin marketplace remove` | Remove a plugin source                               |
| `asb plugin marketplace update` | Update remote sources and materialized entries       |
| `asb plugin marketplace list`   | List configured plugin sources                       |

`<lib>` = `rule`, `command`, `agent`, `skill`, or `hook`. `<ref>` = `plugin` or `plugin@source`.

**Shared flags**: `-p, --profile <name>`, `-P, --project <path>`, `--json` (on `list` commands).

## Configuration

### `config.toml`

The central config file at `~/.asb/config.toml` controls target applications, entry-level selections, and plugin sources:

```toml
[applications]
enabled = ["claude-code", "codex", "cursor"]

[rules]
enabled = ["prompt-hygiene", "code-style"]
includeDelimiters = false

[commands]
enabled = ["docs", "deploy"]

[plugins]
enabled = ["context7", "plugin-a@team-lib"]

[plugins.sources]
team-lib = "https://github.com/org/team-library"
```

Supported application IDs: `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini`, `opencode`, `trae`, `trae-cn`.

agent-switchboard detects whether each application is installed by checking for its data directory (e.g. `~/.claude/`, `~/.cursor/`). Uninstalled applications in `enabled` are skipped during sync. To force distribution to an application whose directory does not exist yet, add it to `assume_installed`:

```toml
[applications]
enabled = ["claude-code", "codex"]
assume_installed = ["codex"]    # distribute even if ~/.codex/ is missing
```

All entry-level sections (`rules`, `commands`, `agents`, `skills`, `hooks`, `plugins`) use `enabled = [...]` where array order defines composition priority. `[plugins].enabled` accepts `plugin` or `plugin@source`. Component sections accept `plugin:bareId` or `plugin@source:bareId`.

The `[plugins.sources]` sub-table declares explicit plugin locations. Local plugins in `~/.asb/plugins/` are auto-discovered without configuration.

Native plugins use the target application's plugin lifecycle instead of generic ASB component expansion. Keep the plugin or marketplace in `[plugins.sources]` or `~/.asb/plugins/`, then enable it only under the target's `native_plugins` section:

```toml
[applications]
enabled = ["claude-code", "codex"]

[plugins.sources.openai-codex]
url = "https://github.com/openai/codex-plugin-cc.git"
type = "clone"

[applications.claude-code.native_plugins]
enabled = ["codex@openai-codex"]
scope = "user"
```

Codex native plugins can be a Codex marketplace (`.agents/plugins/marketplace.json`) or a bare plugin (`.codex-plugin/plugin.json`). Bare plugins are wrapped into an ASB-owned local marketplace during sync because the Codex CLI installs plugins through marketplace refs:

```toml
[applications]
enabled = ["codex"]

[plugins.sources]
cowart = "/path/to/cowart"

[applications.codex.native_plugins]
enabled = ["cowart"]
scope = "user"
```

Keep a native plugin out of the same target's effective portable plugin selection. Portable selection includes `[plugins].enabled` plus `[applications.<app>.plugins]` overrides.

When a remote source is written directly into `config.toml`, run `asb sync --update` once so the checkout exists under `~/.asb/plugins/`. If the marketplace is already present at `~/.asb/plugins/openai-codex`, the `[plugins.sources.openai-codex]` table is optional.

### Per-Application Overrides

Fine-tune which library entries reach each application using `add` / `remove` / `enabled`:

```toml
[applications]
enabled = ["claude-code", "codex", "opencode"]

[plugins]
enabled = ["shared-tools@team-lib"]

[applications.codex.plugins]
add = ["codex-tools@team-lib"]

[applications.opencode.plugins]
remove = ["shared-tools@team-lib"]

[applications.codex.skills]
remove = ["codex-tools@team-lib:legacy-skill"]

[applications.opencode.commands]
add = ["cmd-opencode-only"]
```

| Syntax                            | Behavior                   |
|:----------------------------------|:---------------------------|
| `<app>.<section>.enabled = [...]` | Replace the global list    |
| `<app>.<section>.add = [...]`     | Append to the global list  |
| `<app>.<section>.remove = [...]`  | Remove from the global list|

Portable plugin selection is resolved in this order:

1. Start with `[plugins].enabled`.
2. Apply `[applications.<app>.plugins]`; `enabled` replaces the global list, otherwise `remove` and `add` adjust it.
3. Expand the selected plugins and apply `[plugins.exclude]` to plugin-derived components.
4. Apply the application's component-level overrides. An explicitly enabled component remains selected even when the same ID appears in `[plugins.exclude]`.

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

Interactive selectors follow the writable layer you target:

- User scope shows and edits the merged user selection.
- `-p/--profile` shows only that profile layer's explicit selection.
- `-P/--project` shows only that project layer's explicit selection.

Inherited entries from higher-priority layers do not participate in scoped sync until you write them into that profile or project layer. Saving an empty scoped selection creates an explicit empty override for that layer.

### Project Distribution Modes

Project-scoped sync supports three modes under `[distribution.project]`:

```toml
[distribution.project]
mode = "managed"          # or: "exclusive", "none"
collision = "warn-skip"   # managed only: "warn-skip", "error", "takeover"

[distribution.project.rules]
placement = "prepend"     # or: "append"
```

| Mode        | Behavior |
|:------------|:---------|
| `exclusive` | ASB writes project-scoped outputs directly and cleans up inactive entries in target directories. |
| `managed`   | Default. Uses a manifest at `<project>/.asb/state/distribution.json` so cleanup only removes files and directories previously written by ASB. Shared rule files use block merge instead of full replacement. |
| `none`      | Disables all project-scoped writes. Selections can still be edited in `.asb.toml`, but project distribution commands and `asb sync -P <project>` skip output generation. |

Managed-mode collision policy controls what happens when ASB encounters a foreign file or directory at a target path:

| Policy      | Behavior |
|:------------|:---------|
| `warn-skip` | Report a conflict and leave the foreign path untouched. |
| `error`     | Report a hard error and fail the affected distribution step. |
| `takeover`  | Treat the path as ASB-managed and overwrite it. |

## Libraries

All library types follow the same pattern:

1. **Store** entries in `~/.asb/<type>/` as Markdown files (or directories for skills).
2. **Import** existing platform files: `asb <type> load <platform> [path] [-r]`.
3. **Select** active entries: `asb <type>` (interactive fuzzy-search selector).
4. **Audit** inventory: `asb <type> list [--json]`.

Selections are saved into the highest-priority config layer. Distribution writes each entry in the format the target agent expects, skipping unchanged files (hash-based).

### Rules

Snippets in `~/.asb/rules/` with optional YAML frontmatter:

```markdown
---
title: Prompt Hygiene
tags: [hygiene]
requires: [claude-code]
---
Keep commit messages scoped to the change.
```

Platform-specific options live in `extras.<platform>`:

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

The interactive selector lets you **reorder** snippets. For most agents, rules are composed into a single document. For Cursor, rules are merged into a single `asb-rules.mdc` with native frontmatter:

| Agent       | Global output                              | Project output                               |
|:------------|:-------------------------------------------|:---------------------------------------------|
| Claude Code | `~/.claude/CLAUDE.md`                      | `<project>/.claude/CLAUDE.md`                |
| Codex       | `~/.codex/AGENTS.md`                       | `<project>/AGENTS.md`                        |
| Cursor      | `~/.cursor/rules/asb-rules.mdc`            | `<project>/.cursor/rules/asb-rules.mdc`      |
| Gemini      | `~/.gemini/AGENTS.md`                      | `<project>/.gemini/AGENTS.md`                |
| OpenCode    | `~/.config/opencode/AGENTS.md`             | `<project>/AGENTS.md`                        |
| Trae        | `~/.trae/user_rules/asb-rules.md`          | `<project>/.trae/rules/asb-rules.md`         |
| Trae-CN     | `~/.trae-cn/user_rules/asb-rules.md`       | `<project>/.trae/rules/asb-rules.md`         |

### Commands

Markdown files in `~/.asb/commands/` with optional `description` and `extras.<platform>`:

```bash
asb command load claude-code           # import from ~/.claude/commands/
asb command load gemini [path] -r      # import recursively
```

Platforms: `claude-code`, `codex`, `cursor`, `gemini`, `opencode`.

### Agents

Same format as commands, stored in `~/.asb/agents/`.

```bash
asb agent load claude-code             # import from ~/.claude/agents/
```

Platforms: `claude-code`, `codex`, `cursor`, `opencode`.

### Skills

Multi-file directory bundles in `~/.asb/skills/<skill-id>/`, each containing a `SKILL.md` entry file:

```
~/.asb/skills/my-skill/
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

JSON-based hook definitions distributed to Claude Code's `settings.json` and Codex's `hooks.json`. Two storage formats:

- **Single file**: `~/.asb/hooks/<id>.json`
- **Bundle**: `~/.asb/hooks/<id>/hook.json` plus script files

```bash
asb hook load claude-code              # import from ~/.claude/settings.json
asb hook load /path/to/hook.json       # import a JSON file
asb hook load /path/to/hook-dir/       # import a bundle directory
```

Bundle scripts are copied to the target agent's ASB hook bundle directory and the `${HOOK_DIR}` placeholder in commands is resolved to the absolute path at distribution time:

- Claude Code: `~/.claude/hooks/asb/<id>/`
- Codex: `~/.codex/hooks/asb/<id>/` or `<project>/.codex/hooks/asb/<id>/`

Codex hook sync writes `~/.codex/hooks.json` for global scope or `<project>/.codex/hooks.json` for project scope. ASB emits command handlers for `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, and `Stop`; unsupported events and non-command handler types are filtered from Codex output and reported in sync results. Codex uses `[features].hooks` in `~/.codex/config.toml` (enabled by default when absent; legacy `[features].codex_hooks` is accepted for compatibility). Project-scoped hooks require the project to be trusted, and new or changed Codex hooks must be reviewed from `/hooks` in Codex before they run.

## Plugins

A plugin bundles related capabilities (rules, commands, agents, skills, hooks, MCP servers) into a single directory that can be enabled or disabled as a unit. Instead of managing dozens of individual files in `~/.asb/`, you point agent-switchboard at a plugin and get all its components at once.

### Plugin Structure

A plugin is a directory with component subdirectories and an optional manifest:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json       # optional Claude metadata
├── .codex-plugin/
│   └── plugin.json       # optional Codex native metadata
├── rules/                # rule .md files
├── commands/             # command .md files
├── agents/               # agent .md files
├── skills/               # skill subdirectories (each with SKILL.md)
├── hooks/                # hook .json files or bundles
└── .mcp.json             # MCP server definitions
```

No manifest is required. A bare directory with just `rules/` and `skills/` subdirectories works as an informal plugin. Adding `.claude-plugin/plugin.json` provides Claude metadata. Adding `.codex-plugin/plugin.json` makes the directory selectable as a Codex native plugin. The Claude format is compatible with Claude Code's plugin system (see `docs/claude-marketplace-format.md` for the full spec).

### Sources

Plugin sources are declared in `[plugins.sources]`:

```toml
[plugins.sources]
my-plugin = "/path/to/my-plugin"
team-lib = "https://github.com/org/team-library"
mono-sub = "https://github.com/org/monorepo/tree/main/plugins/my-plugin"
```

Every immediate non-dotfile directory under `~/.asb/plugins/` is a first-class source whose namespace is its directory name. You can copy or clone a plugin directly into that directory and enable it selectively without a `[plugins.sources]` entry:

```bash
git clone https://github.com/org/team-library ~/.asb/plugins/team-lib
asb plugin list
asb plugin enable team-lib
```

A standalone plugin uses the source namespace (`team-lib`). A marketplace entry uses `plugin-a@team-lib`. Bare marketplace names are accepted only when they identify one plugin unambiguously.

Use dotfile directory names for internal data under `~/.asb/plugins/`; discovery ignores them.

agent-switchboard auto-detects two source kinds:

| Kind          | Detection                                                                                       | Structure                                      |
|:--------------|:------------------------------------------------------------------------------------------------|:-----------------------------------------------|
| `marketplace` | Contains `.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`                 | Multiple plugins, each in its own subdirectory |
| `plugin`      | Everything else, including formal `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`    | Single plugin                                  |

Source storage, marketplace inventory, and external entry materialization have separate owners:

| Layer | Meaning | Storage |
|:------|:--------|:--------|
| Source | A user-managed or ASB-managed plugin or marketplace checkout | `~/.asb/plugins/<source>/` or a configured local path |
| Catalog | Plugin identities and source metadata read from a marketplace manifest | In memory; discovery does not fetch external entries |
| Materialized entry | Files needed by a selected portable plugin or component whose Git source is outside the marketplace checkout | `ASB_HOME/state/marketplace-plugins/` |

A relative marketplace entry resolves inside its source checkout. A `git-subdir` entry that points to the same repository and compatible pin also reuses that checkout. Other selected Git entries use the state-owned materialization cache. The cache is derived runtime state, not a plugin source and not an enablement surface, so it cannot create duplicate plugin identities through auto-discovery.

`asb plugin list` reads catalog metadata without fetching external entries. ASB materializes an external entry when portable plugin expansion or a directly selected component requires its files. A short `ref` selects a same-named branch before a tag; a fully qualified ref is used exactly. Full commit SHA pins are reused as immutable entries, and subdirectory sources use sparse checkout. Refresh replaces a verified entry atomically so a failed fetch leaves the previous materialization usable.

Git credentials supplied in a source URL are used for transport only. ASB removes URL user info, query parameters, and fragments from persisted source and cache metadata and from Git errors.

In `asb plugin list --json`, `componentsResolved: false` means an external entry remains metadata-only for that inventory command; its zero component counts are not a declaration that the plugin contains no components.

### CLI

```bash
asb plugin marketplace add /path/to/my-plugin            # register source
asb plugin marketplace add https://github.com/org/repo   # git source
asb plugin marketplace update [source]                    # update source and materialized entries
asb plugin marketplace list                               # list sources
asb plugin marketplace remove my-plugin                   # remove source

asb plugin enable context7            # activate (all components enter distribution)
asb plugin disable context7           # remove from the enabled list
asb plugin uninstall context7         # alias for disable
asb plugin list                       # show all discovered plugins
asb plugin info context7              # show metadata + currently resolved components
```

Discovered plugin MCP servers appear in the MCP picker alongside locally-defined servers and can be enabled per user, profile, or project scope.

During `asb sync`, each application receives the components from its effective portable plugin selection. Components use a namespace prefix such as `context7:docs-researcher` or `plugin-a@team-lib:docs-researcher`, and component-level application overrides run after plugin expansion.

Plugin MCP servers are also addressable directly through `[mcp].enabled` and the `asb mcp` selector. As long as the plugin source is discoverable, a plugin MCP server can be enabled directly without adding its parent plugin to `[plugins].enabled`.

`asb plugin marketplace update [source]` refreshes remote source checkouts and only the external entries already present in the derived cache. Removing a configured source removes only that source's derived entries. `asb sync --update` performs the same refresh before sync. `asb sync --dry-run` skips durable source updates and uses a temporary entry cache for any materialization needed to calculate the preview.

### Native Plugins

Target-native plugins stay inside the owning application's plugin lifecycle instead of being expanded into portable ASB components.

```toml
[applications]
enabled = ["claude-code", "codex"]

[plugins.sources.openai-codex]
url = "https://github.com/openai/codex-plugin-cc.git"
type = "clone"

[applications.claude-code.native_plugins]
enabled = ["codex@openai-codex"]
scope = "user"
```

```toml
[applications]
enabled = ["codex"]

[plugins.sources]
cowart = "/path/to/cowart"

[applications.codex.native_plugins]
enabled = ["cowart"]
scope = "user"
```

`asb sync --dry-run` reports the planned native plugin action. A real `asb sync` validates Claude marketplaces before installing them through Claude Code. For Codex, ASB registers the marketplace with the Codex CLI and installs the plugin ref; bare `.codex-plugin` directories are first wrapped in `ASB_HOME/state/native-plugins/codex/`. A native plugin is rejected when the same plugin is present in that target's effective portable plugin selection.

## Sync

Push all libraries and MCP config to every active application in one step:

```bash
asb sync [-p <profile>] [-P <path>]
```

This merges layered config, applies per-application overrides, and writes target files in place. Files are only rewritten when content changes.

For project scope, sync honors `[distribution.project].mode`:

- `managed` keeps a manifest and cleans up only ASB-owned project outputs
- `exclusive` writes directly to the project targets
- `none` skips project writes entirely

## Environment

| Variable         | Default                    | Purpose                                      |
|:-----------------|:---------------------------|:---------------------------------------------|
| `ASB_HOME`       | `~/.asb`                   | Library, config, and state directory          |
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
