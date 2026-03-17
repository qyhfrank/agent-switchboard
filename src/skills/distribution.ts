import fs from 'node:fs';
import path from 'node:path';
import {
  getCodexSkillsDir,
  getGeminiDir,
  getOpencodeRoot,
  getProjectCodexSkillsDir,
  getProjectGeminiDir,
  getProjectOpencodeRoot,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  type BundleCleanupConfig,
  type BundleCollisionPolicy,
  type BundleDistributionResult,
  type BundleProjectMode,
  type DistributeBundleOutcome,
  distributeBundle,
} from '../library/distribute-bundle.js';
import { isDir } from '../library/fs.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import type { ProjectDistributionManifest } from '../manifest/types.js';
import { cleanupLegacyOpencodeBundles } from '../targets/builtin/opencode-legacy.js';
import { filterInstalled, getTargetsForSection } from '../targets/registry.js';
import { listSkillFiles, loadSkillLibrary, type SkillEntry } from './library.js';

export type SkillTarget = 'claude-code' | 'agents';

const AGENTS_TARGET_PLATFORMS = ['codex', 'gemini', 'opencode'] as const;

function shouldDedupCursorSkills(
  scope: ConfigScope | undefined,
  activeSet: Set<string> | null
): boolean {
  // Only dedup Cursor skills when claude-code is also being synced (full sync or explicit)
  if (activeSet && !activeSet.has('claude-code')) return false;
  const claudeState = loadLibraryStateSectionForApplication('skills', 'claude-code', scope);
  return claudeState.enabled.length > 0;
}

/**
 * Resolve parent directory containing all skills for a target/platform.
 * For registered targets, delegates to the target's skills handler.
 * The 'agents' virtual target is handled specially.
 */
function resolveSkillsParentDir(target: string, scope?: ConfigScope): string {
  if (target === 'agents') {
    if (scope?.project) return getProjectCodexSkillsDir(scope.project);
    return getCodexSkillsDir();
  }
  const t = getTargetsForSection('skills').find((x) => x.id === target);
  if (t?.skills) return t.skills.resolveParentDir(scope);
  throw new Error(`Unknown skill target: ${target}`);
}

export function resolveSkillTargetDir(target: string, id: string, scope?: ConfigScope): string {
  return path.join(resolveSkillsParentDir(target, scope), id);
}

export interface SkillDistributionOutcome {
  results: BundleDistributionResult<string>[];
  successTargets: string[];
  totalWritten: number;
  totalSkipped: number;
  totalErrors: number;
}

export function distributeSkills(
  scope?: ConfigScope,
  options?: {
    useAgentsDir?: boolean;
    activeAppIds?: string[];
    assumeInstalled?: ReadonlySet<string>;
    manifest?: ProjectDistributionManifest;
    projectMode?: BundleProjectMode;
    collision?: BundleCollisionPolicy;
    dryRun?: boolean;
  }
): SkillDistributionOutcome {
  const entries = loadSkillLibrary(scope);
  const activeAppIds = options?.activeAppIds;
  // Enumerate ALL installed targets so cleanup runs for inactive platforms too
  const allSkillTargets = filterInstalled(getTargetsForSection('skills'), options?.assumeInstalled);
  const activeSet = activeAppIds ? new Set(activeAppIds) : null;

  if (options?.useAgentsDir ?? false) {
    const traePlatforms = allSkillTargets
      .filter((t) => t.id === 'trae' || t.id === 'trae-cn')
      .map((t) => t.id);
    const cursorPlatform = allSkillTargets.find((t) => t.id === 'cursor') ? ['cursor'] : [];
    // Include all platforms; filterSelected handles activity check
    const claudeCodePlatform = allSkillTargets.find((t) => t.id === 'claude-code')
      ? ['claude-code']
      : [];
    const platforms = [...claudeCodePlatform, 'agents', ...cursorPlatform, ...traePlatforms];
    return distributeSkillsInternal(entries, scope, {
      platforms,
      activeSet,
      legacyDirs: [
        { path: path.join(getGeminiDir(), 'skills'), platform: 'agents' },
        {
          path: path.join(getOpencodeRoot(), 'skill'),
          platform: 'agents',
          cleanupMode: 'duplicates' as const,
        },
        ...(scope?.project
          ? [
              { path: path.join(getProjectGeminiDir(scope.project), 'skills'), platform: 'agents' },
              {
                path: path.join(getProjectOpencodeRoot(scope.project), 'skill'),
                platform: 'agents',
                cleanupMode: 'duplicates' as const,
              },
            ]
          : []),
      ],
      manifest: options?.manifest,
      projectMode: options?.projectMode,
      collision: options?.collision,
      dryRun: options?.dryRun,
    });
  }

  return distributeSkillsInternal(entries, scope, {
    platforms: allSkillTargets.map((t) => t.id),
    activeSet,
    legacyDirs: [
      {
        path: path.join(getOpencodeRoot(), 'skill'),
        platform: 'opencode',
        cleanupMode: 'duplicates' as const,
      },
      ...(scope?.project
        ? [
            {
              path: path.join(getProjectOpencodeRoot(scope.project), 'skill'),
              platform: 'opencode',
              cleanupMode: 'duplicates' as const,
            },
          ]
        : []),
    ],
    manifest: options?.manifest,
    projectMode: options?.projectMode,
    collision: options?.collision,
    dryRun: options?.dryRun,
  });
}

