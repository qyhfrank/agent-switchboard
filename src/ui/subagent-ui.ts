import type { ConfigScope } from '../config/scope.js';
import { loadSubagentLibrary, type SubagentEntry } from '../subagents/library.js';
import { type GenericSelectionResult, showLibrarySelector } from './library-selector.js';

export type SubagentSelectionResult = GenericSelectionResult;

export async function showSubagentSelector(
  scope?: ConfigScope
): Promise<SubagentSelectionResult | null> {
  return showLibrarySelector<SubagentEntry>({
    section: 'subagents',
    noun: 'subagent',
    emptyHint: 'asb subagent load <platform> [path] [-r]',
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
      const m1 = cc?.model as unknown as string | undefined;
      const m2 = oc?.model as unknown as string | undefined;
      return typeof m1 === 'string' && m1.trim().length > 0
        ? m1
        : typeof m2 === 'string' && m2.trim().length > 0
          ? m2
          : undefined;
    },
    scope,
  });
}
