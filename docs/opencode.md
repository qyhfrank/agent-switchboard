# OpenCode Adapter Reference

[OpenCode](https://opencode.ai) is a terminal-native AI coding agent. Configuration lives under `~/.config/opencode/` (Linux/macOS) or `%APPDATA%/opencode/` (Windows).

## ASB Target: `opencode`

No `isInstalled()` gate -- always distributes when active.

| Section  | Global Path                              | Project Path                  |
|:---------|:-----------------------------------------|:------------------------------|
| MCP      | `~/.config/opencode/opencode.json[c]`   | `<root>/.opencode/opencode.json[c]` |
| Rules    | `~/.config/opencode/AGENTS.md`           | `<root>/AGENTS.md`            |
| Commands | `~/.config/opencode/commands/<id>.md`    | `<root>/.opencode/commands/<id>.md` |
| Agents   | `~/.config/opencode/agents/<id>.md`      | `<root>/.opencode/agents/<id>.md` |
| Skills   | `~/.config/opencode/skills/<id>/`        | `<root>/.opencode/skills/<id>/` |
| Hooks    | N/A                                      | N/A                           |

## MCP Configuration

OpenCode supports JSON and JSONC config files. ASB prefers `.jsonc` if it exists, otherwise `.json`.

```json
{
  "mcp": {
    "server-name": {
      "type": "local",
      "command": ["npx", "-y", "pkg"],
      "environment": { "KEY": "VALUE" },
      "enabled": true
    }
  }
}
```

Key differences from Claude Code / Cursor format:

| Field      | Claude Code / Cursor      | OpenCode                          |
|:-----------|:--------------------------|:----------------------------------|
| Top key    | `mcpServers`              | `mcp`                             |
| Server key | `command` + `args` (separate) | `command` (array, merged)     |
| Env key    | `env`                     | `environment`                     |
| Transport  | `type: "http"` / `"sse"`  | `type: "remote"` + `url`          |
| Disable    | omit from config          | `enabled: false`                  |

## Claude Code Compatibility Layer

OpenCode reads Claude Code's config paths as an undocumented compatibility layer:

| Content | Claude Code Path (also read by OpenCode) | OpenCode Native Path              |
|:--------|:-----------------------------------------|:----------------------------------|
| Rules   | `~/.claude/CLAUDE.md`                    | `~/.config/opencode/AGENTS.md`    |
| Skills  | `~/.claude/skills/`                      | `~/.config/opencode/skills/`      |

Source: [OpenCode issue comment by @zeke](https://gist.github.com/zeke/9927445e67b28cd97a1afa916dbdd444).

### Impact on ASB

When both `claude-code` and `opencode` are in `applications.active`, ASB writes rules and skills to both sets of paths. OpenCode then loads content from **both** its native paths and Claude Code's paths, resulting in duplicate rules and skills.

**Current status: known limitation, no mitigation.**

The duplication is cosmetic (extra context tokens) rather than functional. A dedup mechanism similar to `shouldDedupCursorSkills()` in `src/skills/distribution.ts` could suppress OpenCode-specific writes when `claude-code` is also active, but this depends on OpenCode's undocumented behavior remaining stable. Revisit if OpenCode officially documents the compatibility layer or if users report token-budget issues.

## Sources

- [OpenCode docs](https://opencode.ai/docs)
- [Claude Code compat gist](https://gist.github.com/zeke/9927445e67b28cd97a1afa916dbdd444)
- Source: `src/targets/builtin/opencode.ts`, `src/agents/opencode.ts`
