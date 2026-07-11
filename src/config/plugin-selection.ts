import { loadMergedSwitchboardConfig, loadWritableConfigLayer } from './layered-config.js';
import type { IncrementalSelection, SwitchboardConfig, SwitchboardConfigLayer } from './schemas.js';
import type { ConfigScope } from './scope.js';
import { scopeToLayerOptions } from './scope.js';

export type PortableComponentSection = 'mcp' | 'commands' | 'agents' | 'skills' | 'hooks' | 'rules';

type SelectionConfig = SwitchboardConfig | SwitchboardConfigLayer;

export interface ConfiguredPortableSelections {
  pluginRefs: string[];
  componentRefs: string[];
}

export interface PortableSelectionNormalizers {
  pluginRef?: (ref: string) => string;
  componentRef?: (ref: string) => string;
}

const COMPONENT_SECTIONS: PortableComponentSection[] = [
  'mcp',
  'commands',
  'agents',
  'skills',
  'hooks',
  'rules',
];

export function mergeIncrementalSelection(
  base: string[],
  override?: IncrementalSelection
): string[] {
  if (!override) return base;
  if (override.enabled) return override.enabled;

  const removed = new Set(override.remove ?? []);
  const result = base.filter((id) => !removed.has(id));
  const seen = new Set(result);
  for (const id of override.add ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function getApplicationSelection(
  config: SelectionConfig,
  appId: string,
  section: PortableComponentSection | 'plugins'
): IncrementalSelection | undefined {
  const applications = (config.applications ?? {}) as Record<string, unknown>;
  const app = applications[appId];
  if (!app || typeof app !== 'object') return undefined;
  return (app as Record<string, unknown>)[section] as IncrementalSelection | undefined;
}

export function resolveEffectiveSelection(
  base: string[],
  config: SelectionConfig,
  appId: string,
  section: PortableComponentSection | 'plugins',
  normalize?: (ref: string) => string
): string[] {
  const normalizeRefs = (refs: string[]) => (normalize ? refs.map(normalize) : [...refs]);
  const configuredOverride = getApplicationSelection(config, appId, section);
  const override = configuredOverride
    ? {
        enabled: configuredOverride.enabled ? normalizeRefs(configuredOverride.enabled) : undefined,
        add: configuredOverride.add ? normalizeRefs(configuredOverride.add) : undefined,
        remove: configuredOverride.remove ? normalizeRefs(configuredOverride.remove) : undefined,
      }
    : undefined;
  return mergeIncrementalSelection(normalizeRefs(base), override);
}

function unionEffectiveSelections(
  base: string[],
  config: SelectionConfig,
  activeAppIds: string[],
  section: PortableComponentSection | 'plugins',
  normalize?: (ref: string) => string
): string[] {
  if (activeAppIds.length === 0) return normalize ? base.map(normalize) : [...base];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const appId of activeAppIds) {
    const effective = resolveEffectiveSelection(base, config, appId, section, normalize);
    for (const id of effective) {
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function collectConfiguredPortableSelections(
  config: SelectionConfig,
  activeAppIds: string[],
  normalizers: PortableSelectionNormalizers = {}
): ConfiguredPortableSelections {
  const globalPluginRefs = Array.isArray(config.plugins?.enabled)
    ? [...config.plugins.enabled]
    : [];
  const pluginRefs = unionEffectiveSelections(
    globalPluginRefs,
    config,
    activeAppIds,
    'plugins',
    normalizers.pluginRef
  );

  const componentRefs: string[] = [];
  const seen = new Set<string>();
  for (const section of COMPONENT_SECTIONS) {
    const sectionConfig = config[section] as { enabled?: string[] } | undefined;
    const base = Array.isArray(sectionConfig?.enabled) ? [...sectionConfig.enabled] : [];
    for (const id of unionEffectiveSelections(
      base,
      config,
      activeAppIds,
      section,
      normalizers.componentRef
    )) {
      if (seen.has(id)) continue;
      seen.add(id);
      componentRefs.push(id);
    }
  }

  return { pluginRefs, componentRefs };
}

export function loadConfiguredPortableSelections(
  scope?: ConfigScope,
  normalizers: PortableSelectionNormalizers = {}
): ConfiguredPortableSelections {
  const layerOptions = scopeToLayerOptions(scope);
  const { config: mergedConfig } = loadMergedSwitchboardConfig(layerOptions);
  const selectionConfig =
    scope?.profile || scope?.project ? loadWritableConfigLayer(layerOptions).config : mergedConfig;
  return collectConfiguredPortableSelections(
    selectionConfig,
    mergedConfig.applications.enabled,
    normalizers
  );
}
