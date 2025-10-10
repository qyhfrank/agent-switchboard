import { type CommandEntry, loadCommandLibrary } from '../commands/library.js';
import type { ConfigScope } from '../config/scope.js';
import { type GenericSelectionResult, showLibrarySelector } from './library-selector.js';

export type CommandSelectionResult = GenericSelectionResult;

export async function showCommandSelector(
  scope?: ConfigScope
): Promise<CommandSelectionResult | null> {
  return showLibrarySelector<CommandEntry>({
    section: 'commands',
    noun: 'command',
    emptyHint: 'asb command load <platform> [path] [-r]',
    allowOrdering: false,
    loadEntries: () => loadCommandLibrary(),
    getId: (e) => e.id,
    getTitle: (e) => {
      const t = (e.metadata as Record<string, unknown>).title as unknown;
      return typeof t === 'string' && t.trim().length > 0 ? t : e.id;
    },
    getModel: (e) => {
      const extras = e.metadata.extras as Record<string, unknown> | undefined;
      const cc = (extras?.['claude-code'] as Record<string, unknown>) ?? undefined;
      const m = cc?.model as unknown as string | undefined;
      return typeof m === 'string' && m.trim().length > 0 ? m : undefined;
    },
    scope,
  });
}
