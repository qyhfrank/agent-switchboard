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
const agentSyncCache: Record<
  'commands' | 'subagents',
  Record<string, { hash?: string; updatedAt?: string }>
> = {
  commands: {},
  subagents: {},
};

function getConfigSectionActive(
  section: 'commands' | 'subagents',
  options?: UpdateConfigLayerOptions
): string[] {
  const { config } = loadMergedSwitchboardConfig(options);
  return [...config[section].active];
}

export function loadLibraryStateSection(
  section: 'commands' | 'subagents',
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
  section: 'commands' | 'subagents',
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
    } else {
      const currentSubagents = (next.subagents ?? {}) as Record<string, unknown>;
      next.subagents = {
        ...currentSubagents,
        active: [...validated.active],
      } as SwitchboardConfigLayer['subagents'];
    }
    return next;
  }, layerOptions);
  agentSyncCache[section] = { ...validated.agentSync };
}

export function updateLibraryStateSection(
  section: 'commands' | 'subagents',
  mutator: (current: SectionState) => SectionState,
  scope?: ConfigScope
): SectionState {
  const current = loadLibraryStateSection(section, scope);
  const next = mutator(current);
  saveLibraryStateSection(section, next, scope);
  return loadLibraryStateSection(section, scope);
}
