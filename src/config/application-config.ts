/**
 * Application-specific configuration resolution.
 * Supports per-application overrides using add/remove incremental syntax.
 *
 * "Applications" are the target AI agent apps (claude-code, cursor, codex, etc.)
 * that ASB distributes library entries to.
 */

import type { NativePluginTarget } from '../marketplace/reader.js';
import { buildComponentId, splitComponentId } from '../plugins/identity.js';
import {
  buildPluginIndex,
  type PluginComponentSection,
  type PluginIndex,
} from '../plugins/index.js';
import { loadMergedSwitchboardConfig, loadWritableConfigLayer } from './layered-config.js';
import { mergeIncrementalSelection, resolveEffectiveSelection } from './plugin-selection.js';
import type {
  IncrementalSelection,
  NativePluginSelection,
  PluginExclude,
  SwitchboardConfig,
  SwitchboardConfigLayer,
} from './schemas.js';
import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';

export type ConfigSection = 'mcp' | 'commands' | 'agents' | 'skills' | 'hooks' | 'rules';

export { mergeIncrementalSelection } from './plugin-selection.js';

/** Schema-level keys in [applications] that are NOT per-app override objects. */
const APPLICATION_SCHEMA_KEYS = new Set(['enabled', 'active', 'assume_installed']);

export interface ResolvedSectionConfig {
  enabled: string[];
}

export type NativePluginScope = 'user';

export interface ResolvedNativePluginConfig {
  enabled: string[];
  scope: NativePluginScope;
}

type ApplicationConfigSource = SwitchboardConfig | SwitchboardConfigLayer;

/**
 * Merge incremental selection with base enabled list
 *
 * Priority: enabled > add/remove
 * Formula: (base - remove) ∪ add
 */
/**
 * Get per-application override configuration for a specific section
 */
export function getApplicationOverride(
  config: SwitchboardConfig,
  appId: string,
  section: ConfigSection
): IncrementalSelection | undefined {
  return getApplicationOverrideFromConfig(config, appId, section);
}

function getApplicationOverrideFromConfig(
  config: ApplicationConfigSource,
  appId: string,
  section: ConfigSection
): IncrementalSelection | undefined {
  const applications = (config.applications ?? {}) as Record<string, unknown>;
  const appOverrides = applications[appId];
  if (!appOverrides || typeof appOverrides !== 'object') {
    return undefined;
  }

  const overrideObj = appOverrides as Record<string, unknown>;
  return overrideObj[section] as IncrementalSelection | undefined;
}

function getApplicationNativePluginsOverrideFromConfig(
  config: ApplicationConfigSource,
  appId: string
): NativePluginSelection | undefined {
  const applications = (config.applications ?? {}) as Record<string, unknown>;
  const appOverrides = applications[appId];
  if (!appOverrides || typeof appOverrides !== 'object') {
    return undefined;
  }

  const overrideObj = appOverrides as Record<string, unknown>;
  return overrideObj.native_plugins as NativePluginSelection | undefined;
}

