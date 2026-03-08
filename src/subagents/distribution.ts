import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import {
  type CleanupConfig,
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
} from '../library/distribute.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import {
  filterInstalled,
  getActiveTargetsForSection,
  getTargetById,
  getTargetsForSection,
} from '../targets/registry.js';
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
  activeAppIds?: string[]
): SubagentDistributionOutcome {
  const entries = loadSubagentLibrary();
  const byId = new Map(entries.map((e) => [e.id, e]));

  const allTargets = filterInstalled(
    activeAppIds
      ? getActiveTargetsForSection('agents', activeAppIds)
      : getTargetsForSection('agents')
  );

  const libraryTargets = allTargets.filter((t) => !isCustomAgentsHandler(t.agents!));
  const customTargets = allTargets.filter((t) => isCustomAgentsHandler(t.agents!));

  const handlerMap = new Map<string, TargetLibraryHandler>(
    libraryTargets.map((t) => [t.id, t.agents! as TargetLibraryHandler])
  );
  const libraryPlatforms = libraryTargets.map((t) => t.id);

  const cleanup: CleanupConfig<string> = {
    resolveTargetDir: (p) => handlerMap.get(p)!.resolveTargetDir(scope),
    extractId: (filename) => {
      if (!filename.endsWith('.md')) return null;
      return filename.slice(0, -3);
    },
  };

  const filterSelected = (platform: string, _allEntries: SubagentEntry[]): SubagentEntry[] => {
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
      const h = handlerMap.get(p)!;
      return path.join(h.resolveTargetDir(scope), h.getFilename(e.id));
    },
    render: (p, e) => handlerMap.get(p)!.render(e),
    getId: (e) => e.id,
    cleanup,
    scope,
    filterSelected,
  });

  const customResults: DistributionResult<string>[] = [];
  for (const target of customTargets) {
    if (isCustomAgentsHandler(target.agents!)) {
      const results = target.agents.distribute(entries, byId, scope);
      customResults.push(...results);
    }
  }

  return {
    results: [...markdownOutcome.results, ...customResults] as DistributionResult<string>[],
  };
}
