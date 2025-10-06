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
  if (Object.keys(mcpServers).length === 0) return agentConfig;

  const merged: JsonAgentConfig = { ...agentConfig };
  if (!merged.mcpServers) {
    merged.mcpServers = {};
  }
  const target = merged.mcpServers;

  for (const [name, server] of Object.entries(mcpServers)) {
    const existing = (target[name] as Record<string, unknown>) ?? {};
    target[name] = { ...existing, ...server };
  }

  return merged;
}
