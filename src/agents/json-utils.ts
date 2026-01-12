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
