/**
 * Gemini CLI agent adapter
 * Manages MCP server configuration for Gemini CLI
 */

import os from 'node:os';
import path from 'node:path';
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
    const base =
      process.env.ASB_AGENTS_HOME && process.env.ASB_AGENTS_HOME.trim().length > 0
        ? (process.env.ASB_AGENTS_HOME as string)
        : os.homedir();
    return path.join(base, '.gemini', 'settings.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
