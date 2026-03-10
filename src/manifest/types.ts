/**
 * Project distribution manifest types.
 *
 * The manifest tracks which artifacts ASB has written to a project directory,
 * enabling safe cleanup (only remove ASB-owned items) and conflict detection
 * (don't overwrite project-native content).
 */

/** An artifact ASB has distributed (file or bundle directory). */
export interface ManifestEntry {
  /** Path relative to project root (e.g. ".claude/skills/my-skill") */
  relativePath: string;
  /** Which target app wrote this (e.g. "claude-code", "cursor", "agents") */
  targetId: string;
  /** SHA-256 hash of last-written content */
  hash: string;
  updatedAt: string;
}

/** An MCP server key ASB has written into a target config file. */
export interface ManagedMcpEntry {
  /** Config file path relative to project root (e.g. ".mcp.json") */
  relativePath: string;
  /** Target app that owns this server key */
  targetId: string;
  /** Actual key written into mcpServers (after sanitize) */
  serverKey: string;
  updatedAt: string;
}

/** A rules block ASB has injected into a shared or dedicated file. */
export interface RulesManifestEntry {
  /** File path relative to project root */
  relativePath: string;
  /** "block" = shared file with markers, "full" = dedicated ASB file */
  mode: 'block' | 'full';
  /** Which target apps share this physical file */
  targetIds: string[];
  /** SHA-256 of last-written ASB rules content */
  hash: string;
  updatedAt: string;
}

export type ManifestSectionKey = 'skills' | 'commands' | 'agents' | 'mcp' | 'rules';

export interface ManifestSections {
  skills?: Record<string, ManifestEntry>;
  commands?: Record<string, ManifestEntry>;
  agents?: Record<string, ManifestEntry>;
  mcp?: Record<string, ManagedMcpEntry>;
  rules?: Record<string, RulesManifestEntry>;
}

export interface ProjectDistributionManifest {
  version: 1;
  updatedAt: string;
  sections: ManifestSections;
}
