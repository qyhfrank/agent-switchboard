# Trae IDE Adapter Reference

ByteDance's AI IDE, forked from VS Code. Two variants share identical AI architecture but differ in data paths and extension marketplace.

## Variants

| Field            | Trae (International)                      | Trae CN                                     |
|:-----------------|:------------------------------------------|:---------------------------------------------|
| Agent ID (ASB)   | `trae`                                    | `trae-cn`                                    |
| App bundle       | `Trae.app`                                | `Trae CN.app`                                |
| `dataFolderName` | `.trae`                                   | `.trae-cn`                                   |
| App Support dir  | `~/Library/Application Support/Trae/`     | `~/Library/Application Support/Trae CN/`     |

Both share the same project-level directory name: `.trae/`.

## MCP Configuration

### Format

JSONC (comments + trailing commas allowed). Top-level key: `mcpServers` (camelCase, object-keyed). Identical to VS Code Copilot / Cursor format.

```jsonc
{
  "mcpServers": {
    "server-name": {
      // stdio (command + args are mutually exclusive with url)
      "command": "npx",
      "args": ["-y", "pkg"],
      "cwd": "/optional/path",
      "env": { "KEY": "VALUE" },

      // HTTP/SSE (url is mutually exclusive with command)
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" },

      // common
      "disabled": false         // Trae-specific disable flag
    }
  }
}
```

Transports: stdio, SSE, Streamable HTTP. No explicit `type` field; detected from `command` vs `url` presence.

### Paths

Global MCP config sits alongside `settings.json` in the VS Code-style User data directory (not in `~/.trae/`).

| Scope   | macOS                                                       | Linux                                        | Windows                                       |
|:--------|:------------------------------------------------------------|:---------------------------------------------|:-----------------------------------------------|
| Global  | `~/Library/Application Support/{Trae,Trae CN}/User/mcp.json` | `~/.config/{Trae,Trae CN}/User/mcp.json`   | `%APPDATA%/{Trae,Trae CN}/User/mcp.json`      |
| Project | `<root>/.trae/mcp.json`                                     | same                                         | same                                           |

Project-level MCP is a **Beta feature** (user must enable via Settings > Beta > "Enable Project MCP"). Path is the same for both variants.

### Implementation Notes

- Reuse `json-utils.ts` (`loadJsonFile`, `mergeMcpIntoAgent`, `saveJsonFile`).
- Server name sanitization: same as Cursor (VS Code base).
- `disabled` and `fromGalleryId` fields are Trae-internal; ASB should not write them but must preserve them on merge.

## Rules

### Trae Native Rules (per-file Markdown + YAML frontmatter)

Same model as Cursor's `.mdc` files. Individual `.md` files in a rules directory, each with optional YAML frontmatter.

```yaml
---
alwaysApply: true
description: "When to apply this rule"
globs: "src/**/*.ts"
---

Rule content in Markdown.
```

| Frontmatter   | Type    | Purpose                                         |
|:--------------|:--------|:-------------------------------------------------|
| `alwaysApply` | boolean | Always inject into context                       |
| `description` | string  | AI decides relevance ("Apply Intelligently")     |
| `globs`       | string  | File-pattern activation ("Apply to Specific Files") |

Application modes map to frontmatter combinations:

| Mode                    | Frontmatter                                   |
|:------------------------|:----------------------------------------------|
| Always Apply            | `alwaysApply: true`                           |
| Apply to Specific Files | `alwaysApply: false`, `globs: "*.ts"`         |
| Apply Intelligently     | `alwaysApply: false`, `description: "..."`    |
| Apply Manually          | `alwaysApply: false` (no globs/description)   |

### Rules Paths

| Scope   | Path                                         |
|:--------|:---------------------------------------------|
| Global  | `~/{.trae,.trae-cn}/user_rules/*.md`         |
| Project | `<root>/.trae/rules/*.md`                    |

Legacy single-file: `~/{.trae,.trae-cn}/user_rules.md` (deprecated in favor of directory).

### Third-Party Rules Import

Trae reads several external rule formats, controlled by settings:

| Setting                     | Default | Files read                                          |
|:----------------------------|:--------|:----------------------------------------------------|
| `AI.rules.importAgentsMd`   | `true`  | `AGENTS.md` at workspace root                       |
| `AI.rules.importClaudeMd`   | `false` | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` |
| `chat.useAgentsMdFile`      | -       | `AGENTS.MD` (VS Code Copilot format)                |

Also reads: `.github/instructions/*.instructions.md`, `copilot-instructions.md`, `.github/agents/*.agent.md`.

### ASB Distribution Strategy

Distribute as per-file rules (like Cursor), writing to `.trae/rules/asb-rules.md` with `alwaysApply: true` frontmatter. Map `extras.trae` fields to frontmatter. Falls back to AGENTS.md compatibility (enabled by default).

## Unsupported Features

| ASB Feature | Status      | Reason                                    |
|:------------|:------------|:------------------------------------------|
| Commands    | Unsupported | No custom slash command mechanism          |
| Agents      | Unsupported | GUI-only agent management, no file format |
| Skills      | Unsupported | GUI-only, no file-based distribution      |
| Hooks       | Unsupported | No hook system in Trae                    |

## Sources

- [MCP Docs](https://docs.trae.ai/ide/model-context-protocol), [Add MCP Servers](https://docs.trae.ai/ide/add-mcp-servers)
- [Rules Docs](https://docs.trae.ai/ide/rules-for-ai)
- Source code analysis: `/Applications/Trae CN.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`
- `product.json`: `dataFolderName`, `applicationName` fields
