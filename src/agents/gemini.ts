/**
 * Gemini CLI agent adapter
 * Manages MCP server configuration for Gemini CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import { getGeminiSettingsPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';
import { type JsonAgentConfig, loadJsonFile, saveJsonFile } from './json-utils.js';

/**
 * Map MCP server config to Gemini format
 * - stdio: {command, args, env} (no type field)
 * - sse: {url} (no type field)
 * - http: {httpUrl} (Gemini uses httpUrl instead of url for HTTP transport)
 */
function mapServerForGemini(server: Omit<McpServer, 'enabled'>): Record<string, unknown> {
  const { type, url, command, args, env, ...rest } = server as Record<string, unknown>;

  if (type === 'http' && typeof url === 'string') {
    // HTTP transport uses httpUrl field in Gemini
    return { httpUrl: url, ...rest };
  }
  if ((type === 'sse' || type === undefined) && typeof url === 'string' && !command) {
    // SSE transport (or inferred remote) uses url field
    return { url, ...rest };
  }
  // stdio transport
  return { command, args, env, ...rest };
}

/**
 * Merge MCP servers into Gemini config with proper field mapping
 */
function mergeMcpForGemini(
  agentConfig: JsonAgentConfig,
  mcpServers: Record<string, Omit<McpServer, 'enabled'>>
): JsonAgentConfig {
  const merged: JsonAgentConfig = { ...agentConfig };
  merged.mcpServers = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    const existing = (agentConfig.mcpServers?.[name] as Record<string, unknown>) ?? {};
    const mapped = mapServerForGemini(server);
    merged.mcpServers[name] = { ...existing, ...mapped };
  }

  return merged;
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
    const configPath = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const merged = mergeMcpForGemini(agentConfig, config.mcpServers);
    saveJsonFile(configPath, merged);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    const configPath = this.projectConfigPath(projectRoot);
    const existing = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
    const merged = mergeMcpForGemini(existing, config.mcpServers);
    // Ensure .gemini directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    saveJsonFile(configPath, merged);
  }
}
