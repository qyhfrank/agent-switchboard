# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Agent Switchboard (`asb`) is a CLI tool that unifies configuration management across multiple AI coding agents (Claude Code, Codex, Cursor, Gemini, OpenCode, Claude Desktop). It stores all library entries (rules, commands, subagents, skills, MCP servers) in a single agent-agnostic location (`~/.asb/`), then distributes them to each agent in its native format.

## Commands

```bash
pnpm build          # tsc + chmod +x dist/index.js
pnpm dev            # run directly via tsx (no build needed)
pnpm test           # all tests: tsx --test tests/*.test.ts
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome ci . (check only)
pnpm lint:fix       # biome check --write .
pnpm format         # biome format --write .
pnpm release        # validate + bump + commit + tag + push (see below)
```

Run a single test: `tsx --test tests/<filename>.test.ts`

After code changes, `pnpm build` is required before running via `asb` globally. Use `pnpm dev` during development to skip the build step.

## Release Workflow

A pre-commit hook (`.githooks/pre-commit`) auto-formats staged files via `biome check --write --staged`. This prevents unformatted code from reaching CI.

To publish a new version, use `pnpm release [patch|minor|major|<version>]`. The script validates lint/typecheck/test/build locally before bumping, committing, tagging, and pushing. Never create version tags manually.

## Architecture

### Data Flow

```
~/.asb/                    Layered Config              Agent Targets
┌─────────────┐         ┌──────────────────┐        ┌──────────────┐
│ mcp.json    │         │ User  config.toml│        │ ~/.claude/   │
│ rules/      │  load   │ Profile <p>.toml │  dist  │ ~/.codex/    │
│ commands/   ├────────►│ Project .asb.toml├───────►│ ~/.cursor/   │
│ subagents/  │         │                  │        │ ~/.gemini/   │
│ skills/     │         │ Per-agent ovride │        │ ~/.config/   │
└─────────────┘         └──────────────────┘        └──────────────┘
```

### Key Layers

**Agent Adapters** (`src/agents/`): Strategy pattern. Each agent implements `AgentAdapter` (defined in `adapter.ts`) to handle its own config format (JSON, TOML, etc.). `registry.ts` is the factory. Adding a new agent means implementing the interface and registering it.

**Layered Config** (`src/config/`): Three TOML layers (user/profile/project) deep-merge with higher priority winning. All schemas live in `schemas.ts` as Zod definitions; TypeScript types are inferred from them. Per-agent overrides (`add`/`remove`/`active`) are resolved in `agent-config.ts`.

**Library Framework** (`src/library/`): Generic distribution for single-file libraries (commands, subagents) in `distribute.ts` and directory bundles (skills) in `distribute-bundle.ts`. Uses SHA-256 hash comparison to skip unchanged files. Secure file permissions (0o600 files, 0o700 dirs).

**Rules** (`src/rules/`): The most complex library type. Has its own composer (`composer.ts`) that merges ordered rule snippets into a single document, and its own distribution logic (`distribution.ts`) because different agents need different output formats (CLAUDE.md vs AGENTS.md vs individual `.mdc` files for Cursor).

**CLI** (`src/index.ts`): Single entry point defining all commands via Commander.js. ~1500 lines.

### Cross-Cutting Patterns

- `ConfigScope` (`{ profile?, project? }`) threads through the entire call chain from CLI option parsing to file writes.
- Library entries use Markdown + YAML frontmatter. The `extras.<platform>` field carries platform-specific config while keeping the body agent-agnostic.
- State updates use a mutator pattern: `updateState((current) => newState, scope)`.
- `LibrarySection` type and shared helpers (`loadLibraryStateSection`/`updateLibraryStateSection`) generalize commands, subagents, and skills state management.

## Code Conventions

- **ESM**: All imports use `.js` extension suffix (even for `.ts` source files).
- **Biome**: 2-space indent, single quotes, trailing commas (ES5), 100-char line width, `useConst` and `useImportType` enforced.
- **Strict TypeScript**: `noImplicitAny`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`. Target ES2022 with bundler module resolution.
- **Testing**: Node.js built-in `node:test` + `node:assert/strict`. Tests use `withTempHomes()` / `withTempAsbHome()` / `withTempAgentsHome()` from `tests/helpers/tmp.ts` to isolate via temp dirs and env vars (`ASB_HOME`, `ASB_AGENTS_HOME`).
- **Zod schema-first**: Define the Zod schema, infer the TS type. `config/schemas.ts` is the single source of truth for all config types.
