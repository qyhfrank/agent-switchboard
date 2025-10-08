/**
 * Codex CLI Agent Adapter
 * Handles TOML-based configuration with canonical section output
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as tomlStringify } from '@iarna/toml';
import { getCodexConfigPath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';

/**
 * Codex CLI agent adapter
 * Config: ~/.codex/config.toml (TOML format)
 */
export class CodexAgent implements AgentAdapter {
  readonly id = 'codex' as const;

  configPath(): string {
    return getCodexConfigPath();
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const content = this._loadConfig();
    const updated = mergeConfig(content, config.mcpServers);
    this._saveConfig(updated);
  }

  private _loadConfig(): string {
    const configPath = this.configPath();
    if (!fs.existsSync(configPath)) {
      return '';
    }
    return fs.readFileSync(configPath, 'utf-8');
  }

  private _saveConfig(content: string): void {
    const configPath = this.configPath();
    const dirPath = path.dirname(configPath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(configPath, content, 'utf-8');
  }
}

/**
 * Merge MCP server config into TOML content
 * Preserves unrelated top-level tables/keys; rewrites mcp_servers in canonical form
 */
export function mergeConfig(
  content: string,
  mcpServers: Record<string, Omit<McpServer, 'enabled'>>
): string {
  // Read existing content to preserve unrelated top-level keys (not comments)
  let otherTopLevel: Record<string, unknown> = {};
  try {
    if (content && content.trim().length > 0) {
      const parsed = parseToml(content) as Record<string, unknown>;
      // Remove mcp_servers from the preserved portion
      const { mcp_servers: _ignored, ...rest } = (parsed ?? {}) as Record<string, unknown>;
      otherTopLevel = rest;
    }
  } catch {
    // If parsing fails, drop old content entirely to avoid propagating bad state
    otherTopLevel = {};
  }

  // Build canonical mcp_servers TOML from provided config
  const mcpToml = buildNestedToml(mcpServers);

  // Stringify other top-level tables/keys via iarna/toml
  let otherToml = '';
  try {
    if (Object.keys(otherTopLevel).length > 0) {
      // Cast to JsonMap type expected by tomlStringify
      otherToml = tomlStringify(otherTopLevel as Record<string, string | number | boolean>);
    }
  } catch {
    otherToml = '';
  }

  const parts: string[] = [];
  if (otherToml.trim().length > 0) parts.push(otherToml.trimEnd());
  if (mcpToml.trim().length > 0) parts.push(mcpToml.trimEnd());

  return `${parts.join('\n\n')}\n`;
}

/**
 * Minimal shape for a Codex MCP server entry used by the renderer
 */
export type McpServerLike = Record<string, unknown> & {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  env_file?: string;
  env?: Record<string, unknown>;
};

/**
 * Build canonical TOML: one table per server [mcp_servers.<name>]
 * env must be written as dotted keys inside the same table: env.KEY = "VALUE"
 * Key order per server: command, args, url, type, env_file, env.* (alpha), unknown (alpha)
 * Exactly one blank line between server tables; final newline added by caller
 */
export function buildNestedToml(
  mcpServers: Record<string, Omit<McpServerLike, 'enabled'>>
): string {
  const lines: string[] = [];

  const serverNames = Object.keys(mcpServers); // preserve insertion order for stability
  for (let idx = 0; idx < serverNames.length; idx++) {
    const name = serverNames[idx];
    const server = (mcpServers[name] ?? {}) as McpServerLike;

    lines.push(`[mcp_servers.${name}]`);

    const KNOWN_ORDER: (keyof McpServerLike)[] = ['command', 'args', 'url', 'type', 'env_file'];

    const emit = (k: string, v: unknown) => {
      if (v === undefined || v === null) return;
      // Only allow primitives and primitive arrays
      const isPrim = (x: unknown) =>
        typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
      const isPrimArr = (x: unknown) => Array.isArray(x) && x.every(isPrim);
      if (!isPrim(v) && !isPrimArr(v)) return;
      // @iarna/toml value formatting for RHS
      const rhs =
        'value' in tomlStringify
          ? tomlStringify.value(v as boolean | number | string | string[])
          : JSON.stringify(v);
      lines.push(`${k} = ${rhs}`);
    };

    // Known keys
    for (const k of KNOWN_ORDER) emit(k, (server as Record<string, unknown>)[k as string]);

    // env dotted keys (alphabetical)
    if (server.env && typeof server.env === 'object') {
      const envEntries = Object.entries(server.env).filter(
        ([_, v]) => v !== undefined && v !== null
      );
      envEntries.sort(([a], [b]) => a.localeCompare(b));
      for (const [ek, ev] of envEntries) emit(`env.${ek}`, String(ev));
    }

    // Unknown keys (exclude known + env)
    const knownSet = new Set<string>([...KNOWN_ORDER.map(String), 'env']);
    const unknownKeys = Object.keys(server)
      .filter((k) => !knownSet.has(k))
      .sort((a, b) => a.localeCompare(b));
    for (const uk of unknownKeys) emit(uk, (server as Record<string, unknown>)[uk]);

    if (idx !== serverNames.length - 1) lines.push(''); // blank line between servers
  }

  return lines.join('\n');
}
