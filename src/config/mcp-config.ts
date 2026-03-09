/**
 * MCP configuration loader with JSONC support
 * mcp.json contains server definitions only; enabled state is in config.toml
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { buildPluginIndex } from '../plugins/index.js';
import { getMcpConfigPath } from './paths.js';
import { type McpConfig, type McpServer, mcpConfigSchema } from './schemas.js';
import { type ConfigScope, scopeToLayerOptions } from './scope.js';
import { loadSwitchboardConfig } from './switchboard-config.js';

/**
 * Loads the MCP configuration from ~/.agent-switchboard/mcp.json
 * Parses JSONC (JSON with comments) format
 * Returns default empty config if file doesn't exist
 *
 * @returns {McpConfig} Parsed and validated MCP configuration (server definitions only)
 * @throws {Error} If file exists but contains invalid JSON or fails schema validation
 */
export function loadMcpConfig(): McpConfig {
  const configPath = getMcpConfigPath();

  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = parse(content);
    const validated = mcpConfigSchema.parse(parsed);

    // Infer type for servers that don't have it set
    if (parsed.mcpServers) {
      for (const [name, serverData] of Object.entries(parsed.mcpServers)) {
        const raw = serverData as Partial<McpServer> & Record<string, unknown>;
        const target = validated.mcpServers[name];

        if (typeof raw.type === 'undefined' && target) {
          if (typeof raw.url === 'string' && raw.url.length > 0) {
            target.type = 'http';
          } else if (typeof raw.command === 'string' && raw.command.length > 0) {
            target.type = 'stdio';
          }
        }
      }
    }

    return validated;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load MCP config from ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Loads MCP server definitions from both ~/.asb/mcp.json and enabled plugins.
 * Only includes plugin MCP servers whose parent plugin is enabled in `plugins.enabled`.
 * Plugin-sourced servers use namespaced IDs (e.g. "context7:context7").
 * If a plugin server ID collides with a user-defined server, the user definition wins.
 */
export function loadMcpConfigWithPlugins(scope?: ConfigScope): McpConfig {
  const base = loadMcpConfig();
  const pluginIndex = buildPluginIndex();

  if (pluginIndex.mcpServers.length === 0) return base;

  const config = loadSwitchboardConfig(scopeToLayerOptions(scope));
  const enabledPlugins = new Set(config.plugins.enabled);

  const merged = { ...base.mcpServers };
  for (const ps of pluginIndex.mcpServers) {
    if (!(ps.serverId in merged) && enabledPlugins.has(ps.pluginId)) {
      merged[ps.serverId] = ps.server;
    }
  }

  return { mcpServers: merged };
}

/**
 * Removes legacy `enabled` fields from ~/.agent-switchboard/mcp.json (definition-only file).
 * Returns true if the file was changed.
 */
export function stripLegacyEnabledFlagsFromMcpJson(): boolean {
  const configPath = getMcpConfigPath();

  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = parse(content);
    const validated = mcpConfigSchema.parse(parsed);

    let changed = false;
    for (const server of Object.values(validated.mcpServers)) {
      const record = server as Record<string, unknown>;
      if ('enabled' in record) {
        delete record.enabled;
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(validated, null, 4)}\n`, 'utf-8');
    return true;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to strip legacy enabled flags from MCP config ${configPath}: ${error.message}`
      );
    }
    throw error;
  }
}
