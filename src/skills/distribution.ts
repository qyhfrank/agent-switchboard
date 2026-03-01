import fs from 'node:fs';
import path from 'node:path';
import {
  getClaudeDir,
  getCodexDir,
  getCodexSkillsDir,
  getCursorDir,
  getGeminiDir,
  getOpencodeRoot,
  getProjectClaudeDir,
  getProjectCodexSkillsDir,
  getProjectCursorDir,
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
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { listSkillFiles, loadSkillLibrary, type SkillEntry } from './library.js';

export type SkillPlatform = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'cursor';

export const SKILL_PLATFORMS: SkillPlatform[] = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'cursor',
];

export type SkillTarget = 'claude-code' | 'agents';

export const SKILL_TARGETS: SkillTarget[] = ['claude-code', 'agents'];

const AGENTS_TARGET_PLATFORMS = ['codex', 'gemini', 'opencode'] as const;

/**
 * Check whether cursor skills should be deduped because claude-code already
 * has non-empty active skills for the same scope.  Cursor natively scans
 * `.claude/skills/`, so distributing to `.cursor/skills/` as well would
 * create duplicates.  Returning `true` means the caller should return an
 * empty selection for cursor (but keep cursor in the platforms array so
 * cleanup of orphan `.cursor/skills/` directories still executes).
 */
function shouldDedupCursorSkills(scope?: ConfigScope): boolean {
  const claudeState = loadLibraryStateSectionForApplication('skills', 'claude-code', scope);
  return claudeState.active.length > 0;
}

/**
 * Resolve parent directory containing all skills for a target/platform.
 *
 * Handles all 7 possible values across both distribution modes:
 * - `'claude-code'` -> `~/.claude/skills/`
 * - `'codex'`       -> `~/.codex/skills/`
 * - `'gemini'`      -> `~/.gemini/skills/`
 * - `'opencode'`    -> `~/.config/opencode/skill/`
 * - `'cursor'`      -> `~/.cursor/skills/`
 * - `'agents'`      -> `~/.agents/skills/`
 */
function resolveSkillsParentDir(target: string, scope?: ConfigScope): string {
  switch (target) {
    case 'claude-code':
      if (scope?.project) {
        return path.join(getProjectClaudeDir(scope.project), 'skills');
      }
      return path.join(getClaudeDir(), 'skills');
    case 'codex':
      if (scope?.project) {
        return path.join(getProjectCodexSkillsDir(scope.project));
      }
      return path.join(getCodexDir(), 'skills');
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
    case 'cursor':
      if (scope?.project) {
        return path.join(getProjectCursorDir(scope.project), 'skills');
      }
      return path.join(getCursorDir(), 'skills');
    case 'agents':
      if (scope?.project) {
        return getProjectCodexSkillsDir(scope.project);
      }
      return getCodexSkillsDir();
    default:
      throw new Error(`Unknown skill target: ${target}`);
  }
}

/**
 * Resolve target directory for a skill on a specific target.
 */
export function resolveSkillTargetDir(target: string, id: string, scope?: ConfigScope): string {
  return path.join(resolveSkillsParentDir(target, scope), id);
}

export interface SkillDistributionOutcome {
  results: BundleDistributionResult<string>[];
  /** Targets where skills were successfully distributed */
  successTargets: string[];
  /** Total skills written */
  totalWritten: number;
  /** Total skills skipped (up-to-date) */
  totalSkipped: number;
  /** Total errors */
  totalErrors: number;
}

/**
 * Distribute active skills to supported targets.
 *
 * When `useAgentsDir` is true (2-target mode):
 * - `claude-code`: uses Claude Code's per-agent active skills
 * - `agents`: uses the union of active skills across Codex, Gemini, and OpenCode
 * - Legacy platform-specific paths (gemini, opencode) are cleaned up
 *
 * When `useAgentsDir` is false (default, 4-target mode):
 * - Distributes to each platform individually: claude-code, codex, gemini, opencode
 * - Only cleans up OpenCode's legacy plural `skills/` path
 */
export function distributeSkills(
  scope?: ConfigScope,
  options?: { useAgentsDir?: boolean }
): SkillDistributionOutcome {
  const useAgentsDir = options?.useAgentsDir ?? false;
  const entries = loadSkillLibrary();

  if (useAgentsDir) {
    return distributeAgentsMode(entries, scope);
  }
  return distributeLegacyMode(entries, scope);
}

/**
 * 2-target mode: claude-code + agents
 */
