/**
 * Hook distribution: copies bundle files and merges hook configurations
 * into target-specific runtime files.
 *
 * Claude Code distribution:
 *  1. **Bundle copy** (bundle hooks only): copy script files to
 *     `~/.claude/hooks/asb/<hook-id>/` using the existing bundle distributor.
 *  2. **Config merge**: deep-merge all active hooks' event maps into
 *     `~/.claude/settings.json` under the `hooks` key. For bundle hooks,
 *     `${HOOK_DIR}` placeholders are resolved to the distributed path.
 *
 * Codex distribution is delegated to `codex-distribute.ts`, which writes
 * `hooks.json`, filters to Codex-compatible command hooks, and reports
 * Codex-specific feature flag, project trust, and review prerequisites.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClaudeDir, getProjectClaudeDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import {
  assertNoSymlinkAncestor,
  assertUsableBundleRoot,
  distributeBundle,
} from '../library/distribute-bundle.js';
import { ensureParentDir } from '../library/fs.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { getTargetById } from '../targets/registry.js';
import { distributeCodexHooks } from './codex-distribute.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles, loadHookLibrary } from './library.js';
import { HOOK_DIR_PLACEHOLDER, type MatcherGroup } from './schema.js';

export type HookPlatform = 'claude-code' | 'codex';

export interface HookDistributionOutcome {
  results: Array<DistributionResult<HookPlatform> | BundleDistributionResult<HookPlatform>>;
}

const ASB_MANAGED_KEY = '_asb_managed_hooks';
const ASB_HOOKS_SUBDIR = 'asb';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS = '${CLAUDE_PLUGIN_ROOT}\\hooks';

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

function resolveHooksBundleSafetyRoot(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return getProjectClaudeDir(projectRoot);
  }
  return getClaudeDir();
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

function readSettingsJson(
  filePath: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  try {
    if (fs.existsSync(filePath)) {
      return {
        ok: true,
        data: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>,
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, data: {} };
}

function writeSettingsJson(filePath: string, data: Record<string, unknown>): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Portable path helpers
// ---------------------------------------------------------------------------

/**
 * Replace the literal homedir prefix with `$HOME` so that distributed
 * hook commands stay portable across machines sharing the same dotfiles.
 */
function preferHomeVar(command: string): string {
  const home = os.homedir();
  if (!command.includes(home)) return command;
  return command.replaceAll(home, '$HOME');
}

