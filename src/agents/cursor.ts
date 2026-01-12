/**
 * Cursor agent adapter
 * Manages MCP server configuration for Cursor IDE
 */

import fs from 'node:fs';
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
 * Cursor config file structure
 */
// Uses shared JsonAgentConfig

/**
 * Cursor agent adapter
 * Config location: ~/.cursor/mcp.json
 */
export class CursorAgent implements AgentAdapter {
  readonly id = 'cursor' as const;

  configPath(): string {
    const base =
      process.env.ASB_AGENTS_HOME && process.env.ASB_AGENTS_HOME.trim().length > 0
        ? (process.env.ASB_AGENTS_HOME as string)
        : os.homedir();
    return path.join(base, '.cursor', 'mcp.json');
  }

  /**
   * Project-level config: <project>/.cursor/mcp.json
   */
  projectConfigPath(projectRoot: string): string {
    return path.join(path.resolve(projectRoot), '.cursor', 'mcp.json');
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
    // Ensure .cursor directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
