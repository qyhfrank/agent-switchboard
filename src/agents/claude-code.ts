/**
 * Claude Code agent adapter
 * Manages MCP server configuration for Claude Code CLI
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import { getClaudeJsonPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';

import {
  type JsonAgentConfig,
  loadJsonFile,
  mergeMcpIntoAgent,
  saveJsonFile,
} from './json-utils.js';

/**
 * Claude Code agent adapter
 * Config location: ~/.claude.json
 */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly id = 'claude-code' as const;

  configPath(): string {
    return getClaudeJsonPath();
  }

  /**
   * Project-level config: <project>/.mcp.json
   * Note: .claude/.mcp.json is NOT supported by Claude Code (known bug)
   */
  projectConfigPath(projectRoot: string): string {
    return nodePath.join(nodePath.resolve(projectRoot), '.mcp.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    const configPath = this.projectConfigPath(projectRoot);
    // For project-level .mcp.json, only write mcpServers (no merge with existing non-mcp fields)
    const existing = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(existing, config.mcpServers as Record<string, object>);
    // Ensure parent directory exists
    const dir = nodePath.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
