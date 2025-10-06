/**
 * Path utilities for Agent Switchboard configuration files
 * Provides cross-platform path resolution for config files under ~/.agent-switchboard
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Returns the absolute path to the Agent Switchboard config directory
 * Cross-platform compatible: works on macOS, Linux, and Windows
 *
 * @returns {string} Absolute path to ~/.agent-switchboard
 * @example
 * // macOS/Linux: /Users/username/.agent-switchboard
 * // Windows: C:\Users\username\.agent-switchboard
 */
export function getConfigDir(): string {
  // Redesigned semantics:
  // - ASB_HOME now points directly to the Switchboard config directory (i.e., replaces ~/.agent-switchboard)
  // - If not set, default to os.homedir()/.agent-switchboard
  const asbHome = process.env.ASB_HOME?.trim();
  if (asbHome && asbHome.length > 0) return asbHome;
  return path.join(os.homedir(), '.agent-switchboard');
}

/**
 * Returns the absolute path to the MCP config file (mcp.json)
 * This file stores all MCP server configurations with enabled flags
 *
 * @returns {string} Absolute path to ~/.agent-switchboard/mcp.json
 */
export function getMcpConfigPath(): string {
  return path.join(getConfigDir(), 'mcp.json');
}

/**
 * Returns the absolute path to the Agent Switchboard config file (config.toml)
 * This file stores the list of agents to apply MCP configs to
 *
 * @returns {string} Absolute path to ~/.agent-switchboard/config.toml
 */
export function getSwitchboardConfigPath(): string {
  return path.join(getConfigDir(), 'config.toml');
}
