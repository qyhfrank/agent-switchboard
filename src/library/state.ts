import { z } from 'zod';
import type { UpdateConfigLayerOptions } from '../config/layered-config.js';
import { loadMergedSwitchboardConfig, updateConfigLayer } from '../config/layered-config.js';
import type { SwitchboardConfigLayer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';

const agentSyncEntrySchema = z
  .object({
    hash: z.string().trim().min(1).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough();

const sectionStateSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).default([]),
    agentSync: z.record(z.string(), agentSyncEntrySchema).default({}),
  })
  .passthrough();

export type SectionState = z.infer<typeof sectionStateSchema>;
export type LibrarySection = 'commands' | 'subagents' | 'skills';

export function loadMcpActiveState(scope?: ConfigScope): string[] {
  const layerOptions = scopeToLayerOptions(scope);
  const { config } = loadMergedSwitchboardConfig(layerOptions);
  return [...config.mcp.active];
}

export function hasMcpActiveInConfig(scope?: ConfigScope): boolean {
  const layerOptions = scopeToLayerOptions(scope);
  const { layers } = loadMergedSwitchboardConfig(layerOptions);
  const checkLayer = (layer: typeof layers.user | typeof layers.profile | typeof layers.project) =>
    layer?.config?.mcp !== undefined && Array.isArray(layer.config.mcp.active);
  return checkLayer(layers.user) || checkLayer(layers.profile) || checkLayer(layers.project);
}

export function saveMcpActiveState(active: string[], scope?: ConfigScope): void {
  const layerOptions = scopeToLayerOptions(scope);
  updateConfigLayer((layer) => {
    const next: SwitchboardConfigLayer = { ...layer };
    const currentMcp = (next.mcp ?? {}) as Record<string, unknown>;
    next.mcp = {
      ...currentMcp,
      active: [...active],
    } as SwitchboardConfigLayer['mcp'];
    return next;
  }, layerOptions);
}

const agentSyncCache: Record<
  LibrarySection,
  Record<string, { hash?: string; updatedAt?: string }>
> = {
  commands: {},
  subagents: {},
  skills: {},
};

function getConfigSectionActive(
  section: LibrarySection,
  options?: UpdateConfigLayerOptions
): string[] {
  const { config } = loadMergedSwitchboardConfig(options);
  return [...config[section].active];
}

export function loadLibraryStateSection(
  section: LibrarySection,
  scope?: ConfigScope
): SectionState {
  const layerOptions = scopeToLayerOptions(scope);
  const configActive = getConfigSectionActive(section, layerOptions);
  return {
    active: configActive,
    agentSync: { ...agentSyncCache[section] },
  };
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
    if (section === 'commands') {
      const currentCommands = (next.commands ?? {}) as Record<string, unknown>;
      next.commands = {
        ...currentCommands,
        active: [...validated.active],
      } as SwitchboardConfigLayer['commands'];
    } else if (section === 'subagents') {
      const currentSubagents = (next.subagents ?? {}) as Record<string, unknown>;
      next.subagents = {
        ...currentSubagents,
        active: [...validated.active],
      } as SwitchboardConfigLayer['subagents'];
    } else {
      const currentSkills = (next.skills ?? {}) as Record<string, unknown>;
      next.skills = {
        ...currentSkills,
        active: [...validated.active],
      } as SwitchboardConfigLayer['skills'];
    }
    return next;
  }, layerOptions);
  agentSyncCache[section] = { ...validated.agentSync };
}

export function updateLibraryStateSection(
  section: LibrarySection,
  mutator: (current: SectionState) => SectionState,
  scope?: ConfigScope
): SectionState {
  const current = loadLibraryStateSection(section, scope);
  const next = mutator(current);
  saveLibraryStateSection(section, next, scope);
  return loadLibraryStateSection(section, scope);
}
