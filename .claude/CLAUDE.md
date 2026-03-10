# Agent Switchboard

This file provides guidance to AI coding agents working on this codebase.

For user-facing documentation (usage, configuration, CLI reference, library types, plugins), see `README.md`.

## Commands

```bash
pnpm build          # tsc + chmod +x dist/index.js
pnpm dev            # run directly via tsx (no build needed)
pnpm test           # all tests: tsx --test tests/*.test.ts
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome ci . (check only)
pnpm lint:fix       # biome check --write .
pnpm format         # biome format --write .
pnpm release        # validate + bump + commit + tag + push
```

Run a single test: `tsx --test tests/<filename>.test.ts`

After code changes, `pnpm build` is required before running via `asb` globally. Use `pnpm dev` or the shell alias `asb-dev` during development to skip the build step. `asb-dev` runs `tsx src/index.ts` from the repo root and accepts the same arguments as `asb`.

A pre-commit hook (`.githooks/pre-commit`) auto-formats staged files via `biome check --write --staged`. It only applies safe fixes; unsafe warnings (e.g., `noNonNullAssertion`) are reported but not auto-fixed. When you see fixable lint warnings in files you are changing, fix them as part of the current change.

To publish a new version, use `pnpm release [patch|minor|major|<version>]`. The script validates lint/typecheck/test/build locally before bumping, committing, tagging, and pushing. Never create version tags manually. See `README.md § Releasing` for the full step sequence.

## Architecture

### Data Flow

```
~/.asb/                    Layered Config              Agent Targets
┌─────────────┐         ┌──────────────────┐        ┌──────────────┐
│ mcp.json    │         │ User  config.toml│        │ ~/.claude/   │
│ rules/      │  load   │ Profile <p>.toml │  dist  │ ~/.codex/    │
│ commands/   ├────────►│ Project .asb.toml├───────►│ ~/.cursor/   │
│ agents/     │         │                  │        │ ~/.gemini/   │
│ skills/     │         │ Per-app override │        │ ~/.config/   │
│ hooks/      │         │                  │        │              │
└─────────────┘         └──────────────────┘        └──────────────┘
                  ▲                          ▲
        Plugins from                 Plugin components
        [plugins] sources            expanded into
        are indexed and              entry-level enabled
        merged here                  arrays at dist time
```

### Key Layers

**Application Targets** (`src/targets/`): The primary distribution abstraction. Each target implements `ApplicationTarget` (defined in `types.ts`) declaring which sections it supports (MCP, rules, commands, agents, skills, hooks) and how to resolve paths, render content, and apply config for each. `src/targets/builtin/` contains all built-in target definitions. `registry.ts` provides `getTargetById()` and `allTargetIds()`. Adding a new distribution target means creating a target definition and registering it.

**Agent Adapters** (`src/agents/`): Low-level config format handlers. Each adapter implements `AgentAdapter` (`adapter.ts`) for MCP config I/O (reading/writing JSON, TOML, etc.) and provides platform-specific path resolution. Adapters are consumed internally by target definitions, not called directly by CLI or distribution logic.

**Layered Config** (`src/config/`): Three TOML layers (user/profile/project) deep-merge with higher priority winning. All schemas live in `schemas.ts` as Zod definitions; TypeScript types are inferred from them. Per-application overrides (`add`/`remove`/`enabled`) are resolved in `application-config.ts`. The config uses `[applications]` for target AI apps and `[agents]` for the agent library type.

**Plugin System** (`src/plugins/`, `src/marketplace/`, `src/library/sources.ts`): Discovers and indexes external component bundles. Sources registered in `[plugins.sources]` (or auto-discovered from `~/.asb/plugins/`) are auto-detected as one of two kinds:

| SourceKind    | Detection                                  | How plugins are found                 |
|:--------------|:-------------------------------------------|:--------------------------------------|
| `marketplace` | `.claude-plugin/marketplace.json` exists   | Each subdirectory is a plugin         |
| `plugin`      | Everything else                            | The source root itself is the plugin  |

A `plugin` source covers both formal plugins (with `.claude-plugin/plugin.json` metadata) and informal directories (just component subdirectories like `rules/`, `commands/`). This distinction is internal only. See "Plugin Design Principles" below for rationale.

`buildPluginIndex()` in `src/plugins/index.ts` scans all sources and produces a `PluginIndex` containing `PluginDescriptor[]`, `PluginMcpServer[]`, and `PluginRuleSnippet[]`. Plugin IDs follow the `pluginRef` format: `plugin` (standalone) or `plugin@source` (from marketplace, for disambiguation). `loadMcpConfigWithPlugins()` in `src/config/mcp-config.ts` merges global and plugin MCP servers, filtering by `plugins.enabled` so that only enabled plugins contribute MCP servers to the available pool.

**Library Framework** (`src/library/`): Generic distribution for single-file libraries (commands, agents) in `distribute.ts` and directory bundles (skills) in `distribute-bundle.ts`. Uses SHA-256 hash comparison to skip unchanged files. Secure file permissions (0o600 files, 0o700 dirs).

