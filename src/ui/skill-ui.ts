import type { ConfigScope } from '../config/scope.js';
import { loadSkillLibrary, type SkillEntry } from '../skills/library.js';
import { type GenericSelectionResult, showLibrarySelector } from './library-selector.js';

export interface SkillSelectorOptions {
  scope?: ConfigScope;
  pageSize?: number;
}

/**
 * Show interactive skill selector UI.
 */
export async function showSkillSelector(
  options?: SkillSelectorOptions
): Promise<GenericSelectionResult | null> {
  return showLibrarySelector<SkillEntry>({
    section: 'skills',
    emptyHint: 'asb skill load <platform> [path]',
    loadEntries: loadSkillLibrary,
    getId: (e) => e.id,
    getTitle: (e) => e.metadata.name,
    getDescription: (e) => e.metadata.description,
    noun: 'skill',
    allowOrdering: false,
    scope: options?.scope,
    pageSize: options?.pageSize,
  });
}
