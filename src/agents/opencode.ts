/**
 * opencode agent adapter
 * Synchronizes MCP servers into ~/.config/opencode/opencode.json or opencode.jsonc
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { getOpencodePath, getProjectOpencodePath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';

/**
 * Resolves the opencode config file path, preferring .jsonc over .json
 * @param basePath - Base path without extension (e.g., ~/.config/opencode/opencode)
 * @returns The path to use (.jsonc if exists, otherwise .json)
 */
function resolveConfigPath(basePath: string): { path: string; isJsonc: boolean } {
  const jsoncPath = `${basePath}.jsonc`;
  const jsonPath = `${basePath}.json`;

  if (fs.existsSync(jsoncPath)) {
    return { path: jsoncPath, isJsonc: true };
  }
  return { path: jsonPath, isJsonc: false };
}

/**
 * Parse config file content, supporting both JSON and JSONC formats
 */
function parseConfigContent(content: string, isJsonc: boolean): OpencodeConfig {
  if (isJsonc) {
    return parse(content) as OpencodeConfig;
  }
  return JSON.parse(content) as OpencodeConfig;
}

type OpencodeConfig = Record<string, unknown> & {
  mcp?: Record<string, Record<string, unknown>>;
};

// Extended MCP server type with additional fields that may exist
type ExtendedMcpServer = Omit<McpServer, 'enabled'> & {
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export class OpencodeAgent implements AgentAdapter {
  readonly id = 'opencode' as const;

  configPath(): string {
    const basePath = getOpencodePath('opencode');
    return resolveConfigPath(basePath).path;
  }

  /**
   * Project-level config: <project>/.opencode/opencode.json or .jsonc
   */
  projectConfigPath(projectRoot: string): string {
    const basePath = getProjectOpencodePath(projectRoot, 'opencode');
    return resolveConfigPath(basePath).path;
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    this._applyToPath(this.configPath(), config);
  }

  applyProjectConfig(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    this._applyToPath(this.projectConfigPath(projectRoot), config);
  }

  private _applyToPath(
    filePath: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void {
    // Determine if this is a JSONC file
    const isJsonc = filePath.endsWith('.jsonc');

    // Load existing
    let current: OpencodeConfig = {};
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        current = parseConfigContent(raw, isJsonc);
      } catch {
        // If unreadable, start fresh but do not throw to avoid blocking apply on one agent
        current = {};
      }
    }

    const out: OpencodeConfig = { ...current };
    // Replace mcp entirely - only keep servers in the new config
    // This ensures disabled servers are removed from target
    const mcpOut: Record<string, Record<string, unknown>> = {};

    for (const [name, server] of Object.entries(config.mcpServers)) {
      // Preserve existing server-specific settings (if any) while applying new config
      const prev = { ...(current.mcp?.[name] ?? {}) };
      // Cast to extended type to access potential additional fields
      const extServer = server as ExtendedMcpServer;

      // Map stdio/local vs http/sse/remote
      const isRemote =
        extServer.type === 'http' || extServer.type === 'sse' || typeof extServer.url === 'string';
      const next: Record<string, unknown> = { ...prev };

      if (isRemote) {
        next.type = 'remote';
        if (typeof extServer.url === 'string') next.url = extServer.url;
        // Preserve headers if present in source
        if (extServer.headers && typeof extServer.headers === 'object') {
          next.headers = extServer.headers;
        }
        // command/args/env are not applicable to remote; drop stale keys if present
        delete next.command;
        delete next.environment;
      } else {
        next.type = 'local';
        const cmd = extServer.command;
        const args = Array.isArray(extServer.args) ? extServer.args : [];
        if (typeof cmd === 'string' && cmd.length > 0) {
          next.command = [cmd, ...args];
        }
        // environment from env
        if (extServer.env && typeof extServer.env === 'object') {
          next.environment = extServer.env;
        }
        // Drop remote-only keys
        delete next.url;
        delete next.headers;
      }

      // Entries written by ASB are always enabled (we only apply enabled ones)
      next.enabled = true;

      mcpOut[name] = next;
    }

    out.mcp = mcpOut;

    // Ensure dir exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const json = `${JSON.stringify(out, null, 2)}\n`;
    fs.writeFileSync(filePath, json, 'utf-8');
  }
}
