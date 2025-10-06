/**
 * Claude Code agent adapter
 * Manages MCP server configuration for Claude Code CLI
 */

import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '../config/schemas.js';
import type { AgentAdapter } from './adapter.js';

import {
  type JsonAgentConfig,
  loadJsonFile,
  mergeMcpIntoAgent,
  saveJsonFile,
} from './json-utils.js';

/**
 * Claude Code agent adapter
 * Config location: ~/.claude.json
 */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly id = 'claude-code' as const;

  configPath(): string {
    const base =
      process.env.ASB_AGENTS_HOME && process.env.ASB_AGENTS_HOME.trim().length > 0
        ? (process.env.ASB_AGENTS_HOME as string)
        : os.homedir();
    return path.join(base, '.claude.json');
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
