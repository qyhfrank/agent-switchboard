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

/**
 * Returns the absolute path to a profile-specific configuration file located under ASB_HOME.
 * Example: ~/.agent-switchboard/team.toml
 */
export function getProfileConfigPath(profileName: string): string {
  const trimmed = profileName.trim();
  if (trimmed.length === 0) {
    throw new Error('Profile name must be a non-empty string.');
  }
  return path.join(getConfigDir(), `${trimmed}.toml`);
}

/**
 * Returns the absolute path to a project-scoped configuration file (.asb.toml).
 */
export function getProjectConfigPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.asb.toml');
}

/**
 * Returns the absolute path to the rule snippets directory
 */
export function getRulesDir(): string {
  return path.join(getConfigDir(), 'rules');
}

/**
 * Returns the absolute path to the commands library directory
 */
export function getCommandsDir(): string {
  return path.join(getConfigDir(), 'commands');
}

/**
 * Returns the absolute path to the subagents library directory
 */
export function getSubagentsDir(): string {
  return path.join(getConfigDir(), 'subagents');
}

/**
 * Returns the absolute path to the skills library directory
 */
export function getSkillsDir(): string {
  return path.join(getConfigDir(), 'skills');
}

/**
 * Returns the home directory for installed agent apps (Claude Code, OpenCode, etc.)
 * Can be overridden via `ASB_AGENTS_HOME`; falls back to the OS user home.
 */
export function getAgentsHome(): string {
  const override = process.env.ASB_AGENTS_HOME?.trim();
  if (override && override.length > 0) return override;
  return os.homedir();
}

/** Platform-specific roots for common agent apps */
export function getClaudeDir(): string {
  return path.join(getAgentsHome(), '.claude');
}

export function getCodexDir(): string {
  return path.join(getAgentsHome(), '.codex');
}

export function getGeminiDir(): string {
  return path.join(getAgentsHome(), '.gemini');
}

export function getOpencodeRoot(): string {
  const home = getAgentsHome();
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'opencode')
    : path.join(home, '.config', 'opencode');
}

export function getOpencodePath(...segments: string[]): string {
  return path.join(getOpencodeRoot(), ...segments);
}

/** Project-scoped platform roots (used when --project is set and platform supports project-level files) */
export function getProjectClaudeDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.claude');
}

export function getProjectGeminiDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.gemini');
}

export function getProjectOpencodeRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.opencode');
}

export function getProjectOpencodePath(projectRoot: string, ...segments: string[]): string {
  return path.join(getProjectOpencodeRoot(projectRoot), ...segments);
}

/** Config file helpers */
export function getClaudeJsonPath(): string {
  return path.join(getAgentsHome(), '.claude.json');
}

export function getCodexConfigPath(): string {
  return path.join(getCodexDir(), 'config.toml');
}

export function getGeminiSettingsPath(): string {
  return path.join(getGeminiDir(), 'settings.json');
}

export function getClaudeDesktopConfigPath(): string {
  const home = getAgentsHome();
  switch (os.platform()) {
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      );
    case 'win32':
      return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}
