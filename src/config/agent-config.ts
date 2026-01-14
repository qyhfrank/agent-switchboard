/**
 * Agent-specific configuration resolution
 * Supports per-agent overrides using add/remove incremental syntax
 */

import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';
import { loadMergedSwitchboardConfig } from './layered-config.js';
import type { IncrementalSelection, SwitchboardConfig } from './schemas.js';

export type ConfigSection = 'mcp' | 'commands' | 'subagents' | 'skills' | 'rules';

export interface ResolvedSectionConfig {
  active: string[];
}

/**
 * Merge incremental selection with base active list
 *
 * Priority: active > add/remove
 * Formula: (base - remove) ∪ add
 */
export function mergeIncrementalSelection(
  base: string[],
  override?: IncrementalSelection
): string[] {
  if (!override) return base;

  // If active is specified, use it as complete override
  if (override.active && override.active.length > 0) {
    return override.active;
  }

  let result = [...base];

  // Apply remove first
  if (override.remove && override.remove.length > 0) {
    const removeSet = new Set(override.remove);
    result = result.filter((id) => !removeSet.has(id));
  }

  // Then apply add
  if (override.add && override.add.length > 0) {
    const existing = new Set(result);
    for (const id of override.add) {
      if (!existing.has(id)) {
        result.push(id);
      }
    }
  }

  return result;
}

/**
 * Get per-agent override configuration for a specific section
 */
export function getAgentOverride(
  config: SwitchboardConfig,
  agentId: string,
  section: ConfigSection
): IncrementalSelection | undefined {
  // agents object may contain per-agent overrides as additional keys (via passthrough)
  const agents = config.agents as Record<string, unknown>;
  const agentOverrides = agents[agentId];
  if (!agentOverrides || typeof agentOverrides !== 'object') {
    return undefined;
  }

  const overrideObj = agentOverrides as Record<string, unknown>;
  return overrideObj[section] as IncrementalSelection | undefined;
}

/**
 * Resolve effective configuration for a specific agent and section
 *
 * Applies per-agent overrides to the global section config
 */
export function resolveAgentSectionConfig(
  section: ConfigSection,
  agentId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);

  // Get global active list for the section
  const globalActive = [...config[section].active];

  // Get agent-specific override
  const override = getAgentOverride(config, agentId, section);

  // Merge and return
  return {
    active: mergeIncrementalSelection(globalActive, override),
  };
}

/**
 * Check if an agent has any overrides configured
 */
export function hasAgentOverrides(config: SwitchboardConfig, agentId: string): boolean {
  const agents = config.agents as Record<string, unknown>;
  const agentOverrides = agents[agentId];
  return agentOverrides !== undefined && typeof agentOverrides === 'object';
}

/**
 * Get list of agents that have overrides configured
 */
export function getAgentsWithOverrides(config: SwitchboardConfig): string[] {
  const agents = config.agents as Record<string, unknown>;
  const result: string[] = [];
  for (const key of Object.keys(agents)) {
    if (key !== 'active' && typeof agents[key] === 'object') {
      result.push(key);
    }
  }
  return result;
}
