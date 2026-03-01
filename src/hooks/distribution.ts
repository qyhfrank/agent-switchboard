/**
 * Hook distribution: copies bundle files and merges hook configurations
 * into Claude Code's settings.json.
 *
 * Two-phase distribution for each active hook:
 *  1. **Bundle copy** (bundle hooks only): copy script files to
 *     `~/.claude/hooks/asb/<hook-id>/` using the existing bundle distributor.
 *  2. **Config merge**: deep-merge all active hooks' event maps into
 *     `~/.claude/settings.json` under the `hooks` key. For bundle hooks,
 *     `${HOOK_DIR}` placeholders are resolved to the distributed path.
 *
 * Only Claude Code is supported as a distribution target.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getClaudeDir, getProjectClaudeDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import { distributeBundle } from '../library/distribute-bundle.js';
import { ensureParentDir } from '../library/fs.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles, loadHookLibrary } from './library.js';
import { HOOK_DIR_PLACEHOLDER, type MatcherGroup } from './schema.js';

export type HookPlatform = 'claude-code';

export interface HookDistributionOutcome {
  results: Array<DistributionResult<HookPlatform> | BundleDistributionResult<HookPlatform>>;
}

const ASB_MANAGED_KEY = '_asb_managed_hooks';
const ASB_HOOKS_SUBDIR = 'asb';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveSettingsPath(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
  }
  return path.join(getClaudeDir(), 'settings.json');
}

function resolveHooksBundleParentDir(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return path.join(getProjectClaudeDir(projectRoot), 'hooks', ASB_HOOKS_SUBDIR);
  }
  return path.join(getClaudeDir(), 'hooks', ASB_HOOKS_SUBDIR);
}

function resolveHookBundleTargetDir(
  _platform: HookPlatform,
  entry: HookEntry,
  scope?: ConfigScope
): string {
  return path.join(resolveHooksBundleParentDir(scope), entry.id);
}

// ---------------------------------------------------------------------------
// Settings.json I/O
// ---------------------------------------------------------------------------

function readSettingsJson(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    // Corrupted or unreadable; start fresh for hooks section
  }
  return {};
}

function writeSettingsJson(filePath: string, data: Record<string, unknown>): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// ${HOOK_DIR} rewriting
// ---------------------------------------------------------------------------

/**
 * Deep-clone matcher groups, replacing `${HOOK_DIR}` in command strings
 * with the absolute path to the distributed bundle directory.
 */
function rewriteHookDir(groups: MatcherGroup[], distributedDir: string): MatcherGroup[] {
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((handler) => {
      if (typeof handler.command !== 'string') return handler;
      return {
        ...handler,
        command: handler.command.replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

/**
 * Merge active hook entries into the settings.json `hooks` key.
 * Tags each injected matcher group with `_asb_source` for future cleanup.
 */
function mergeHooksIntoSettings(
  settings: Record<string, unknown>,
  selected: HookEntry[],
  scope?: ConfigScope
): void {
  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  // Remove previously ASB-managed matcher groups
  const cleanedHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(existingHooks)) {
    const kept = (groups as Array<Record<string, unknown>>).filter(
      (g) => g._asb_source === undefined
    );
    if (kept.length > 0) cleanedHooks[event] = kept;
  }

  // Merge active entries
  for (const entry of selected) {
    for (const [event, groups] of Object.entries(entry.hooks)) {
      if (!cleanedHooks[event]) cleanedHooks[event] = [];

      // Resolve ${HOOK_DIR} for bundle hooks
      const resolvedGroups = entry.isBundle
        ? rewriteHookDir(groups, resolveHookBundleTargetDir('claude-code', entry, scope))
        : groups;

      for (const group of resolvedGroups) {
        cleanedHooks[event].push({ ...group, _asb_source: true });
      }
    }
  }

  settings.hooks = cleanedHooks;
  settings[ASB_MANAGED_KEY] = selected.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Orphan cleanup for bundles
// ---------------------------------------------------------------------------

function rmDirRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rmDirRecursive(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  fs.rmdirSync(dirPath);
}

function cleanOrphanBundleDirs(
  activeIds: Set<string>,
  scope?: ConfigScope
): Array<BundleDistributionResult<HookPlatform>> {
  const parentDir = resolveHooksBundleParentDir(scope);
  const results: Array<BundleDistributionResult<HookPlatform>> = [];

  if (!fs.existsSync(parentDir)) return results;

  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (activeIds.has(entry.name)) continue;

      const dirPath = path.join(parentDir, entry.name);
      try {
        rmDirRecursive(dirPath);
        results.push({
          platform: 'claude-code',
          targetDir: dirPath,
          status: 'deleted',
          reason: 'orphan',
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: 'claude-code',
          targetDir: dirPath,
          status: 'error',
          error: `Failed to delete orphan: ${msg}`,
        });
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main distribution entry point
// ---------------------------------------------------------------------------

/**
 * Distribute hooks to Claude Code:
 *  1. Copy bundle files for bundle-type hooks
 *  2. Merge all active hook configs into settings.json
 *  3. Clean up orphan bundle directories
 */
export function distributeHooks(scope?: ConfigScope): HookDistributionOutcome {
  const results: HookDistributionOutcome['results'] = [];
  const platform: HookPlatform = 'claude-code';

  const allEntries = loadHookLibrary();
  const byId = new Map(allEntries.map((e) => [e.id, e]));

  const state = loadLibraryStateSectionForApplication('hooks', 'claude-code', scope);
  const selected: HookEntry[] = [];
  for (const id of state.active) {
    const e = byId.get(id);
    if (e) selected.push(e);
  }

  // Phase 1: Copy bundle files for bundle-type hooks
  const bundleEntries = selected.filter((e) => e.isBundle);
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, HookPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: [platform],
      resolveTargetDir: (_p, entry) => resolveHookBundleTargetDir(_p, entry, scope),
      listFiles: listHookBundleFiles,
      getId: (entry) => entry.id,
      scope,
    });
    results.push(...bundleOutcome.results);
  }

  // Clean up orphan bundle directories
  const activeBundleIds = new Set(bundleEntries.map((e) => e.id));
  results.push(...cleanOrphanBundleDirs(activeBundleIds, scope));

  // Phase 2: Merge hook configs into settings.json
  const settingsPath = resolveSettingsPath(scope);
  const settings = readSettingsJson(settingsPath);
  const previouslyManaged = (settings[ASB_MANAGED_KEY] ?? []) as string[];

  if (selected.length === 0 && previouslyManaged.length === 0) {
    return { results };
  }

  const before = JSON.stringify(settings);
  mergeHooksIntoSettings(settings, selected, scope);
  const after = JSON.stringify(settings);

  if (before === after) {
    results.push({ platform, filePath: settingsPath, status: 'skipped', reason: 'up-to-date' });
  } else {
    try {
      writeSettingsJson(settingsPath, settings);
      const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
      results.push({ platform, filePath: settingsPath, status: 'written', reason });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform, filePath: settingsPath, status: 'error', error: msg });
    }
  }

  return { results };
}
