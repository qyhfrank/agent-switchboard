import type { ConfigScope } from '../config/scope.js';
import { type HookEntry, loadHookLibrary } from '../hooks/library.js';
import { type GenericSelectionResult, showLibrarySelector } from './library-selector.js';

export type HookSelectionResult = GenericSelectionResult;

export interface HookSelectorOptions {
  scope?: ConfigScope;
  pageSize?: number;
}

export async function showHookSelector(
  options?: HookSelectorOptions
): Promise<HookSelectionResult | null> {
  return showLibrarySelector<HookEntry>({
    section: 'hooks',
    noun: 'hook',
    emptyHint: 'asb hook load <path>',
    allowOrdering: false,
    loadEntries: () => loadHookLibrary(),
    getId: (e) => e.id,
    getTitle: (e) => e.name ?? e.id,
    getDescription: (e) => e.description,
    scope: options?.scope,
    pageSize: options?.pageSize,
  });
}
