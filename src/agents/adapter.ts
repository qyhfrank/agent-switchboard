/**
 * Agent adapter interface
 * Implements the strategy pattern for different agent config formats
 */

import type { McpServer } from '../config/schemas.js';

/**
 * Agent adapter interface
 * Each agent (Claude Code, Codex, Cursor, etc.) implements this interface
 * to handle its specific configuration format and file location
 */
export interface AgentAdapter {
  /**
   * Unique identifier for the agent
   * @example "claude-code", "codex", "cursor"
   */
  readonly id: string;

  /**
   * Returns the absolute path to the agent's global config file
   * @returns Absolute path to the config file
   * @example "/Users/username/.claude.json"
   */
  configPath(): string;

  /**
   * Returns the absolute path to the agent's project-level config file
   * @param projectRoot - Absolute path to the project root directory
   * @returns Absolute path to the project config file, or undefined if not supported
   * @example "/path/to/project/.mcp.json"
   */
  projectConfigPath?(projectRoot: string): string;

  /**
   * Applies MCP config to the agent's global config file
   * - Merges with existing config (preserves unknown fields)
   * - The 'enabled' field is excluded from the input
   * @param config - MCP servers to apply (without 'enabled')
   */
  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void;

  /**
   * Applies MCP config to the agent's project-level config file
   * @param projectRoot - Absolute path to the project root directory
   * @param config - MCP servers to apply (without 'enabled')
   */
  applyProjectConfig?(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void;
}
