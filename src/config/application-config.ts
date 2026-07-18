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
  SwitchboardConfigLayer,
} from './schemas.js';
import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';

export type ConfigSection = 'mcp' | 'commands' | 'agents' | 'skills' | 'hooks' | 'rules';

export interface ResolvedSectionConfig {
  enabled: string[];
}

export type NativePluginScope = 'user';

export interface ResolvedNativePluginConfig {
  enabled: string[];
  scope: NativePluginScope;
}

type ApplicationConfigSource = SwitchboardConfigLayer;

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

export function resolveScopedSectionConfig(
  section: ConfigSection,
  appId: string,
  scope?: ConfigScope
): ResolvedSectionConfig {
  if (!scope?.profile && !scope?.project) {
    const { config } = loadMergedSwitchboardConfig(scopeToLayerOptions(scope));
    return resolveSectionConfigFromConfig(config, section, appId, scope);
  }

  const layer = loadWritableConfigLayer(scopeToLayerOptions(scope));
  return resolveSectionConfigFromConfig(layer.config, section, appId, scope);
}

export function resolveScopedNativePluginConfig(
  appId: string,
  scope?: ConfigScope
): ResolvedNativePluginConfig {
  if (!scope?.profile && !scope?.project) {
    const { config } = loadMergedSwitchboardConfig(scopeToLayerOptions(scope));
    return resolveNativePluginConfigFromConfig(config, appId, scope);
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