function distributeAgentsMode(
  entries: SkillEntry[],
  scope?: ConfigScope
): SkillDistributionOutcome {
  const cleanup: BundleCleanupConfig<string> = {
    resolveParentDir: (target) => resolveSkillsParentDir(target, scope),
  };

  const filterSelected = (target: string, allEntries: SkillEntry[]): SkillEntry[] => {
    if (target === 'cursor') {
      if (shouldDedupCursorSkills(scope)) return [];
      const state = loadLibraryStateSectionForApplication('skills', target, scope);
      const activeIds = new Set(state.active);
      return allEntries.filter((e) => activeIds.has(e.id));
    }
    if (target === 'agents') {
      const unionIds = new Set<string>();
      for (const agentId of AGENTS_TARGET_PLATFORMS) {
        const state = loadLibraryStateSectionForApplication('skills', agentId, scope);
        for (const id of state.active) {
          unionIds.add(id);
        }
      }
      return allEntries.filter((e) => unionIds.has(e.id));
    }
    const state = loadLibraryStateSectionForApplication('skills', target, scope);
    const activeIds = new Set(state.active);
    return allEntries.filter((e) => activeIds.has(e.id));
  };

  const outcome: DistributeBundleOutcome<string> = distributeBundle<SkillEntry, string>({
    section: 'skills',
    selected: entries,
    platforms: [...SKILL_TARGETS, 'cursor'] as string[],
    resolveTargetDir: (target, entry) => resolveSkillTargetDir(target, entry.id, scope),
    listFiles: listSkillFiles,
    getId: (entry) => entry.id,
    cleanup,
    scope,
    filterSelected,
  });

  // Legacy cleanup: remove platform-specific paths that are no longer needed
  // in agents mode (gemini, opencode wrote their own paths in older versions).
  const legacyDirs = [
    path.join(getGeminiDir(), 'skills'),
    path.join(getOpencodeRoot(), 'skill'),
    path.join(getOpencodeRoot(), 'skills'),
    ...(scope?.project
      ? [
          path.join(getProjectGeminiDir(scope.project), 'skills'),
          path.join(getProjectOpencodeRoot(scope.project), 'skill'),
          path.join(getProjectOpencodeRoot(scope.project), 'skills'),
        ]
      : []),
  ];

  for (const legacyDir of legacyDirs) {
    if (fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory()) {
      fs.rmSync(legacyDir, { recursive: true });
      outcome.results.push({
        platform: 'agents',
        targetDir: legacyDir,
        status: 'deleted',
        reason: 'legacy platform-specific path',
      });
    }
  }

  return summarize(outcome);
}

/**
 * 5-target mode: claude-code, codex, gemini, opencode, cursor (legacy compatible)
 */
function distributeLegacyMode(
  entries: SkillEntry[],
  scope?: ConfigScope
): SkillDistributionOutcome {
  const cleanup: BundleCleanupConfig<string> = {
    resolveParentDir: (target) => resolveSkillsParentDir(target, scope),
  };

  const filterSelected = (target: string, allEntries: SkillEntry[]): SkillEntry[] => {
    if (target === 'cursor') {
      if (shouldDedupCursorSkills(scope)) return [];
    }
    const state = loadLibraryStateSectionForApplication('skills', target, scope);
    const activeIds = new Set(state.active);
    return allEntries.filter((e) => activeIds.has(e.id));
  };

  const outcome: DistributeBundleOutcome<string> = distributeBundle<SkillEntry, string>({
    section: 'skills',
    selected: entries,
    platforms: SKILL_PLATFORMS as string[],
    resolveTargetDir: (target, entry) => resolveSkillTargetDir(target, entry.id, scope),
    listFiles: listSkillFiles,
    getId: (entry) => entry.id,
    cleanup,
    scope,
    filterSelected,
  });

  // Legacy cleanup: only clean OpenCode's plural `skills/` path (original behavior)
  const legacyDirs = [
    path.join(getOpencodeRoot(), 'skills'),
    ...(scope?.project ? [path.join(getProjectOpencodeRoot(scope.project), 'skills')] : []),
  ];

  for (const legacyDir of legacyDirs) {
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

  return summarize(outcome);
}

function summarize(outcome: DistributeBundleOutcome<string>): SkillDistributionOutcome {
  const successTargets = new Set<string>();
  let totalWritten = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const result of outcome.results) {
    if (result.status === 'written') {
      successTargets.add(result.platform);
      totalWritten++;
    } else if (result.status === 'skipped') {
      successTargets.add(result.platform);
      totalSkipped++;
    } else {
      totalErrors++;
    }
  }

  return {
    results: outcome.results,
    successTargets: [...successTargets],
    totalWritten,
    totalSkipped,
    totalErrors,
  };
}
