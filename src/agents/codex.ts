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

  /**
   * Project-level config: <project>/.codex/config.toml
   */
  projectConfigPath(projectRoot: string): string {
    return path.join(path.resolve(projectRoot), '.codex', 'config.toml');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const content = this._loadConfig(this.configPath());
    const updated = mergeConfig(content, config.mcpServers);
    this._saveConfig(this.configPath(), updated);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    const configPath = this.projectConfigPath(projectRoot);
    const content = this._loadConfig(configPath);
    const updated = mergeConfig(content, config.mcpServers);
    this._saveConfig(configPath, updated);
    this._ensureProjectTrusted(projectRoot);
  }

  /**
   * Ensure the project is marked as trusted in the global config.
   * Codex ignores project-level config.toml unless the project has
   * trust_level = "trusted" in ~/.codex/config.toml.
   */
  private _ensureProjectTrusted(projectRoot: string): void {
    const globalPath = this.configPath();
    const globalContent = this._loadConfig(globalPath);
    const result = ensureTrustEntry(globalContent, projectRoot);
    if (result.warning) {
      console.warn(`[codex] ${result.warning}`);
    }
    if (result.changed) {
      this._saveConfig(globalPath, result.content);
    }
  }

  private _loadConfig(configPath: string): string {
    if (!fs.existsSync(configPath)) {
      return '';
    }
    return fs.readFileSync(configPath, 'utf-8');
  }

  private _saveConfig(configPath: string, content: string): void {
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
 * Note: SSE servers are filtered out as Codex only supports stdio and http
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

  // Filter out SSE servers - Codex only supports stdio and http
  const filteredServers: Record<string, Omit<McpServer, 'enabled'>> = {};
  const skippedSse: string[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    const s = server as McpServerLike;
    if (s.type === 'sse') {
      skippedSse.push(name);
      continue;
    }
    filteredServers[name] = server;
  }
  if (skippedSse.length > 0) {
    console.warn(
      `[codex] Skipped ${skippedSse.length} SSE server(s) (unsupported): ${skippedSse.join(', ')}`
    );
  }

  // Build canonical mcp_servers TOML from provided config
  const mcpToml = buildNestedToml(filteredServers);

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
 * Ensure a project trust entry exists in the global config TOML content.
 * Returns the (possibly updated) content and whether it changed.
 * If the project already has a trust section with a non-"trusted" value,
 * returns a warning instead of overriding the user's explicit choice.
 */
export function ensureTrustEntry(
  globalContent: string,
  projectRoot: string
): { content: string; changed: boolean; warning?: string } {
  const absRoot = path.resolve(projectRoot);

  try {
    if (globalContent && globalContent.trim().length > 0) {
      const parsed = parseToml(globalContent) as Record<string, unknown>;
      const projects = parsed.projects as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (projects?.[absRoot]) {
        if (projects[absRoot].trust_level === 'trusted') {
          return { content: globalContent, changed: false };
        }
        return {
          content: globalContent,
          changed: false,
          warning: `Project ${absRoot} has trust_level="${projects[absRoot].trust_level}"; not overriding`,
        };
      }
    }
  } catch {
    // Can't parse global config - don't risk corrupting it
    return { content: globalContent, changed: false };
  }

  const section = `\n[projects."${absRoot}"]\ntrust_level = "trusted"\n`;
  return { content: globalContent.trimEnd() + '\n' + section, changed: true };
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
  headers?: Record<string, string>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  bearer_token_env_var?: string;
  cwd?: string;
  env_vars?: string[];
  enabled_tools?: string[];
  disabled_tools?: string[];
  enabled?: boolean;
  required?: boolean;
  startup_timeout_sec?: number;
  startup_timeout_ms?: number;
  tool_timeout_sec?: number;
};

/**
 * Build canonical TOML: one table per server [mcp_servers.<name>]
 * env must be written as dotted keys inside the same table: env.KEY = "VALUE"
 * headers maps to http_headers in Codex format
 * Key order per server: command, args, url, cwd, bearer_token_env_var, env_file,
 *   enabled, required, enabled_tools, disabled_tools, startup_timeout_sec, tool_timeout_sec,
 *   http_headers, env_http_headers, env.* (alpha), unknown (alpha)
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

    // Scalar and array keys emitted in canonical order
    const KNOWN_SCALAR_ORDER: (keyof McpServerLike)[] = [
      'command',
      'args',
      'url',
      'cwd',
      'bearer_token_env_var',
      'env_file',
      'required',
      'enabled_tools',
      'disabled_tools',
      'env_vars',
      'startup_timeout_sec',
      'startup_timeout_ms',
      'tool_timeout_sec',
    ];

    // Keys handled specially (inline tables, dotted keys)
    const SPECIAL_KEYS = new Set<string>([
      'env',
      'headers',
      'http_headers',
      'env_http_headers',
      'type',
      'enabled',
    ]);

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

    /**
     * Render a Record<string,string> as a TOML inline table.
     */
    const emitInlineTable = (key: string, obj: Record<string, string> | undefined) => {
      if (!obj || typeof obj !== 'object') return;
      const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null);
      if (entries.length === 0) return;
      const pairs = entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `"${k}" = "${String(v).replace(/"/g, '\\"')}"`)
        .join(', ');
      lines.push(`${key} = { ${pairs} }`);
    };

    // Known scalar/array keys
    for (const k of KNOWN_SCALAR_ORDER) emit(k, (server as Record<string, unknown>)[k as string]);

    // headers -> http_headers (inline table format)
    // Prefer explicit http_headers over the generic headers field
    const httpHeaders = server.http_headers ?? server.headers;
    emitInlineTable('http_headers', httpHeaders as Record<string, string> | undefined);

    // env_http_headers (inline table format)
    emitInlineTable('env_http_headers', server.env_http_headers);

    // env dotted keys (alphabetical)
    if (server.env && typeof server.env === 'object') {
      const envEntries = Object.entries(server.env).filter(
        ([_, v]) => v !== undefined && v !== null
      );
      envEntries.sort(([a], [b]) => a.localeCompare(b));
      for (const [ek, ev] of envEntries) emit(`env.${ek}`, String(ev));
    }

    // Unknown keys (exclude known + special)
    const knownSet = new Set<string>([
      ...KNOWN_SCALAR_ORDER.map(String),
      ...SPECIAL_KEYS,
    ]);
    const unknownKeys = Object.keys(server)
      .filter((k) => !knownSet.has(k))
      .sort((a, b) => a.localeCompare(b));
    for (const uk of unknownKeys) emit(uk, (server as Record<string, unknown>)[uk]);

    if (idx !== serverNames.length - 1) lines.push(''); // blank line between servers
  }

  return lines.join('\n');
}
