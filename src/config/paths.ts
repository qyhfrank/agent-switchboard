/**
 * Path utilities for Agent Switchboard configuration files
 * Resolves config directory as: ASB_HOME > ~/.asb > ~/.agent-switchboard > ~/.asb (default)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Preferred (short) config directory name */
const CONFIG_DIR_SHORT = '.asb';
/** Legacy config directory name */
const CONFIG_DIR_LEGACY = '.agent-switchboard';

/**
 * Returns the absolute path to the Agent Switchboard config directory.
 * Resolution order:
 *  1. ASB_HOME env var (explicit override)
 *  2. ~/.asb (preferred short path, if it exists)
 *  3. ~/.agent-switchboard (legacy path, if it exists)
 *  4. ~/.asb (default for new installations)
 */
export function getConfigDir(): string {
  const asbHome = process.env.ASB_HOME?.trim();
  if (asbHome && asbHome.length > 0) return asbHome;

  const home = os.homedir();
  const shortDir = path.join(home, CONFIG_DIR_SHORT);
  const legacyDir = path.join(home, CONFIG_DIR_LEGACY);

  if (fs.existsSync(shortDir)) return shortDir;
  if (fs.existsSync(legacyDir)) return legacyDir;
  return shortDir;
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
 * Returns the absolute path to the agents library directory (~/.asb/agents/)
 */
export function getAgentsDir(): string {
  return path.join(getConfigDir(), 'agents');
}

/**
 * Returns the absolute path to the skills library directory
 */
export function getSkillsDir(): string {
  return path.join(getConfigDir(), 'skills');
}

/**
 * Returns the absolute path to the hooks library directory (~/.asb/hooks/)
 */
export function getHooksDir(): string {
  return path.join(getConfigDir(), 'hooks');
}

/**
 * Returns the directory for remote source clones.
 * Without namespace: returns the base marketplaces dir (~/.asb/marketplaces/).
 * With namespace: returns the namespace-specific dir (~/.asb/marketplaces/<namespace>/).
 */
export function getSourceCacheDir(namespace?: string): string {
  const base = path.join(getConfigDir(), 'marketplaces');
  return namespace ? path.join(base, namespace) : base;
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

export function getCodexAgentsDir(): string {
  return path.join(getCodexDir(), 'agents');
}

export function getGeminiDir(): string {
  return path.join(getAgentsHome(), '.gemini');
}

export function getCursorDir(): string {
  return path.join(getAgentsHome(), '.cursor');
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

/**
 * Returns the Codex skills directory following the open agent skills standard.
 * Codex reads skills from ~/.agents/skills/ (USER scope), not ~/.codex/skills/.
 * See: https://developers.openai.com/codex/skills
 */
export function getCodexSkillsDir(): string {
  return path.join(getAgentsHome(), '.agents', 'skills');
}

/**
 * Returns the project-scoped Codex skills directory.
 * Codex scans .agents/skills/ from CWD up to repo root.
 * See: https://developers.openai.com/codex/skills
 */
export function getProjectCodexSkillsDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.agents', 'skills');
}

/** Project-scoped platform roots (used when --project is set and platform supports project-level files) */
export function getProjectClaudeDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.claude');
}

export function getProjectGeminiDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.gemini');
}

export function getProjectCursorDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.cursor');
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
