/**
 * Claude Desktop agent adapter
 * Manages MCP server configuration for Claude Desktop app
 */

import { getClaudeDesktopConfigPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import {
  type JsonAgentConfig,
  loadJsonFile,
  mergeMcpIntoAgent,
  saveJsonFile,
} from './json-utils.js';

/**
 * Claude Desktop config file structure
 */
// Uses shared JsonAgentConfig

/**
 * Claude Desktop agent adapter
 * Config location (platform-specific):
 * - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Linux: ~/.config/Claude/claude_desktop_config.json
 * - Windows: %APPDATA%\Claude\claude_desktop_config.json
 */
export class ClaudeDesktopAgent implements AgentAdapter {
  readonly id = 'claude-desktop' as const;

  configPath(): string {
    return getClaudeDesktopConfigPath();
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
