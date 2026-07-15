/**
 * Hook distribution: copies bundle files and merges hook configurations
 * into target-specific runtime files.
 *
 * Claude Code distribution:
 *  1. **Bundle copy** (bundle hooks only): copy script files to
 *     `~/.claude/hooks/managed/<hook-id>/` using the existing bundle distributor.
 *  2. **Config merge**: deep-merge all active hooks' event maps into
 *     `~/.claude/settings.json` under the `hooks` key. For bundle hooks,
 *     `${HOOK_DIR}` placeholders are resolved to the distributed path.
 *
 * The written config carries no ASB metadata and no machine-absolute paths;
 * ownership lives in `~/.asb/state/hooks/` (see `state.ts` and `ownership.ts`).
 *
 * Codex distribution is delegated to `codex-distribute.ts`, which writes
 * `hooks.json`, filters to Codex-compatible synchronous command hooks, and
 * reports Codex-specific feature flag, project trust, and review prerequisites.
 */

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getClaudeDir, getProjectClaudeDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import { distributeBundle } from '../library/distribute-bundle.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { getTargetById } from '../targets/registry.js';
import {
  type BundleCleanupOptions,
  cleanLegacyAsbDir,
  cleanManagedBundleDirs,
  removeV0428BundleDirs,
} from './bundle-dirs.js';
import { distributeCodexHooks } from './codex-distribute.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles, loadHookLibrary } from './library.js';
import { collectV0428BundleDirs, removeOwnedHookGroups } from './ownership.js';
import { HOOK_DIR_PLACEHOLDER, type MatcherGroup } from './schema.js';
import { consumeLegacyManagedState, loadHookState, saveHookState } from './state.js';
import {
  expandPortablePath,
  findTransactionArtifacts,
  preferHomeVar,
  publishJsonConfig,
  readJsonConfig,
} from './target-config.js';

export type HookPlatform = 'claude-code' | 'codex';

export interface HookDistributionOutcome {
  results: Array<DistributionResult<HookPlatform> | BundleDistributionResult<HookPlatform>>;
}

const MANAGED_HOOKS_SUBDIR = 'managed';
const LEGACY_ASB_HOOKS_SUBDIR = 'asb';
const LEGACY_ASB_MANAGED_KEY = '_asb_managed_hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS = '${CLAUDE_PLUGIN_ROOT}\\hooks';
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL = '$env:CLAUDE_PLUGIN_ROOT\\hooks';

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

function claudeRoot(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) return getProjectClaudeDir(projectRoot);
  return getClaudeDir();
}

function managedBundleParentDir(scope?: ConfigScope): string {
  return path.join(claudeRoot(scope), 'hooks', MANAGED_HOOKS_SUBDIR);
}

function legacyAsbParentDir(scope?: ConfigScope): string {
  return path.join(claudeRoot(scope), 'hooks', LEGACY_ASB_HOOKS_SUBDIR);
}

function resolveHookBundleTargetDir(entry: HookEntry, scope?: ConfigScope): string {
  return path.join(managedBundleParentDir(scope), entry.id);
}

// ---------------------------------------------------------------------------
// Command rewriting
// ---------------------------------------------------------------------------

/**
 * Resolve `${HOOK_DIR}` and plugin-root placeholders to the distributed
 * bundle directory (when given) and make every command `$HOME`-portable.
 * Also folds the `command_windows` alias into `commandWindows`.
 */
function rewriteHookDir(groups: MatcherGroup[], distributedDir?: string): unknown[] {
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((handler) => {
      const rewritten: Record<string, unknown> = { ...handler };
      const commands = {
        command: handler.command,
        commandWindows: handler.commandWindows ?? handler.command_windows,
      };
      delete rewritten.command_windows;
      for (const field of ['command', 'commandWindows'] as const) {
        const original = commands[field];
        if (typeof original !== 'string') continue;
        const resolved = distributedDir
          ? original
              .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
              .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
              .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
              .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL, distributedDir)
          : original;
        rewritten[field] = preferHomeVar(resolved);
      }
      return rewritten;
    }),
  }));
}