**Rules** (`src/rules/`): The most complex library type. Has its own composer (`composer.ts`) that merges ordered rule snippets into a single document, and its own distribution logic (`distribution.ts`) because different agents need different output formats (CLAUDE.md vs AGENTS.md vs single composed `asb-rules.mdc` for Cursor).

**Hooks** (`src/hooks/`): Bundle-based library type. Each hook is a directory (`~/.asb/hooks/<id>/`) containing `hook.json` + script files. Distribution rewrites `${HOOK_DIR}` placeholders to absolute paths and merges into `~/.claude/settings.json`. Only distributes to Claude Code.

**CLI** (`src/index.ts`): Single entry point defining all commands via Commander.js.

### Cross-Cutting Patterns

- `ConfigScope` (`{ profile?, project? }`) threads through the entire call chain from CLI option parsing to file writes.
- Library entries use Markdown + YAML frontmatter. The `extras.<platform>` field carries platform-specific config while keeping the body agent-agnostic.
- State updates use a mutator pattern: `updateState((current) => newState, scope)`.
- `LibrarySection` type (`'commands' | 'agents' | 'skills' | 'hooks'`) and shared helpers (`loadLibraryStateSection`/`updateLibraryStateSection`) generalize state management. Note: `'plugins'` is excluded from `LibrarySection`; plugins have their own config section.
- Entry-level sections use `enabled = [...]` (ordered array) instead of separate `active`/`order` fields. `applications.active` remains `active` since it is a set, not an ordered list.
- `[plugins]` uses the same `enabled = [...]` array pattern as all other sections. `[plugins.sources]` declares explicit source locations; `[plugins.exclude]` provides granular per-section opt-out. Legacy formats (flat boolean map, old `[plugins.sources]` + `[plugins.enabled]` record) are auto-migrated via `z.preprocess`.
- `resolveApplicationSectionConfig(section, appId, scope)` is a **hypothetical query**: it returns the effective config for any `appId` regardless of whether it is in `applications.active`. When using its result to make decisions about actual distribution behavior (e.g., whether to deduplicate), always check `config.applications.active.includes(appId)` first.
- During distribution, `resolveEffectiveSectionConfig()` expands `config.plugins.enabled` (array of plugin refs) into per-section entry IDs via `PluginIndex.expand()`. This applies to all component types including MCP: plugin MCP server IDs are auto-expanded and should not be manually added to `[mcp].enabled` (manual entries persist after plugin disable, causing MCP leakage).

### Plugin Design Principles

These principles emerged from the Context7 plugin adaptation (merging two platform-specific plugins into one ASB plugin) and the `flat`-to-`plugin` collapse refactoring:

**Two-category model, not three.** ASB originally had three source kinds: `marketplace`, `plugin`, `flat`. The `flat` kind was collapsed into `plugin` because a "flat library" (a directory with `rules/`, `commands/` etc.) is functionally a plugin without a manifest. Whether a plugin has `plugin.json` is an internal detail for metadata; it does not affect discovery or distribution.

**One plugin, many platforms.** A plugin should be a single cross-platform unit. Platform-specific differences (e.g., Claude Code agent models, Cursor `alwaysApply` behavior) are expressed via `extras.<platform>` in component frontmatter, not by maintaining separate per-platform plugins. This is what Claude Code's per-platform plugin directories (e.g., `plugins/claude/` vs `plugins/cursor/`) get wrong for ASB's use case.

**Plugin is the atomic unit, including MCP.** A plugin's `.mcp.json` declares MCP servers that follow the plugin lifecycle: enable plugin = MCP available, disable plugin = MCP removed. Global `~/.asb/mcp.json` is for standalone MCP servers not associated with any plugin. `loadMcpConfigWithPlugins()` merges both pools but only includes plugin MCP servers whose parent plugin is enabled in `plugins.enabled`.

**Plugin component references.** Components from plugins appear with a namespace prefix in config and selectors:
- Entry reference: `plugin:bareId` or `plugin@source:bareId`
- Plugin reference: `plugin` or `plugin@source`

## Code Conventions

- **ESM**: All imports use `.js` extension suffix (even for `.ts` source files).
- **Biome**: 2-space indent, single quotes, trailing commas (ES5), 100-char line width, `useConst` and `useImportType` enforced.
- **Strict TypeScript**: `noImplicitAny`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`. Target ES2022 with bundler module resolution.
- **Testing**: Node.js built-in `node:test` + `node:assert/strict`. Tests use `withTempHomes()` / `withTempAsbHome()` / `withTempAgentsHome()` from `tests/helpers/tmp.ts` to isolate via temp dirs and env vars (`ASB_HOME`, `ASB_AGENTS_HOME`).
- **Zod schema-first**: Define the Zod schema, infer the TS type. `config/schemas.ts` is the single source of truth for all config types.
