/**
 * Gemini CLI agent adapter
 * Manages MCP server configuration for Gemini CLI
 */

import { getGeminiSettingsPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import {
  type JsonAgentConfig,
  loadJsonFile,
  mergeMcpIntoAgent,
  saveJsonFile,
} from './json-utils.js';

/**
 * Gemini CLI config file structure
 */
// Uses shared JsonAgentConfig

/**
 * Gemini CLI agent adapter
 * Config location: ~/.gemini/settings.json
 */
export class GeminiAgent implements AgentAdapter {
  readonly id = 'gemini' as const;

  configPath(): string {
    return getGeminiSettingsPath();
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