function resolveEntryGroups(entry: HookEntry, scope?: ConfigScope): Record<string, unknown[]> {
  const resolved: Record<string, unknown[]> = Object.create(null);
  for (const [event, groups] of Object.entries(entry.hooks)) {
    const rewritten = rewriteHookDir(
      groups,
      entry.isBundle ? resolveHookBundleTargetDir(entry, scope) : undefined
    );
    resolved[event] = rewritten.map((group) => {
      const clean = { ...(group as Record<string, unknown>) };
      delete clean._asb_source;
      return clean;
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Main distribution entry point
// ---------------------------------------------------------------------------

function isTargetReachable(platformId: string, assumeInstalled?: ReadonlySet<string>): boolean {
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
 *  3. Clean up orphan and legacy bundle directories
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

  const claudeReachable = isTargetReachable('claude-code', assumeInstalled);
  const codexReachable = isTargetReachable('codex', assumeInstalled);

  if (!claudeReachable && !codexReachable) {
    return { results };
  }

  const allEntries = loadHookLibrary(scope);
  const byId = new Map(allEntries.map((e) => [e.id, e]));

  const ctx: TargetDistributeContext = {
    scope,
    activeAppIds,
    assumeInstalled,
    allEntries,
    byId,
    dryRun,
    projectMode: options?.projectMode,
  };

  results.push(...distributeClaude(ctx));
  results.push(...distributeCodex(ctx));

  return { results };
}

// ---------------------------------------------------------------------------
// Claude Code distribution
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

/**
 * Remove every ASB-owned group from a Claude Code hooks map, returning the
 * user-owned remainder. Used by `asb hook import`.
 */
export function stripAsbOwnedClaudeGroups(
  hooks: Record<string, unknown[]>,
  scope?: ConfigScope
): Record<string, unknown[]> {
  const ownState = loadHookState('claude-code', scope);
  const legacyStates = consumeLegacyManagedState('claude-code', scope, true);
  const allEntries = loadHookLibrary(scope);
  const managedParent = managedBundleParentDir(scope);
  const legacyParent = legacyAsbParentDir(scope);
  const removal = removeOwnedHookGroups(hooks, {
    legacyAsbRoots: [legacyParent, preferHomeVar(legacyParent)],
    managedRoots: [managedParent, preferHomeVar(managedParent)],
    knownManagedIds: new Set([...allEntries.map((e) => e.id), ...ownState.bundles]),
    stateGroups: [ownState.events, ...legacyStates],
  });
  return { ...removal.hooks };
}

function distributeClaude(ctx: TargetDistributeContext): HookDistributionOutcome['results'] {
  const platform: HookPlatform = 'claude-code';
  const results: HookDistributionOutcome['results'] = [];

  const target = getTargetById(platform);
  if (target?.isInstalled?.() === false && !ctx.assumeInstalled?.has(platform)) {
    return results;
  }

  const isActive = !ctx.activeAppIds || ctx.activeAppIds.includes(platform);

  const state = loadLibraryStateSectionForApplication('hooks', 'claude-code', ctx.scope);
  const selected: HookEntry[] = [];
  if (isActive) {
    for (const id of state.enabled) {
      const e = ctx.byId.get(id);
      if (e) selected.push(e);
    }
  }

  const settingsPath = resolveSettingsPath(ctx.scope);

  // v0.4.28 transaction leftovers may hold the only copy of the user's
  // config; never distribute over them.
  const artifacts = findTransactionArtifacts(settingsPath);
  if (artifacts.length > 0) {
    results.push({
      platform,
      filePath: settingsPath,
      status: 'error',
      error:
        `config has unresolved transaction artifacts from an earlier version: ${artifacts.join(', ')}; ` +
        'restore or delete them, then re-run sync',
    });
    return results;
  }

  const ownState = loadHookState('claude-code', ctx.scope);
  const legacyStates = consumeLegacyManagedState('claude-code', ctx.scope, ctx.dryRun);

  // Phase 1: Copy bundle files for bundle-type hooks
  const bundleEntries = selected.filter((e) => e.isBundle);
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, HookPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: [platform],
      resolveTargetDir: (_p, entry) => resolveHookBundleTargetDir(entry, ctx.scope),
      resolveBundleRootDir: () => claudeRoot(ctx.scope),
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

  // Phase 2: Merge hook configs into settings.json
  const settingsResult = readJsonConfig(settingsPath);
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
  if (
    settings.hooks !== undefined &&
    (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))
  ) {
    results.push({
      platform,
      filePath: settingsPath,
      status: 'error',
      error: 'settings.json has invalid shape: "hooks" must be an object',
    });
    return results;
  }

  const before = JSON.stringify(settings);
  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  const managedParent = managedBundleParentDir(ctx.scope);
  const legacyParent = legacyAsbParentDir(ctx.scope);
  const removal = removeOwnedHookGroups(existingHooks, {
    legacyAsbRoots: [legacyParent, preferHomeVar(legacyParent)],
    managedRoots: [managedParent, preferHomeVar(managedParent)],
    knownManagedIds: new Set([...ctx.allEntries.map((e) => e.id), ...ownState.bundles]),
    stateGroups: [ownState.events, ...legacyStates],
  });

  const hadLegacyManagedKey = Object.hasOwn(settings, LEGACY_ASB_MANAGED_KEY);
  delete settings[LEGACY_ASB_MANAGED_KEY];

  const stateHasContent = Object.keys(ownState.events).length > 0 || ownState.bundles.length > 0;
  const nothingToDo =
    selected.length === 0 && !removal.removed && !hadLegacyManagedKey && !stateHasContent;

  const appendCleanupResults = (): void => {
    const cleanupOpts: BundleCleanupOptions<HookPlatform> = {
      platform,
      parentDir: managedParent,
      safetyRoot: claudeRoot(ctx.scope),
      projectScoped: Boolean(ctx.scope?.project?.trim()),
      dryRun: ctx.dryRun,
    };
    results.push(
      ...cleanManagedBundleDirs(
        cleanupOpts,
        new Set(bundleEntries.map((e) => e.id)),
        // Library-known ids count as deletable orphans too, so bundle dirs
        // survive ownership-state loss without becoming permanent litter.
        new Set([...ownState.bundles, ...ctx.allEntries.map((e) => e.id)])
      )
    );
    results.push(
      ...cleanLegacyAsbDir(
        { ...cleanupOpts, parentDir: legacyParent },
        new Set([...ctx.allEntries.map((e) => e.id), ...removal.removedLegacyAsbIds])
      )
    );
    results.push(
      ...removeV0428BundleDirs(
        platform,
        new Set([...collectV0428BundleDirs(removal.v0428Commands)].map(expandPortablePath)),
        ctx.dryRun
      )
    );
  };

  if (nothingToDo) {
    appendCleanupResults();
    return results;
  }

  const mergedHooks: Record<string, unknown[]> = Object.create(null);
  for (const [event, groups] of Object.entries(removal.hooks)) {
    mergedHooks[event] = [...groups];
  }
  const managedEvents: Record<string, unknown[]> = {};
  for (const entry of selected) {
    for (const [event, groups] of Object.entries(resolveEntryGroups(entry, ctx.scope))) {
      if (!mergedHooks[event]) mergedHooks[event] = [];
      if (!Object.hasOwn(managedEvents, event)) managedEvents[event] = [];
      for (const group of groups) {
        // A deep-equal group already in the config (e.g. left behind by lost
        // ownership state) is adopted instead of duplicated.
        if (!mergedHooks[event].some((existing) => isDeepStrictEqual(existing, group))) {
          mergedHooks[event].push(group);
        }
        managedEvents[event].push(group);
      }
    }
  }
  if (Object.keys(mergedHooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = { ...mergedHooks };
  }

  const after = JSON.stringify(settings);

  const persistState = (): void => {
    if (ctx.dryRun) return;
    saveHookState(
      'claude-code',
      { version: 1, events: managedEvents, bundles: bundleEntries.map((e) => e.id) },
      ctx.scope
    );
  };

  if (before === after) {
    results.push({ platform, filePath: settingsPath, status: 'skipped', reason: 'up-to-date' });
    persistState();
    appendCleanupResults();
  } else if (ctx.dryRun) {
    const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
    results.push({ platform, filePath: settingsPath, status: 'written', reason });
    appendCleanupResults();
  } else {
    try {
      publishJsonConfig(settingsPath, settings);
      const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
      results.push({ platform, filePath: settingsPath, status: 'written', reason });
      persistState();
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
    allEntries: ctx.allEntries,
    dryRun: ctx.dryRun,
    projectMode: ctx.projectMode,
  });

  return outcome.results;
}