function rewriteHookDir(groups: MatcherGroup[], distributedDir: string): MatcherGroup[] {
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((handler) => {
      if (typeof handler.command !== 'string') return handler;
      return {
        ...handler,
        command: preferHomeVar(
          handler.command
            .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
            .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
            .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
        ),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

/**
 * Return true if a matcher group looks like it was distributed by ASB,
 * even when `_asb_source` is missing (legacy entries).
 * Detected by command paths that reference the ASB hooks subdirectory.
 */
function isLegacyAsbGroup(group: Record<string, unknown>, scope?: ConfigScope): boolean {
  const hooks = group.hooks;
  if (!Array.isArray(hooks)) return false;
  const asbDir = `${resolveHooksBundleParentDir(scope)}/`;
  const portableAsbDir = preferHomeVar(asbDir);
  return hooks.some(
    (h: Record<string, unknown>) =>
      typeof h.command === 'string' &&
      (h.command.includes(asbDir) || h.command.includes(portableAsbDir))
  );
}

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

  // Remove previously ASB-managed matcher groups (tagged or legacy)
  const cleanedHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(existingHooks)) {
    const kept = (groups as Array<Record<string, unknown>>).filter(
      (g) => g._asb_source === undefined && !isLegacyAsbGroup(g, scope)
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

function cleanOrphanBundleDirs(
  activeIds: Set<string>,
  scope?: ConfigScope,
  dryRun?: boolean
): Array<BundleDistributionResult<HookPlatform>> {
  const parentDir = resolveHooksBundleParentDir(scope);
  const results: Array<BundleDistributionResult<HookPlatform>> = [];
  const parentError = getOrphanBundleParentError(scope);

  if (parentError) {
    results.push(parentError);
    return results;
  }
  if (!lstatIfExists(parentDir)) return results;

  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (activeIds.has(entry.name)) continue;

      const dirPath = path.join(parentDir, entry.name);
      try {
        if (!dryRun) removeHookBundlePath(dirPath);
        results.push({
          platform: 'claude-code',
          targetDir: dirPath,
          status: 'deleted',
          reason: 'orphan',
          entryId: entry.name,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: 'claude-code',
          targetDir: dirPath,
          status: 'error',
          error: `Failed to delete orphan: ${msg}`,
          entryId: entry.name,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      platform: 'claude-code',
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: ${msg}`,
    });
  }

  return results;
}

function getOrphanBundleParentError(
  scope?: ConfigScope
): BundleDistributionResult<HookPlatform> | undefined {
  const parentDir = resolveHooksBundleParentDir(scope);
  try {
    const safetyRoot = resolveHooksBundleSafetyRoot(scope);
    assertUsableBundleRoot(safetyRoot);
    assertNoSymlinkAncestor(safetyRoot, parentDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      platform: 'claude-code',
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: ${msg}`,
    };
  }

  const parentStat = lstatIfExists(parentDir);
  if (!parentStat) return undefined;
  if (!parentStat.isDirectory()) {
    return {
      platform: 'claude-code',
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: bundle root exists and is not a directory: ${parentDir}`,
    };
  }
  return undefined;
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function removeHookBundlePath(targetPath: string): void {
  const stat = lstatIfExists(targetPath);
  if (!stat) return;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      removeHookBundlePath(path.join(targetPath, entry.name));
    }
    fs.rmdirSync(targetPath);
    return;
  }

  fs.unlinkSync(targetPath);
}

// ---------------------------------------------------------------------------
// Main distribution entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Target reachability check
// ---------------------------------------------------------------------------

function isTargetReachable(
  platformId: string,
  _activeAppIds?: string[],
  assumeInstalled?: ReadonlySet<string>
): boolean {
  const target = getTargetById(platformId);
  if (target?.isInstalled?.() === false && !assumeInstalled?.has(platformId)) {
    return false;
  }
  return true;
}

/**
 * Distribute hooks to active targets (Claude Code, Codex, etc.):
 *  1. Copy bundle files for bundle-type hooks
 *  2. Merge all active hook configs into each target's config
 *  3. Clean up orphan bundle directories
 */
export function distributeHooks(
  scope?: ConfigScope,
  activeAppIds?: string[],
  assumeInstalled?: ReadonlySet<string>,
  options?: {
    projectMode?: 'managed' | 'exclusive' | 'none';
    dryRun?: boolean;
  }
): HookDistributionOutcome {
  if (scope?.project && options?.projectMode === 'none') {
    return { results: [] };
  }

  const results: HookDistributionOutcome['results'] = [];
  const dryRun = options?.dryRun === true;

  // Check if any hook-capable target is reachable before loading library
  const claudeReachable = isTargetReachable('claude-code', activeAppIds, assumeInstalled);
  const codexReachable = isTargetReachable('codex', activeAppIds, assumeInstalled);

  if (!claudeReachable && !codexReachable) {
    return { results };
  }

  // Load all hook entries once (shared across targets)
  const allEntries = loadHookLibrary(scope);
  const byId = new Map(allEntries.map((e) => [e.id, e]));

  // --- Claude Code distribution ---
  const claudeResults = distributeClaude({
    scope,
    activeAppIds,
    assumeInstalled,
    allEntries,
    byId,
    dryRun,
    projectMode: options?.projectMode,
  });
  results.push(...claudeResults);

  // --- Codex distribution ---
  const codexResults = distributeCodex({
    scope,
    activeAppIds,
    assumeInstalled,
    allEntries,
    byId,
    dryRun,
    projectMode: options?.projectMode,
  });
  results.push(...codexResults);

  return { results };
}

// ---------------------------------------------------------------------------
// Claude Code distribution (extracted from former monolithic function)
// ---------------------------------------------------------------------------

interface TargetDistributeContext {
  scope?: ConfigScope;
  activeAppIds?: string[];
  assumeInstalled?: ReadonlySet<string>;
  allEntries: HookEntry[];
  byId: Map<string, HookEntry>;
  dryRun: boolean;
  projectMode?: 'managed' | 'exclusive' | 'none';
}

function distributeClaude(ctx: TargetDistributeContext): HookDistributionOutcome['results'] {
  const platform: HookPlatform = 'claude-code';
  const results: HookDistributionOutcome['results'] = [];

  // Skip if claude-code is not installed (unless assumed installed)
  const target = getTargetById(platform);
  if (target?.isInstalled?.() === false && !ctx.assumeInstalled?.has(platform)) {
    return results;
  }

  // When activeAppIds is set and doesn't include claude-code, treat as inactive
  const isActive = !ctx.activeAppIds || ctx.activeAppIds.includes(platform);

  const state = loadLibraryStateSectionForApplication('hooks', 'claude-code', ctx.scope);
  const selected: HookEntry[] = [];
  if (isActive) {
    for (const id of state.enabled) {
      const e = ctx.byId.get(id);
      if (e) selected.push(e);
    }
  }

  // Phase 1: Copy bundle files for bundle-type hooks
  const bundleEntries = selected.filter((e) => e.isBundle);
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, HookPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: [platform],
      resolveTargetDir: (_p, entry) => resolveHookBundleTargetDir(_p, entry, ctx.scope),
      resolveBundleRootDir: (_p) => resolveHooksBundleSafetyRoot(ctx.scope),
      listFiles: listHookBundleFiles,
      getId: (entry) => entry.id,
      scope: ctx.scope,
      dryRun: ctx.dryRun,
    });
    results.push(...bundleOutcome.results);
    if (
      bundleOutcome.results.some(
        (result) => result.status === 'error' || result.status === 'conflict'
      )
    ) {
      return results;
    }
  }

  const activeBundleIds = new Set(bundleEntries.map((e) => e.id));
  const cleanupParentError = getOrphanBundleParentError(ctx.scope);
  if (cleanupParentError) {
    results.push(cleanupParentError);
    return results;
  }

  // Phase 2: Merge hook configs into settings.json
  const settingsPath = resolveSettingsPath(ctx.scope);
  const settingsResult = readSettingsJson(settingsPath);

  if (!settingsResult.ok) {
    results.push({
      platform,
      filePath: settingsPath,
      status: 'error',
      error: `Cannot read settings.json, aborting hooks merge: ${settingsResult.error}`,
    });
    return results;
  }

  const settings = settingsResult.data;
  const previouslyManaged = (settings[ASB_MANAGED_KEY] ?? []) as string[];

  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const hasLegacyAsb = Object.values(existingHooks).some((groups) =>
    (groups as Array<Record<string, unknown>>).some((g) => isLegacyAsbGroup(g, ctx.scope))
  );

  const appendCleanupResults = (): void => {
    results.push(...cleanOrphanBundleDirs(activeBundleIds, ctx.scope, ctx.dryRun));
  };

  if (selected.length === 0 && previouslyManaged.length === 0 && !hasLegacyAsb) {
    appendCleanupResults();
    return results;
  }

  const before = JSON.stringify(settings);
  mergeHooksIntoSettings(settings, selected, ctx.scope);
  const after = JSON.stringify(settings);

  if (before === after) {
    results.push({ platform, filePath: settingsPath, status: 'skipped', reason: 'up-to-date' });
    appendCleanupResults();
  } else if (ctx.dryRun) {
    const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
    results.push({ platform, filePath: settingsPath, status: 'written', reason });
    appendCleanupResults();
  } else {
    try {
      writeSettingsJson(settingsPath, settings);
      const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
      results.push({ platform, filePath: settingsPath, status: 'written', reason });
      appendCleanupResults();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform, filePath: settingsPath, status: 'error', error: msg });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Codex distribution (delegates to codex-distribute module)
// ---------------------------------------------------------------------------

function distributeCodex(ctx: TargetDistributeContext): HookDistributionOutcome['results'] {
  const platform = 'codex';

  // Skip if codex is not installed (unless assumed installed)
  const target = getTargetById(platform);
  if (target?.isInstalled?.() === false && !ctx.assumeInstalled?.has(platform)) {
    return [];
  }

  const isActive = !ctx.activeAppIds || ctx.activeAppIds.includes(platform);

  const state = loadLibraryStateSectionForApplication('hooks', 'codex', ctx.scope);
  const selected: HookEntry[] = [];
  if (isActive) {
    for (const id of state.enabled) {
      const e = ctx.byId.get(id);
      if (e) selected.push(e);
    }
  }

  const outcome = distributeCodexHooks({
    scope: ctx.scope,
    selected,
    dryRun: ctx.dryRun,
    projectMode: ctx.projectMode,
  });

  return outcome.results;
}
