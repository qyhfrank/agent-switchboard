import { z } from 'zod';
import {
  normalizeSectionEntryIds,
  resolveScopedSectionConfig,
} from '../config/application-config.js';
import type { UpdateConfigLayerOptions } from '../config/layered-config.js';
import {
  loadMergedSwitchboardConfig,
  loadWritableConfigLayer,
  updateConfigLayer,
} from '../config/layered-config.js';
import type { SwitchboardConfigLayer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';

const appSyncEntrySchema = z
  .object({
    hash: z.string().trim().min(1).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough();

const sectionStateSchema = z
  .object({
    enabled: z.array(z.string().trim().min(1)).default([]),
    agentSync: z.record(z.string(), appSyncEntrySchema).default({}),
  })
  .passthrough();

export type SectionState = z.infer<typeof sectionStateSchema>;
export type LibrarySection = 'commands' | 'agents' | 'skills' | 'hooks';

export function loadMcpEnabledState(scope?: ConfigScope): string[] {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);
  return normalizeSectionEntryIds('mcp', [...config.mcp.enabled], scope);
}

export function hasMcpEnabledInConfig(scope?: ConfigScope): boolean {
  const layerOptions = scopeToLayerOptions(scope);
  const { layers } = loadMergedSwitchboardConfig(layerOptions);
  const checkLayer = (layer: typeof layers.user | typeof layers.profile | typeof layers.project) =>
    layer?.config?.mcp !== undefined && Array.isArray(layer.config.mcp.enabled);
  return checkLayer(layers.user) || checkLayer(layers.profile) || checkLayer(layers.project);
}

export function saveMcpEnabledState(enabled: string[], scope?: ConfigScope): void {
  const layerOptions = scopeToLayerOptions(scope);
  updateConfigLayer((layer) => {
    const next: SwitchboardConfigLayer = { ...layer };
    const currentMcp = (next.mcp ?? {}) as Record<string, unknown>;
    next.mcp = {
      ...currentMcp,
      enabled: [...enabled],
    } as SwitchboardConfigLayer['mcp'];
    return next;
  }, layerOptions);
}

const agentSyncCache: Record<
  LibrarySection,
  Record<string, { hash?: string; updatedAt?: string }>
> = {
  commands: {},
  agents: {},
  skills: {},
  hooks: {},
};

function getConfigSectionEnabled(
  section: LibrarySection,
  options?: UpdateConfigLayerOptions
): string[] {
  const { config } = loadMergedSwitchboardConfig(options);
  return normalizeSectionEntryIds(section, [...config[section].enabled], {
    profile: options?.profile,
    project: options?.projectPath,
  });
}

function getWritableConfigSectionEnabled(
  section: LibrarySection,
  options?: UpdateConfigLayerOptions
): string[] {
  const layer = loadWritableConfigLayer(options);
  const sectionConfig = (layer.config[section] ?? {}) as { enabled?: string[] };
  return Array.isArray(sectionConfig.enabled)
    ? normalizeSectionEntryIds(section, [...sectionConfig.enabled], {
        profile: options?.profile,
        project: options?.projectPath,
      })
    : [];
}

export function loadLibraryStateSection(
  section: LibrarySection,
  scope?: ConfigScope
): SectionState {
  const layerOptions = scopeToLayerOptions(scope);
  const configEnabled = getConfigSectionEnabled(section, layerOptions);
  return {
    enabled: configEnabled,
    agentSync: { ...agentSyncCache[section] },
  };
}

export function loadWritableLibraryStateSection(
  section: LibrarySection,
  scope?: ConfigScope
): SectionState {
  const layerOptions = scopeToLayerOptions(scope);
  const configEnabled = getWritableConfigSectionEnabled(section, layerOptions);
  return {
    enabled: configEnabled,
    agentSync: { ...agentSyncCache[section] },
  };
}

export function loadLibraryAgentSync(section: LibrarySection): SectionState['agentSync'] {
  return { ...agentSyncCache[section] };
}

export function saveLibraryStateSection(
  section: LibrarySection,
  state: SectionState,
  scope?: ConfigScope
): void {
  const layerOptions = scopeToLayerOptions(scope);
  const validated = sectionStateSchema.parse(state);

  updateConfigLayer((layer) => {
    const next: SwitchboardConfigLayer = { ...layer };
    const current = (next[section] ?? {}) as Record<string, unknown>;
    (next as Record<string, unknown>)[section] = {
      ...current,
      enabled: [...validated.enabled],
    };
    return next;
  }, layerOptions);
  agentSyncCache[section] = { ...validated.agentSync };
}

export function updateLibraryStateSection(
  section: LibrarySection,
  mutator: (current: SectionState) => SectionState,
  scope?: ConfigScope
): SectionState {
  const current = loadWritableLibraryStateSection(section, scope);
  const next = mutator(current);
  saveLibraryStateSection(section, next, scope);
  return loadWritableLibraryStateSection(section, scope);
}

export function updateLibraryAgentSync(
  section: LibrarySection,
  mutator: (current: SectionState['agentSync']) => SectionState['agentSync']
): SectionState['agentSync'] {
  agentSyncCache[section] = { ...mutator(loadLibraryAgentSync(section)) };
  return loadLibraryAgentSync(section);
}

/**
 * Load library state for a specific application, applying per-application overrides.
 * Merges the global section config with application-specific add/remove overrides.
 */
/** Reset in-memory agentSync cache. Call between sync phases to avoid cross-contamination. */
export function resetAgentSyncCache(): void {
  for (const section of Object.keys(agentSyncCache) as LibrarySection[]) {
    agentSyncCache[section] = {};
  }
}

export function loadLibraryStateSectionForApplication(
  section: LibrarySection,
  appId: string,
  scope?: ConfigScope
): SectionState {
  const appConfig = resolveScopedSectionConfig(section, appId, scope);
  return {
    enabled: appConfig.enabled,
    agentSync: { ...agentSyncCache[section] },
  };
}
