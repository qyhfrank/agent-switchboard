/**
 * MCP configuration loader with JSONC support
 * mcp.json contains server definitions only; enabled state is in config.toml
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { getMcpConfigPath } from './paths.js';
import { type McpConfig, type McpServer, mcpConfigSchema } from './schemas.js';

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
