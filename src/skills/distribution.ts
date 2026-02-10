import fs from 'node:fs';
import path from 'node:path';
import {
  getClaudeDir,
  getCodexSkillsDir,
  getGeminiDir,
  getOpencodeRoot,
  getProjectClaudeDir,
  getProjectCodexSkillsDir,
  getProjectGeminiDir,
  getProjectOpencodeRoot,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type BundleCleanupConfig,
  type BundleDistributionResult,
  type DistributeBundleOutcome,
  distributeBundle,
} from '../library/distribute-bundle.js';
import { loadLibraryStateSectionForAgent } from '../library/state.js';
import { listSkillFiles, loadSkillLibrary, type SkillEntry } from './library.js';

export type SkillPlatform = 'claude-code' | 'codex' | 'gemini' | 'opencode';

export const SKILL_PLATFORMS: SkillPlatform[] = ['claude-code', 'codex', 'gemini', 'opencode'];

/**
 * Map platform to agent ID for per-agent configuration lookup
 */
function platformToAgentId(platform: SkillPlatform): string {
  return platform;
}

/**
 * Resolve parent directory containing all skills for a platform.
 */
function resolveSkillsParentDir(platform: SkillPlatform, scope?: ConfigScope): string {
  switch (platform) {
    case 'claude-code':
      if (scope?.project) {
        return path.join(getProjectClaudeDir(scope.project), 'skills');
      }
      return path.join(getClaudeDir(), 'skills');
    case 'codex':
      if (scope?.project) {
        return getProjectCodexSkillsDir(scope.project);
      }
      return getCodexSkillsDir();
    case 'gemini':
      if (scope?.project) {
        return path.join(getProjectGeminiDir(scope.project), 'skills');
      }
      return path.join(getGeminiDir(), 'skills');
    case 'opencode':
      if (scope?.project) {
        return path.join(getProjectOpencodeRoot(scope.project), 'skill');
      }
      return path.join(getOpencodeRoot(), 'skill');
  }
}

/**
 * Resolve target directory for a skill on a specific platform.
 */
export function resolveSkillTargetDir(
  platform: SkillPlatform,
  id: string,
  scope?: ConfigScope
): string {
  return path.join(resolveSkillsParentDir(platform, scope), id);
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
 * Supports per-agent configuration where each agent can have different active skills.
 */
export function distributeSkills(scope?: ConfigScope): SkillDistributionOutcome {
  const entries = loadSkillLibrary();

  // Cleanup config to remove orphan skill directories
  const cleanup: BundleCleanupConfig<SkillPlatform> = {
    resolveParentDir: (platform) => resolveSkillsParentDir(platform, scope),
  };

  // Filter entries based on per-agent configuration
  const filterSelected = (platform: SkillPlatform, allEntries: SkillEntry[]): SkillEntry[] => {
    const agentId = platformToAgentId(platform);
    const state = loadLibraryStateSectionForAgent('skills', agentId, scope);
    const activeIds = new Set(state.active);
    return allEntries.filter((e) => activeIds.has(e.id));
  };

  const outcome: DistributeBundleOutcome<SkillPlatform> = distributeBundle<
    SkillEntry,
    SkillPlatform
  >({
    section: 'skills',
    selected: entries, // Pass all entries, filtering happens per-platform
    platforms: SKILL_PLATFORMS,
    resolveTargetDir: (platform, entry) => resolveSkillTargetDir(platform, entry.id, scope),
    listFiles: listSkillFiles,
    getId: (entry) => entry.id,
    cleanup,
    scope,
    filterSelected,
  });

  // Remove legacy OpenCode `skills/` (plural) directories left by earlier versions.
  // OpenCode uses singular `skill/`; the plural form is rejected by its INVALID_DIRS guard.
  const legacyOpencodeDirs = [
    path.join(getOpencodeRoot(), 'skills'),
    ...(scope?.project ? [path.join(getProjectOpencodeRoot(scope.project), 'skills')] : []),
  ];
  for (const legacyDir of legacyOpencodeDirs) {
    if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory()) {
      fs.rmSync(legacyDir, { recursive: true });
      outcome.results.push({
        platform: 'opencode',
        targetDir: legacyDir,
        status: 'deleted',
        reason: 'legacy plural path',
      });
    }
  }

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
