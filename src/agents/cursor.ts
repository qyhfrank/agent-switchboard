/**
 * Cursor agent adapter
 * Manages MCP server configuration for Cursor IDE/CLI
 */

import path from 'node:path';
import { getCursorDir, getProjectCursorDir } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import { applyJsonMcpConfig } from './json-utils.js';

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
    applyJsonMcpConfig(this.configPath(), config.mcpServers as Record<string, object>);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> },
    options?: { previouslyOwned?: ReadonlySet<string> }
  ): void {
    applyJsonMcpConfig(
      this.projectConfigPath(projectRoot),
      config.mcpServers as Record<string, object>,
      {
        previouslyOwned: options?.previouslyOwned,
      }
    );
  }
}
