import path from 'node:path';
import { getClaudeDir, getCodexDir, getProjectClaudeDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type BundleDistributionResult,
  type DistributeBundleOutcome,
  distributeBundle,
} from '../library/distribute-bundle.js';
import { loadLibraryStateSection } from '../library/state.js';
import { listSkillFiles, loadSkillLibrary, type SkillEntry } from './library.js';

export type SkillPlatform = 'claude-code' | 'codex';

export const SKILL_PLATFORMS: SkillPlatform[] = ['claude-code', 'codex'];

/**
 * Resolve target directory for a skill on a specific platform.
 */
export function resolveSkillTargetDir(
  platform: SkillPlatform,
  id: string,
  scope?: ConfigScope
): string {
  switch (platform) {
    case 'claude-code':
      if (scope?.project) {
        return path.join(getProjectClaudeDir(scope.project), 'skills', id);
      }
      return path.join(getClaudeDir(), 'skills', id);
    case 'codex':
      // Codex only supports global skills
      return path.join(getCodexDir(), 'skills', id);
  }
}

export interface SkillDistributionOutcome {
  results: BundleDistributionResult<SkillPlatform>[];
  /** Platforms where skills were successfully distributed */
  successPlatforms: SkillPlatform[];
  /** Total skills written */
  totalWritten: number;
  /** Total skills skipped (up-to-date) */
  totalSkipped: number;
  /** Total errors */
  totalErrors: number;
}

/**
 * Distribute active skills to supported platforms.
 */
export function distributeSkills(scope?: ConfigScope): SkillDistributionOutcome {
  const entries = loadSkillLibrary();
  const state = loadLibraryStateSection('skills', scope);
  const activeIds = new Set(state.active);

  // Filter to active skills
  const selected = entries.filter((e) => activeIds.has(e.id));

  const outcome: DistributeBundleOutcome<SkillPlatform> = distributeBundle<
    SkillEntry,
    SkillPlatform
  >({
    section: 'skills',
    selected,
    platforms: SKILL_PLATFORMS,
    resolveTargetDir: (platform, entry) => resolveSkillTargetDir(platform, entry.id, scope),
    listFiles: listSkillFiles,
    getId: (entry) => entry.id,
    scope,
  });

  // Calculate summary
  const successPlatforms = new Set<SkillPlatform>();
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const result of outcome.results) {
    if (result.status === 'written') {
      successPlatforms.add(result.platform);
      totalWritten++;
    } else if (result.status === 'skipped') {
      successPlatforms.add(result.platform);
      totalSkipped++;
    } else {
      totalErrors++;
    }
  }

  return {
    results: outcome.results,
    successPlatforms: [...successPlatforms],
    totalWritten,
    totalSkipped,
    totalErrors,
  };
}
