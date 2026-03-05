/**
 * Shared JSON file helpers for agent adapters
 */

import fs from 'node:fs';

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
      console.warn(`[asb] MCP name collision: "${prev}" and "${name}" both map to "${key}"`);
    }
    seen.set(key, name);
    result[key] = server;
  }
  return result;
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
