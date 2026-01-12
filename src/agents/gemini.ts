/**
 * Gemini CLI agent adapter
 * Manages MCP server configuration for Gemini CLI
 */

import fs from 'node:fs';
import path from 'node:path';
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

  /**
   * Project-level config: <project>/.gemini/settings.json
   */
  projectConfigPath(projectRoot: string): string {
    return path.join(path.resolve(projectRoot), '.gemini', 'settings.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const configPath = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(configPath, merged);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    const configPath = this.projectConfigPath(projectRoot);
    const existing = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(existing, config.mcpServers as Record<string, object>);
    // Ensure .gemini directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
