/**
 * Claude Code agent adapter
 * Manages MCP server configuration for Claude Code CLI
 */

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

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
