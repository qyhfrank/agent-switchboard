/**
 * Gemini CLI agent adapter
 * Manages MCP server configuration for Gemini CLI
 */

import path from 'node:path';
import { getGeminiSettingsPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import { applyJsonMcpConfig } from './json-utils.js';

/**
 * Map MCP server config to Gemini format
 * - stdio: {command, args, env} (no type field)
 * - sse: {url} (no type field)
 * - http: {httpUrl} (Gemini uses httpUrl instead of url for HTTP transport)
 */
function mapServerForGemini(server: object): Record<string, unknown> {
  const { type, url, command, args, env, ...rest } = server as Record<string, unknown>;

  if (type === 'http' && typeof url === 'string') {
    return { httpUrl: url, ...rest };
  }
  if ((type === 'sse' || type === undefined) && typeof url === 'string' && !command) {
    return { url, ...rest };
  }
  return { command, args, env, ...rest };
}

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
    applyJsonMcpConfig(this.configPath(), config.mcpServers as Record<string, object>, {
      sanitize: false,
      serverMapper: mapServerForGemini,
    });
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
        sanitize: false,
        serverMapper: mapServerForGemini,
        previouslyOwned: options?.previouslyOwned,
      }
    );
  }
}
