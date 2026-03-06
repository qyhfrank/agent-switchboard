import path from 'node:path';
import type { ConfigScope } from '../config/scope.js';
import {
  type CleanupConfig,
  type DistributeOutcome,
  type DistributionResult,
  distributeLibrary,
} from '../library/distribute.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { filterInstalled, getTargetById, getTargetsForSection } from '../targets/registry.js';
import type { TargetLibraryHandler } from '../targets/types.js';
import { type CommandEntry, loadCommandLibrary } from './library.js';

export interface CommandDistributionResult {
  platform: string;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export type CommandDistributionOutcome = DistributeOutcome<string>;

export function resolveCommandFilePath(platform: string, id: string, scope?: ConfigScope): string {
  const target = getTargetById(platform);
  if (!target?.commands) {
    throw new Error(`Unknown command platform: ${platform}`);
  }
  const h = target.commands;
  return path.join(h.resolveTargetDir(scope), h.getFilename(id));
}

export function distributeCommands(scope?: ConfigScope): CommandDistributionOutcome {
  const entries = loadCommandLibrary();
  const byId = new Map(entries.map((e) => [e.id, e]));

  const targets = filterInstalled(getTargetsForSection('commands'));
  const handlerMap = new Map<string, TargetLibraryHandler>(targets.map((t) => [t.id, t.commands!]));
  const platforms = targets.map((t) => t.id);

  const cleanup: CleanupConfig<string> = {
    resolveTargetDir: (p) => handlerMap.get(p)!.resolveTargetDir(scope),
    extractId: (filename) => {
      if (filename.endsWith('.toml')) return filename.slice(0, -5);
      if (filename.endsWith('.md')) return filename.slice(0, -3);
      return null;
    },
  };

  const filterSelected = (platform: string, _allEntries: CommandEntry[]): CommandEntry[] => {
    const state = loadLibraryStateSectionForApplication('commands', platform, scope);
    const activeIds = state.enabled;
    const selected: CommandEntry[] = [];
    for (const id of activeIds) {
      const e = byId.get(id);
      if (e) selected.push(e);
    }
    return selected;
  };

  const outcome = distributeLibrary<CommandEntry, string>({
    section: 'commands',
    selected: entries,
    platforms,
    resolveFilePath: (p, e) => {
      const h = handlerMap.get(p)!;
      return path.join(h.resolveTargetDir(scope), h.getFilename(e.id));
    },
    render: (p, e) => handlerMap.get(p)!.render(e),
    getId: (e) => e.id,
    cleanup,
    scope,
    filterSelected,
  }) as { results: DistributionResult<string>[] };

  const codexWrites = outcome.results.filter(
    (r) => r.platform === 'codex' && r.status === 'written'
  );
  if (codexWrites.length > 0) {
    console.warn(
      '[codex] Custom prompts are deprecated. Consider migrating to skills: https://developers.openai.com/codex/skills'
    );
  }

  return outcome;
}
