/**
 * Agent adapter interface
 * Implements the strategy pattern for different agent config formats
 */

import type { McpServer } from "../config/schemas.js";

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
	 * Returns the absolute path to the agent's config file
	 * @returns Absolute path to the config file
	 * @example "/Users/username/.claude.json"
	 */
	configPath(): string;

	/**
     * Applies MCP config to the agent's config file
     * - Merges with existing config (preserves unknown fields)
     * - The 'enable' field is excluded from the input
     * @param config - MCP servers to apply (without 'enable')
	 */
	applyConfig(config: { mcpServers: Record<string, Omit<McpServer, "enable">> }): void;
}
