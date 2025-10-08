/**
 * opencode agent adapter
 * Synchronizes MCP servers into ~/.config/opencode/opencode.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { getOpencodePath } from '../config/paths.js';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';

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
    return getOpencodePath('opencode.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const filePath = this.configPath();

    // Load existing
    let current: OpencodeConfig = {};
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        current = JSON.parse(raw) as OpencodeConfig;
      } catch {
        // If unreadable, start fresh but do not throw to avoid blocking apply on one agent
        current = {};
      }
    }

    const out: OpencodeConfig = { ...current };
    const mcpOut: Record<string, Record<string, unknown>> = { ...(current.mcp ?? {}) };

    for (const [name, server] of Object.entries(config.mcpServers)) {
      const prev = { ...(mcpOut[name] ?? {}) };
      // Cast to extended type to access potential additional fields
      const extServer = server as ExtendedMcpServer;

      // Map stdio/local vs http/remote
      const isRemote = extServer.type === 'http' || typeof extServer.url === 'string';
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
