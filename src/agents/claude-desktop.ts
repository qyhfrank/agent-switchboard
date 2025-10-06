/**
 * Claude Desktop agent adapter
 * Manages MCP server configuration for Claude Desktop app
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
 * Claude Desktop config file structure
 */
// Uses shared JsonAgentConfig

/**
 * Claude Desktop agent adapter
 * Config location (platform-specific):
 * - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Linux: ~/.config/Claude/claude_desktop_config.json
 * - Windows: %APPDATA%\Claude\claude_desktop_config.json
 */
export class ClaudeDesktopAgent implements AgentAdapter {
  readonly id = 'claude-desktop' as const;

  configPath(): string {
    const platform = os.platform();
    const home =
      process.env.ASB_AGENTS_HOME && process.env.ASB_AGENTS_HOME.trim().length > 0
        ? (process.env.ASB_AGENTS_HOME as string)
        : os.homedir();

    switch (platform) {
      case 'darwin': // macOS
        return path.join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json'
        );
      case 'win32': // Windows
        return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      case 'linux': // Linux
        return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void {
    const path = this.configPath();
    const agentConfig = loadJsonFile<JsonAgentConfig>(path, { mcpServers: {} });
    const merged = mergeMcpIntoAgent(agentConfig, config.mcpServers as Record<string, object>);
    saveJsonFile(path, merged);
  }
}
