/**
 * Cursor agent adapter
 * Manages MCP server configuration for Cursor IDE/CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCursorDir, getProjectCursorDir } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import {
  type JsonAgentConfig,
  loadJsonFile,
  mergeMcpIntoAgent,
  saveJsonFile,
} from './json-utils.js';

/**
 * Cursor agent adapter
 * Config location: ~/.cursor/mcp.json
 */
export class CursorAgent implements AgentAdapter {
  readonly id = 'cursor' as const;

  configPath(): string {
    return path.join(getCursorDir(), 'mcp.json');
  }

  /**
   * Project-level config: <project>/.cursor/mcp.json
   */
  projectConfigPath(projectRoot: string): string {
    return path.join(getProjectCursorDir(projectRoot), 'mcp.json');
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
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
