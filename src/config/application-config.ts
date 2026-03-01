/**
 * Application-specific configuration resolution.
 * Supports per-application overrides using add/remove incremental syntax.
 *
 * "Applications" are the target AI agent apps (claude-code, cursor, codex, etc.)
 * that ASB distributes library entries to.
 */

import { loadMergedSwitchboardConfig } from './layered-config.js';
import type { IncrementalSelection, SwitchboardConfig } from './schemas.js';
import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';

export type ConfigSection = 'mcp' | 'commands' | 'agents' | 'skills' | 'hooks' | 'rules';

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

  if (override.active && override.active.length > 0) {
    return override.active;
  }

  let result = [...base];

  if (override.remove && override.remove.length > 0) {
    const removeSet = new Set(override.remove);
    result = result.filter((id) => !removeSet.has(id));
  }

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
 * Get per-application override configuration for a specific section
 */
export function getApplicationOverride(
  config: SwitchboardConfig,
  appId: string,
  section: ConfigSection
): IncrementalSelection | undefined {
  const applications = config.applications as Record<string, unknown>;
  const appOverrides = applications[appId];
  if (!appOverrides || typeof appOverrides !== 'object') {
    return undefined;
  }

  const overrideObj = appOverrides as Record<string, unknown>;
  return overrideObj[section] as IncrementalSelection | undefined;
}

/**
 * Resolve effective configuration for a specific application and section.
 * Applies per-application overrides to the global section config.
 */
export function resolveApplicationSectionConfig(
  section: ConfigSection,
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);

  const globalActive = [...config[section].active];
  const override = getApplicationOverride(config, appId, section);

  return {
    active: mergeIncrementalSelection(globalActive, override),
  };
}

/**
 * Check if an application has any overrides configured
 */
export function hasApplicationOverrides(config: SwitchboardConfig, appId: string): boolean {
  const applications = config.applications as Record<string, unknown>;
  const appOverrides = applications[appId];
  return appOverrides !== undefined && typeof appOverrides === 'object';
}

/**
 * Get list of applications that have overrides configured
 */
export function getApplicationsWithOverrides(config: SwitchboardConfig): string[] {
  const applications = config.applications as Record<string, unknown>;
  const result: string[] = [];
  for (const key of Object.keys(applications)) {
    if (key !== 'active' && typeof applications[key] === 'object') {
      result.push(key);
    }
  }
  return result;
}
