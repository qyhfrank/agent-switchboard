import type { ConfigScope } from '../config/scope.js';
import { loadSubagentLibrary, type SubagentEntry } from '../subagents/library.js';
import { PLATFORM_PRIORITY, pickFirstPlatformString } from '../util/extras.js';
import { type GenericSelectionResult, showLibrarySelector } from './library-selector.js';

export type SubagentSelectionResult = GenericSelectionResult;

export interface SubagentSelectorOptions {
  scope?: ConfigScope;
  pageSize?: number;
}

export async function showSubagentSelector(
  options?: SubagentSelectorOptions
): Promise<SubagentSelectionResult | null> {
  return showLibrarySelector<SubagentEntry>({
    section: 'agents',
    noun: 'agent',
    emptyHint: 'asb agent load <platform> [path] [-r]',
    allowOrdering: false,
    loadEntries: () => loadSubagentLibrary(options?.scope),
    getId: (e) => e.id,
    getTitle: (e) => {
      const t = (e.metadata as Record<string, unknown>).title as unknown;
      return typeof t === 'string' && t.trim().length > 0 ? t : e.id;
    },
    getModel: (e) =>
      pickFirstPlatformString(e.metadata.extras, [...PLATFORM_PRIORITY], 'model') ?? undefined,
    scope: options?.scope,
    pageSize: options?.pageSize,
  });
}