function isReservedDir(id: string, platform: string): boolean {
  const t = getTargetsForSection('skills').find((x) => x.id === platform);
  return t?.skills?.isReservedDir?.(id) ?? false;
}

interface LegacyDirSpec {
  path: string;
  platform: string;
  cleanupMode?: 'empty-only' | 'duplicates';
}

function isSafeEmptyDir(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function distributeSkillsInternal(
  entries: SkillEntry[],
  scope: ConfigScope | undefined,
  options: {
    platforms: string[];
    activeSet: Set<string> | null;
    legacyDirs: LegacyDirSpec[];
    manifest?: ProjectDistributionManifest;
    projectMode?: BundleProjectMode;
    collision?: BundleCollisionPolicy;
    dryRun?: boolean;
  }
): SkillDistributionOutcome {
  const traeActiveIds = scope?.project
    ? new Map(
        (['trae', 'trae-cn'] as const).map((v) => [
          v,
          new Set(loadLibraryStateSectionForApplication('skills', v, scope).enabled),
        ])
      )
    : null;

  const cleanup: BundleCleanupConfig<string> = {
    resolveParentDir: (target) => resolveSkillsParentDir(target, scope),
    isReservedDir: (id, platform) => {
      if (isReservedDir(id, platform)) return true;
      if (platform === 'agents' && id === '.system') return true;
      if (traeActiveIds && (platform === 'trae' || platform === 'trae-cn')) {
        const other = platform === 'trae' ? 'trae-cn' : 'trae';
        return traeActiveIds.get(other)?.has(id) ?? false;
      }
      return false;
    },
  };

  const { activeSet } = options;

  const filterSelected = (target: string, allEntries: SkillEntry[]): SkillEntry[] => {
    // Inactive platform: return empty to trigger orphan cleanup
    if (activeSet) {
      if (target === 'agents') {
        if (!AGENTS_TARGET_PLATFORMS.some((a) => activeSet.has(a))) return [];
      } else if (!activeSet.has(target)) {
        return [];
      }
    }
    if (target === 'cursor') {
      if (shouldDedupCursorSkills(scope, activeSet)) return [];
      const state = loadLibraryStateSectionForApplication('skills', target, scope);
      return allEntries.filter((e) => new Set(state.enabled).has(e.id));
    }
    if (target === 'agents') {
      const unionIds = new Set<string>();
      // Only include skills for active agent platforms
      const activeAgentPlatforms = activeSet
        ? AGENTS_TARGET_PLATFORMS.filter((a) => activeSet.has(a))
        : AGENTS_TARGET_PLATFORMS;
      for (const agentId of activeAgentPlatforms) {
        for (const id of loadLibraryStateSectionForApplication('skills', agentId, scope).enabled) {
          unionIds.add(id);
        }
      }
      return allEntries.filter((e) => unionIds.has(e.id));
    }
    const state = loadLibraryStateSectionForApplication('skills', target, scope);
    return allEntries.filter((e) => new Set(state.enabled).has(e.id));
  };

  const outcome = distributeBundle<SkillEntry, string>({
    section: 'skills',
    selected: entries,
    platforms: options.platforms,
    resolveTargetDir: (target, entry) => resolveSkillTargetDir(target, entry.id, scope),
    listFiles: listSkillFiles,
    getId: (entry) => entry.id,
    cleanup,
    scope,
    filterSelected,
    manifest: options.manifest,
    projectMode: options.projectMode,
    collision: options.collision,
    dryRun: options.dryRun,
  });

  for (const { path: legacyDir, platform, cleanupMode } of options.legacyDirs) {
    if (cleanupMode === 'duplicates') {
      const activeIds = new Set(filterSelected(platform, entries).map((entry) => entry.id));
      outcome.results.push(
        ...cleanupLegacyOpencodeBundles({
          platform,
          legacyParentDir: legacyDir,
          currentParentDir: resolveSkillsParentDir(platform, scope),
          activeIds,
          dryRun: options.dryRun,
          isReservedDir: (id) => cleanup.isReservedDir?.(id, platform) ?? false,
        })
      );
      continue;
    }

    if (!isDir(legacyDir)) continue;
    if (isSafeEmptyDir(legacyDir)) {
      if (!options.dryRun) fs.rmSync(legacyDir, { recursive: true });
      outcome.results.push({
        platform,
        targetDir: legacyDir,
        status: 'deleted',
        reason:
          platform === 'agents'
            ? 'empty legacy platform-specific path'
            : 'empty legacy plural path',
      });
      continue;
    }

    outcome.results.push({
      platform,
      targetDir: legacyDir,
      status: 'skipped',
      reason: 'legacy path not ASB-owned; left in place',
    });
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