function getGlobalEnabled(config: ApplicationConfigSource, section: ConfigSection): string[] {
  const sectionConfig = config[section] as { enabled?: string[] } | undefined;
  return Array.isArray(sectionConfig?.enabled) ? [...sectionConfig.enabled] : [];
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function normalizeSectionEntryIds(
  _section: ConfigSection,
  ids: string[],
  scope?: ConfigScope
): string[] {
  if (ids.length === 0) return [];
  const index = buildPluginIndex(scope);
  return dedupeIds(ids.map((id) => index.normalizeComponentId(id)));
}

function canonicalizeComponentRefs(ids: string[], index: PluginIndex): string[] {
  return dedupeIds(
    ids.map((id) => {
      const parsed = splitComponentId(id);
      if (!parsed) return id;
      const plugin = index.get(parsed.pluginId);
      return plugin ? buildComponentId(plugin.id, parsed.bareId) : id;
    })
  );
}

function resolvePortablePluginRefsFromConfig(
  config: ApplicationConfigSource,
  appId: string,
  index: PluginIndex
): string[] {
  const globalPluginRefs = Array.isArray(config.plugins?.enabled)
    ? [...config.plugins.enabled]
    : [];
  return resolveEffectiveSelection(
    globalPluginRefs,
    config,
    appId,
    'plugins',
    (ref) => index.get(ref)?.id ?? ref
  );
}

function getPluginExcludeList(
  config: ApplicationConfigSource,
  section: PluginComponentSection
): string[] {
  const exclude = config.plugins?.exclude as PluginExclude | undefined;
  const excludeList = exclude?.[section];
  return Array.isArray(excludeList) ? [...excludeList] : [];
}

function normalizeIncrementalSelection(
  override: IncrementalSelection | undefined,
  index: PluginIndex
): IncrementalSelection | undefined {
  if (!override) return undefined;

  const normalized: IncrementalSelection = {};
  if (override.enabled) {
    normalized.enabled = canonicalizeComponentRefs(override.enabled, index);
  }
  if (override.add) {
    normalized.add = canonicalizeComponentRefs(override.add, index);
  }
  if (override.remove) {
    normalized.remove = canonicalizeComponentRefs(override.remove, index);
  }
  return normalized;
}

function toNativePluginTarget(appId: string): NativePluginTarget | undefined {
  return appId === 'claude-code' || appId === 'codex' ? appId : undefined;
}

function normalizeNativePluginRefs(appId: string, ids: string[], scope?: ConfigScope): string[] {
  if (ids.length === 0) return [];
  const index = buildPluginIndex(scope);
  const target = toNativePluginTarget(appId);
  return dedupeIds(
    ids.map((id) => {
      const plugin = index.getNative(id, target);
      return plugin?.id ?? id;
    })
  );
}

function resolveSectionConfigFromConfig(
  config: ApplicationConfigSource,
  section: ConfigSection,
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  const index = buildPluginIndex(scope);
  const globalEnabled = canonicalizeComponentRefs(getGlobalEnabled(config, section), index);
  const enabledPluginRefs = resolvePortablePluginRefsFromConfig(config, appId, index);
  const pluginSection = section as PluginComponentSection;
  const expanded = index.expand(enabledPluginRefs);
  const excludeSet = new Set(
    canonicalizeComponentRefs(getPluginExcludeList(config, pluginSection), index)
  );
  const pluginEntryIds = (expanded[pluginSection] ?? []).filter((id) => !excludeSet.has(id));
  const merged = dedupeIds([...globalEnabled, ...pluginEntryIds]);

  const override = normalizeIncrementalSelection(
    getApplicationOverrideFromConfig(config, appId, section),
    index
  );
  const effective = mergeIncrementalSelection(merged, override);
  return {
    enabled: dedupeIds(effective.map((id) => index.normalizeComponentId(id))),
  };
}

function resolveNativePluginConfigFromConfig(
  config: ApplicationConfigSource,
  appId: string,
  scope?: ConfigScope
): ResolvedNativePluginConfig {
  const override = getApplicationNativePluginsOverrideFromConfig(config, appId);
  const nativeScope = (override as { scope?: unknown } | undefined)?.scope;
  if (nativeScope !== undefined && nativeScope !== 'user') {
    throw new Error(
      `Unsupported native plugin scope "${nativeScope}". Only "user" is currently supported.`
    );
  }
  return {
    enabled: normalizeNativePluginRefs(appId, override?.enabled ?? [], scope),
    scope: 'user',
  };
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
  return resolveSectionConfigFromConfig(config, section, appId, scope);
}

/**
 * Check if an application has any overrides configured
 */
export function hasApplicationOverrides(config: SwitchboardConfig, appId: string): boolean {
  const applications = config.applications as Record<string, unknown>;
  if (APPLICATION_SCHEMA_KEYS.has(appId)) return false;
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
    if (!APPLICATION_SCHEMA_KEYS.has(key) && typeof applications[key] === 'object') {
      result.push(key);
    }
  }
  return result;
}

// ── Plugin-aware effective config ──────────────────────────────────

/**
 * Resolve the effective enabled list for a section, merging:
 *   1. Global `config.<section>.enabled`
 *   2. Per-application plugin selection over `config.plugins.enabled`
 *   3. Plugin expansion and `config.plugins.exclude.<section>` filtering
 *   4. Per-application component overrides (`add`/`remove`/`enabled`)
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

  return resolveSectionConfigFromConfig(config, section, appId, scope);
}

/**
 * Resolve target-native plugin selections for a specific application.
 * Native plugins are application-owned lifecycle objects and are not expanded
 * through global `[plugins].enabled`.
 */
export function resolveApplicationNativePluginConfig(
  appId: string,
  scope?: ConfigScope
): ResolvedNativePluginConfig {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);
  return resolveNativePluginConfigFromConfig(config, appId, scope);
}

export function resolveScopedSectionConfig(
  section: ConfigSection,
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  if (!scope?.profile && !scope?.project) {
    return resolveEffectiveSectionConfig(section, appId, scope);
  }

  const layer = loadWritableConfigLayer(scopeToLayerOptions(scope));
  return resolveSectionConfigFromConfig(layer.config, section, appId, scope);
}

export function resolveScopedNativePluginConfig(
  appId: string,
  scope?: ConfigScope
): ResolvedNativePluginConfig {
  if (!scope?.profile && !scope?.project) {
    return resolveApplicationNativePluginConfig(appId, scope);
  }

  const layer = loadWritableConfigLayer(scopeToLayerOptions(scope));
  return resolveNativePluginConfigFromConfig(layer.config, appId, scope);
}

export function resolveScopedPortablePluginConfig(
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  const layerOptions = scopeToLayerOptions(scope);
  const config =
    scope?.profile || scope?.project
      ? loadWritableConfigLayer(layerOptions).config
      : loadMergedSwitchboardConfig(layerOptions).config;
  const index = buildPluginIndex(scope);
  return { enabled: resolvePortablePluginRefsFromConfig(config, appId, index) };
}
