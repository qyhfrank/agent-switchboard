import type { ConfigScope } from '../config/scope.js';
import { loadSubagentLibrary, type SubagentEntry } from '../subagents/library.js';
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
    loadEntries: () => loadSubagentLibrary(),
    getId: (e) => e.id,
    getTitle: (e) => {
      const t = (e.metadata as Record<string, unknown>).title as unknown;
      return typeof t === 'string' && t.trim().length > 0 ? t : e.id;
    },
    getModel: (e) => {
      const extras = e.metadata.extras as Record<string, unknown> | undefined;
      const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
      const oc = (extras?.opencode as Record<string, unknown>) ?? undefined;
      const cu = (extras?.cursor as Record<string, unknown>) ?? undefined;
      const m1 = cc?.model as unknown as string | undefined;
      const m2 = oc?.model as unknown as string | undefined;
      const m3 = cu?.model as unknown as string | undefined;
      return typeof m1 === 'string' && m1.trim().length > 0
        ? m1
        : typeof m2 === 'string' && m2.trim().length > 0
          ? m2
          : typeof m3 === 'string' && m3.trim().length > 0
            ? m3
            : undefined;
    },
    scope: options?.scope,
    pageSize: options?.pageSize,
  });
}
