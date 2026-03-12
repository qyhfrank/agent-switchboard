/**
 * Shared JSON file helpers for agent adapters
 */

import fs from 'node:fs';
import path from 'node:path';

export type JsonAgentConfig = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

export function loadJsonFile<T extends object>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export function saveJsonFile(filePath: string, data: object): void {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(filePath, json, 'utf-8');
}

/**
 * Replace characters not in `[a-zA-Z0-9_-]` with `-`.
 * Cursor and Codex reject MCP server names outside this character set.
 */
export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Sanitize all keys in a server record via {@link sanitizeMcpName}.
 * Warns on collision (e.g. `foo:bar` and `foo-bar` both map to `foo-bar`).
 */
export function sanitizeServerKeys<T>(servers: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  const seen = new Map<string, string>();
  for (const [name, server] of Object.entries(servers)) {
    const key = sanitizeMcpName(name);
    const prev = seen.get(key);
    if (prev !== undefined && prev !== name) {
      throw new Error(
        `MCP name collision: "${prev}" and "${name}" both sanitize to "${key}". Rename one of the servers to avoid data loss.`
      );
    }
    seen.set(key, name);
    result[key] = server;
  }
  return result;
}

/**
 * Common apply flow for JSON-based agent adapters.
 * Handles: load -> sanitize -> merge (exclusive or managed) -> mkdir -> save.
 *
 * @param serverMapper Optional per-server transform (e.g., Gemini httpUrl mapping).
 *   When omitted, servers are passed through as-is.
 */
export function applyJsonMcpConfig(
  configPath: string,
  mcpServers: Record<string, object>,
  options?: {
    previouslyOwned?: ReadonlySet<string>;
    serverMapper?: (server: object) => Record<string, unknown>;
    sanitize?: boolean;
  }
): void {
  const existing = loadJsonFile<JsonAgentConfig>(configPath, { mcpServers: {} });
  const sanitize = options?.sanitize !== false;
  const servers = sanitize
    ? (sanitizeServerKeys(mcpServers) as Record<string, object>)
    : mcpServers;

  const mapped: Record<string, object> = options?.serverMapper
    ? Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [name, options.serverMapper!(server)])
      )
    : servers;

  const merged = options?.previouslyOwned
    ? managedMergeMcp(existing, mapped, options.previouslyOwned)
    : mergeMcpIntoAgent(existing, mapped);

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  saveJsonFile(configPath, merged);
}

export function mergeMcpIntoAgent(
  agentConfig: JsonAgentConfig,
  mcpServers: Record<string, object>
): JsonAgentConfig {
  const merged: JsonAgentConfig = { ...agentConfig };

  // Replace mcpServers entirely - only keep servers in the new config
  // This ensures disabled servers are removed from target
  merged.mcpServers = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    // Preserve existing server-specific settings (if any) while applying new config
    const existing = (agentConfig.mcpServers?.[name] as Record<string, unknown>) ?? {};
    merged.mcpServers[name] = { ...existing, ...server };
  }

  return merged;
}

/**
 * Managed merge: preserve foreign servers, only upsert/remove ASB-owned servers.
 * Used in project scope to avoid destroying manually-configured MCP servers.
 */
export function managedMergeMcp(
  agentConfig: JsonAgentConfig,
  mcpServers: Record<string, object>,
  previouslyOwned: ReadonlySet<string>
): JsonAgentConfig {
  const merged: JsonAgentConfig = { ...agentConfig };
  const existing = { ...(agentConfig.mcpServers ?? {}) };

  // Remove previously owned servers that are no longer enabled
  for (const name of previouslyOwned) {
    if (!(name in mcpServers)) {
      delete existing[name];
    }
  }

  // Upsert ASB-enabled servers
  for (const [name, server] of Object.entries(mcpServers)) {
    const prev = (existing[name] as Record<string, unknown>) ?? {};
    existing[name] = { ...prev, ...server };
  }

  merged.mcpServers = existing;
  return merged;
}
