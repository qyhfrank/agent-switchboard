import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import {
  type CleanupConfig,
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
  type LibraryManagedOptions,
} from '../library/distribute.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { filterInstalled, getTargetById, getTargetsForSection } from '../targets/registry.js';
import { isCustomAgentsHandler, type TargetLibraryHandler } from '../targets/types.js';
import { loadSubagentLibrary, type SubagentEntry } from './library.js';

export interface SubagentDistributionResult {
  platform: string;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export type SubagentDistributionOutcome = DistributeOutcome<string>;

export function resolveSubagentFilePath(platform: string, id: string, scope?: ConfigScope): string {
  const target = getTargetById(platform);
  if (!target?.agents) {
    throw new Error(`Unknown subagent platform: ${platform}`);
  }
  if (isCustomAgentsHandler(target.agents)) {
    throw new Error(`Platform ${platform} uses custom agents distribution`);
  }
  const h = target.agents as TargetLibraryHandler;
  return path.join(h.resolveTargetDir(scope), h.getFilename(id));
}

export function distributeSubagents(
  scope?: ConfigScope,
  activeAppIds?: string[],
  assumeInstalled?: ReadonlySet<string>,
  managedOptions?: LibraryManagedOptions
): SubagentDistributionOutcome {
  const entries = loadSubagentLibrary(scope);
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Enumerate ALL installed targets so cleanup runs for inactive platforms too
  const allInstalledTargets = filterInstalled(getTargetsForSection('agents'), assumeInstalled);
  const activeSet = activeAppIds ? new Set(activeAppIds) : null;

  const withAgents = allInstalledTargets.filter((t) => t.agents != null);
  const libraryTargets = withAgents.filter((t) => t.agents && !isCustomAgentsHandler(t.agents));
  const customTargets = withAgents.filter((t) => t.agents && isCustomAgentsHandler(t.agents));
  const activeCustomTargets = activeSet
    ? customTargets.filter((t) => activeSet.has(t.id))
    : customTargets;
  const inactiveCustomTargets = activeSet ? customTargets.filter((t) => !activeSet.has(t.id)) : [];

  const handlerMap = new Map<string, TargetLibraryHandler>(
    libraryTargets.flatMap((t) =>
      t.agents && !isCustomAgentsHandler(t.agents) ? [[t.id, t.agents] as const] : []
    )
  );
  const libraryPlatforms = libraryTargets.map((t) => t.id);

  const getHandler = (p: string): TargetLibraryHandler => {
    const h = handlerMap.get(p);
    if (!h) throw new Error(`Missing agents handler for platform: ${p}`);
    return h;
  };

  const cleanup: CleanupConfig<string> = {
    resolveTargetDir: (p) => getHandler(p).resolveTargetDir(scope),
    extractId: (filename) => {
      if (!filename.endsWith('.md')) return null;
      return filename.slice(0, -3);
    },
  };

  const filterSelected = (platform: string, _allEntries: SubagentEntry[]): SubagentEntry[] => {
    // Inactive platform: return empty to trigger orphan cleanup
    if (activeSet && !activeSet.has(platform)) return [];
    const state = loadLibraryStateSectionForApplication('agents', platform, scope);
    const selected: SubagentEntry[] = [];
    for (const id of state.enabled) {
      const e = byId.get(id);
      if (e) selected.push(e);
    }
    return selected;
  };

  const markdownOutcome = distributeLibrary<SubagentEntry, string>({
    section: 'agents',
    selected: entries,
    platforms: libraryPlatforms,
    resolveFilePath: (p, e) => {
      const h = getHandler(p);
      return path.join(h.resolveTargetDir(scope), h.getFilename(e.id));
    },
    render: (p, e) => getHandler(p).render(e),
    getId: (e) => e.id,
    cleanup,
    scope,
    filterSelected,
    manifest: managedOptions?.manifest,
    projectMode: managedOptions?.projectMode,
    collision: managedOptions?.collision,
  });

  const customResults: DistributionResult<string>[] = [];
  for (const target of activeCustomTargets) {
    if (target.agents && isCustomAgentsHandler(target.agents)) {
      const results = target.agents.distribute(entries, byId, scope);
      customResults.push(...results);
    }
  }
  // Inactive custom targets: pass empty map to trigger cleanup (orphan removal)
  for (const target of inactiveCustomTargets) {
    if (target.agents && isCustomAgentsHandler(target.agents)) {
      const results = target.agents.distribute([], new Map(), scope);
      customResults.push(...results);
    }
  }

  return {
    results: [...markdownOutcome.results, ...customResults] as DistributionResult<string>[],
  };
}
