/**
 * Application Target type definitions.
 *
 * A Target represents a distribution target application (claude-code, cursor, etc.)
 * and encapsulates all section-specific distribution logic: paths, rendering, merging.
 */

import type { McpServer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';

export type TargetSection = 'mcp' | 'rules' | 'commands' | 'agents' | 'skills' | 'hooks';

/**
 * Generic library entry shape, structurally compatible with CommandEntry and SubagentEntry.
 * Target handlers receive this instead of concrete entry types.
 */
export interface GenericLibraryEntry {
  readonly id: string;
  readonly bareId: string;
  readonly namespace?: string;
  readonly metadata: {
    readonly description?: string;
    readonly extras?: Record<string, unknown>;
    [key: string]: unknown;
  };
  readonly content: string;
}

/** MCP distribution handler */
export interface TargetMcpHandler {
  configPath(): string;
  projectConfigPath?(projectRoot: string): string;
  applyConfig(config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }): void;
  applyProjectConfig?(
    projectRoot: string,
    config: { mcpServers: Record<string, Omit<McpServer, 'enabled'>> }
  ): void;
}

/** Rules distribution handler */
export interface TargetRulesHandler {
  resolveFilePath(scope?: ConfigScope): string;
  render(composedContent: string): string;
}

/** Single-file library distribution handler (commands, subagents) */
export interface TargetLibraryHandler {
  resolveTargetDir(scope?: ConfigScope): string;
  getFilename(id: string): string;
  render(entry: GenericLibraryEntry): string;
  extractIdFromFilename(filename: string): string | null;
}

/** Custom agents distribution handler (e.g., Codex TOML + config injection) */
export interface TargetCustomAgentsHandler {
  readonly custom: true;
  distribute(
    allEntries: GenericLibraryEntry[],
    byId: Map<string, GenericLibraryEntry>,
    scope?: ConfigScope
  ): DistributionResult<string>[];
}

/** Skills (bundle) distribution handler */
export interface TargetSkillsHandler {
  resolveParentDir(scope?: ConfigScope): string;
  resolveTargetDir(id: string, scope?: ConfigScope): string;
  isReservedDir?(id: string): boolean;
  shouldDedup?(scope?: ConfigScope): boolean;
}

/** Hooks distribution handler (opaque - each target owns its full logic) */
export interface TargetHooksHandler {
  distribute(scope?: ConfigScope): {
    results: Array<{
      platform: string;
      filePath?: string;
      targetDir?: string;
      status: string;
      reason?: string;
      error?: string;
      entryId?: string;
    }>;
  };
}

/**
 * Application Target: unified abstraction for a distribution target.
 * Presence of a section handler indicates the target supports that section.
 */
export interface ApplicationTarget {
  readonly id: string;
  /** Returns false if the application is definitively not installed. Undefined means assumed installed. */
  readonly isInstalled?: () => boolean;
  readonly mcp?: TargetMcpHandler;
  readonly rules?: TargetRulesHandler;
  readonly commands?: TargetLibraryHandler;
  readonly agents?: TargetLibraryHandler | TargetCustomAgentsHandler;
  readonly skills?: TargetSkillsHandler;
  readonly hooks?: TargetHooksHandler;
}

/** Type guard: check if an agents handler uses custom distribution */
export function isCustomAgentsHandler(
  handler: TargetLibraryHandler | TargetCustomAgentsHandler
): handler is TargetCustomAgentsHandler {
  return 'custom' in handler && (handler as TargetCustomAgentsHandler).custom === true;
}

/** List sections supported by a target */
export function getTargetSections(target: ApplicationTarget): TargetSection[] {
  const sections: TargetSection[] = [];
  if (target.mcp) sections.push('mcp');
  if (target.rules) sections.push('rules');
  if (target.commands) sections.push('commands');
  if (target.agents) sections.push('agents');
  if (target.skills) sections.push('skills');
  if (target.hooks) sections.push('hooks');
  return sections;
}
