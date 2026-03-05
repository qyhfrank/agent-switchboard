/**
 * Application-specific configuration resolution.
 * Supports per-application overrides using add/remove incremental syntax.
 *
 * "Applications" are the target AI agent apps (claude-code, cursor, codex, etc.)
 * that ASB distributes library entries to.
 */

import { buildPluginIndex, type PluginComponentSection } from '../plugins/index.js';
import { loadMergedSwitchboardConfig } from './layered-config.js';
import type { IncrementalSelection, PluginExclude, SwitchboardConfig } from './schemas.js';
import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';

export type ConfigSection = 'mcp' | 'commands' | 'agents' | 'skills' | 'hooks' | 'rules';

export interface ResolvedSectionConfig {
  enabled: string[];
}

/**
 * Merge incremental selection with base enabled list
 *
 * Priority: enabled > add/remove
 * Formula: (base - remove) ∪ add
 */
export function mergeIncrementalSelection(
  base: string[],
  override?: IncrementalSelection
): string[] {
  if (!override) return base;

  if (override.enabled && override.enabled.length > 0) {
    return override.enabled;
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

  const globalEnabled = [...config[section].enabled];
  const override = getApplicationOverride(config, appId, section);

  return {
    enabled: mergeIncrementalSelection(globalEnabled, override),
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

// ── Plugin-aware effective config ──────────────────────────────────

/**
 * Resolve the effective enabled list for a section, merging:
 *   1. Global `config.<section>.enabled`
 *   2. Plugin expansion: `config.plugins.enabled` -> PluginIndex.expand -> per-section IDs
 *   3. Plugin exclude: `config.plugins.exclude.<section>` removals
 *   4. Per-application overrides (`add`/`remove`/`enabled`)
 *
 * This is the function distribution modules should use to determine
 * what entries to distribute for a given app.
 */
export function resolveEffectiveSectionConfig(
  section: ConfigSection,
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);

  const globalEnabled = [...config[section].enabled];

  const { enabled: enabledPluginRefs } = config.plugins;

  let merged: string[];
  if (enabledPluginRefs.length > 0) {
    const index = buildPluginIndex(scope);
    const expanded = index.expand(enabledPluginRefs);
    const pluginSection = section as PluginComponentSection;
    const pluginEntryIds = expanded[pluginSection] ?? [];

    // Union: global enabled ∪ plugin-expanded (preserving explicit enabled order first)
    const seen = new Set(globalEnabled);
    merged = [...globalEnabled];
    for (const id of pluginEntryIds) {
      if (!seen.has(id)) {
        merged.push(id);
        seen.add(id);
      }
    }

    const exclude = config.plugins.exclude;
    const excludeList = (exclude as PluginExclude)?.[pluginSection];
    if (excludeList && excludeList.length > 0) {
      const excludeSet = new Set(excludeList);
      merged = merged.filter((id) => !excludeSet.has(id));
    }
  } else {
    merged = globalEnabled;
  }

  const override = getApplicationOverride(config, appId, section);
  return {
    enabled: mergeIncrementalSelection(merged, override),
  };
}
