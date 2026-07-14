/**
 * Hook distribution: copies bundle files and merges hook configurations
 * into target-specific runtime files.
 *
 * Claude Code distribution:
 *  1. **Bundle copy** (bundle hooks only): copy script files to
 *     `~/.claude/hooks/managed/<namespace-key>/<deployment-key>/`.
 *  2. **Config merge**: deep-merge all active hooks' event maps into
 *     `~/.claude/settings.json` under the `hooks` key. For bundle hooks,
 *     `${HOOK_DIR}` placeholders are resolved to the distributed path.
 *
 * Codex distribution is delegated to `codex-distribute.ts`, which writes
 * `hooks.json`, filters to Codex-compatible command hooks, and reports
 * Codex-specific feature flag, project trust, and review prerequisites.
 */

import { createHash } from 'node:crypto';
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
  resolvedHomeDir,
} from '../library/distribute-bundle.js';
import { loadLibraryStateSectionForApplication } from '../library/state.js';
import { getTargetById } from '../targets/registry.js';
import {
  type BundleCleanupDeleteGuard,
  captureBundleCleanupEntries,
  cleanBundleDirectories,
  removeBundleTree,
} from './bundle-cleanup.js';
import {
  type CapturedHookBundle,
  captureHookBundle,
  hookBundleDeploymentKey,
  materializeHookBundleSnapshots,
  requireHookBundleHash,
} from './bundle-snapshot.js';
import { distributeCodexHooks } from './codex-distribute.js';
import { commandContainsPathToken } from './legacy-command.js';
import type { HookEntry } from './library.js';
import { loadHookLibrary } from './library.js';
import {
  assertManagedHookConfigSnapshot,
  clearLegacyHookBundleCleanup,
  commitManagedHookUpdate,
  getManagedHookPrefixLengths,
  hasManagedHookGroups,
  type LegacyHookBundleCleanupEntry,
  loadManagedHookGroups,
  type ManagedHookGroups,
  type ManagedHookPrefixLengths,
  type ManagedHookRemovalResult,
  type ManagedHookTransactionAddress,
  managedHookConfigHash,
  markLegacyHookBundleCleanup,
  readPendingLegacyHookBundleCleanup,
  refreshLegacyHookBundleCleanup,
  removeManagedHookGroups,
  resolveManagedHookTransactionAddress,
  saveManagedHookGroups,
  withManagedHookLock,
} from './managed-state.js';
import { HOOK_DIR_PLACEHOLDER, hookFileSchema, type MatcherGroup } from './schema.js';

export type HookPlatform = 'claude-code' | 'codex';

export interface HookDistributionOutcome {
  results: Array<DistributionResult<HookPlatform> | BundleDistributionResult<HookPlatform>>;
}

const LEGACY_ASB_MANAGED_KEY = '_asb_managed_hooks';
const MANAGED_HOOKS_SUBDIR = 'managed';
const LEGACY_ASB_HOOKS_SUBDIR = 'asb';
const MANAGED_BUNDLE_NAMESPACE_SEED = 'agent-switchboard\0claude-code\0hooks';
const LEGACY_ASB_COMMAND_MARKER = '# asb-managed-by=agent-switchboard';
const LEGACY_ASB_HOOK_ID_MARKER_PREFIX = '# asb-hook-id=';
const LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX = '# asb-bundle-sha256=';
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

function resolveHooksBundleParentDir(
  scope?: ConfigScope,
  subdir = MANAGED_HOOKS_SUBDIR,
  address?: ManagedHookTransactionAddress
): string {
  const projectRoot = address ? address.projectRoot : scope?.project?.trim();
  if (subdir === MANAGED_HOOKS_SUBDIR && !address) {
    throw new Error('managed hook bundle path requires a transaction address');
  }
  const parts =
    subdir === MANAGED_HOOKS_SUBDIR && address
      ? ['hooks', subdir, managedBundleNamespace(address)]
      : ['hooks', subdir];
  if (projectRoot && projectRoot.length > 0) {
    return path.join(getProjectClaudeDir(projectRoot), ...parts);
  }
  return path.join(getClaudeDir(), ...parts);
}

function managedBundleNamespace(address: ManagedHookTransactionAddress): string {
  return createHash('sha256')
    .update(MANAGED_BUNDLE_NAMESPACE_SEED)
    .update('\0')
    .update(path.basename(address.statePath))
    .digest('hex');
}

function resolveHooksBundleSafetyRoot(
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): string {
  const projectRoot = address ? address.projectRoot : scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return getProjectClaudeDir(projectRoot);
  }
  return getClaudeDir();
}

function resolveHookBundleTargetDir(
  _platform: HookPlatform,
  entry: HookEntry,
  bundleHash: string,
  scope: ConfigScope | undefined,
  address: ManagedHookTransactionAddress
): string {
  return path.join(
    resolveHooksBundleParentDir(scope, MANAGED_HOOKS_SUBDIR, address),
    hookBundleDeploymentKey(entry, bundleHash)
  );
}

// ---------------------------------------------------------------------------
// Settings.json I/O
// ---------------------------------------------------------------------------

function readSettingsJson(filePath: string):
  | {
      ok: true;
      data: Record<string, unknown>;
      raw: string | undefined;
      mode: number | undefined;
      identity: string | undefined;
    }
  | { ok: false; error: string } {
  let fd: number | undefined;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error(`settings.json is not a regular file: ${filePath}`);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error('settings.json changed while it was being read');
    }
    const raw = fs.readFileSync(fd, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'settings.json root must be an object' };
    }
    return {
      ok: true,
      data: parsed as Record<string, unknown>,
      raw,
      mode: stat.mode & 0o777,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return { ok: true, data: {}, raw: undefined, mode: undefined, identity: undefined };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
      const rewritten = { ...handler };
      for (const field of ['command', 'commandWindows', 'command_windows'] as const) {
        const command = handler[field];
        if (typeof command !== 'string') continue;
        rewritten[field] = preferHomeVar(
          command
            .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
            .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
            .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
            .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL, distributedDir)
        );
      }
      return rewritten;
    }),
  }));
}

function stripLegacyAsbCommandMetadata(groups: MatcherGroup[]): MatcherGroup[] {
  return groups.map((group) => ({
    ...group,
    hooks: group.hooks.map((handler) => {
      const cleaned = { ...handler };
      for (const field of ['command', 'commandWindows', 'command_windows'] as const) {
        const command = handler[field];
        if (typeof command !== 'string') continue;
        cleaned[field] = command
          .split(/\r?\n/)
          .filter((line) => {
            const trimmed = line.trim();
            return (
              trimmed !== LEGACY_ASB_COMMAND_MARKER &&
              !trimmed.startsWith(LEGACY_ASB_HOOK_ID_MARKER_PREFIX) &&
              !trimmed.startsWith(LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX)
            );
          })
          .join('\n')
          .trimEnd();
      }
      return cleaned;
    }),
  }));
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

function isLegacyAsbHandler(
  hook: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): boolean {
  const legacyParents = resolveLegacyBundleParents(scope, address);
  return ['command', 'commandWindows', 'command_windows'].some((field) => {
    const command = hook[field];
    const normalized = typeof command === 'string' ? command.replaceAll('\\', '/') : '';
    return (
      typeof command === 'string' &&
      legacyParents.some((parent) => commandContainsPathToken(normalized, parent))
    );
  });
}

function isLegacyAsbGroup(
  group: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): boolean {
  if (group._asb_source === true) return true;
  const hooks = group.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => isLegacyAsbHandler(hook as Record<string, unknown>, scope, address))
  );
}

function cleanLegacyAsbGroup(
  group: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): Record<string, unknown> | undefined {
  const hooks = Array.isArray(group.hooks) ? group.hooks : [];
  const keptHooks = hooks.filter(
    (hook) => !isLegacyAsbHandler(hook as Record<string, unknown>, scope, address)
  );
  if (keptHooks.length !== hooks.length) {
    if (keptHooks.length === 0) return undefined;
    const cleaned: Record<string, unknown> = { ...group, hooks: keptHooks };
    delete cleaned._asb_source;
    return cleaned;
  }
  if (group._asb_source === true) return undefined;
  return group;
}

export function removeManagedClaudeHookGroups(
  existing: ManagedHookGroups,
  managed: ManagedHookGroups,
  prefixLengths: ManagedHookPrefixLengths,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): ManagedHookRemovalResult {
  return removeManagedHookGroups(existing, managed, prefixLengths, (group) =>
    cleanLegacyAsbGroup(group, scope, address)
  );
}

function buildManagedClaudeHooks(
  selected: readonly HookEntry[],
  bundleHashes: ReadonlyMap<string, string>,
  scope: ConfigScope | undefined,
  address: ManagedHookTransactionAddress
): ManagedHookGroups {
  const managed: ManagedHookGroups = {};
  for (const entry of selected) {
    for (const [event, groups] of Object.entries(entry.hooks)) {
      const resolvedGroups = stripLegacyAsbCommandMetadata(
        entry.isBundle
          ? rewriteHookDir(
              groups,
              resolveHookBundleTargetDir(
                'claude-code',
                entry,
                requireHookBundleHash(bundleHashes, entry),
                scope,
                address
              )
            )
          : groups
      );
      for (const group of resolvedGroups) {
        const cleanGroup = { ...group } as Record<string, unknown>;
        delete cleanGroup._asb_source;
        if (!managed[event]) managed[event] = [];
        managed[event].push(cleanGroup);
      }
    }
  }
  return managed;
}

function mergeHooksIntoSettings(
  settings: Record<string, unknown>,
  managed: ManagedHookGroups,
  cleanedHooks: ManagedHookGroups
): void {
  for (const [event, groups] of Object.entries(managed)) {
    cleanedHooks[event] = [...(cleanedHooks[event] ?? []), ...groups];
  }

  settings.hooks = cleanedHooks;
  delete settings[LEGACY_ASB_MANAGED_KEY];
}

function collectLegacyBundleIds(
  settings: Record<string, unknown>,
  hooks: ManagedHookGroups,
  scope: ConfigScope | undefined,
  address: ManagedHookTransactionAddress
): string[] {
  const configuredIds = getLegacyManagedIds(settings);
  const ids = new Set<string>();
  const legacyParents = resolveLegacyBundleParents(scope, address);
  for (const groups of Object.values(hooks)) {
    for (const group of groups as Array<Record<string, unknown>>) {
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      for (const handlerValue of handlers) {
        const handler = handlerValue as Record<string, unknown>;
        for (const field of ['command', 'commandWindows', 'command_windows']) {
          const command = handler[field];
          if (typeof command !== 'string') continue;
          const normalized = command.replaceAll('\\', '/');
          const bundleId = extractLegacyBundleId(normalized, '.claude');
          if (
            bundleId &&
            (legacyParents.some((parent) => commandContainsPathToken(normalized, parent)) ||
              (group._asb_source === true && configuredIds.has(bundleId)))
          ) {
            ids.add(bundleId);
          }
        }
      }
    }
  }
  return [...ids].sort();
}

function getLegacyManagedIds(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const configured = config[LEGACY_ASB_MANAGED_KEY];
  if (Array.isArray(configured)) {
    for (const value of configured) {
      if (typeof value === 'string' && isSafeBundleId(value)) ids.add(value);
    }
  }
  return ids;
}

function resolveLegacyBundleParents(
  scope: ConfigScope | undefined,
  address?: ManagedHookTransactionAddress
): string[] {
  const canonical = resolveHooksBundleParentDir(scope, LEGACY_ASB_HOOKS_SUBDIR, address);
  const aliases = address?.projectRootAlias
    ? [path.join(getProjectClaudeDir(address.projectRootAlias), 'hooks', LEGACY_ASB_HOOKS_SUBDIR)]
    : [];
  return [...new Set([canonical, preferHomeVar(canonical), ...aliases])].map((value) =>
    value.replaceAll('\\', '/')
  );
}

function isSafeBundleId(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function extractLegacyBundleId(normalizedCommand: string, appDir: string): string | undefined {
  const escaped = appDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalizedCommand.match(new RegExp(`${escaped}/hooks/asb/([^/\\s"';&|]+)`));
  return match?.[1] && isSafeBundleId(match[1]) ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Orphan cleanup for bundles
// ---------------------------------------------------------------------------

function cleanOrphanBundleDirs(
  activeIds: Set<string>,
  scope?: ConfigScope,
  dryRun?: boolean,
  subdir = MANAGED_HOOKS_SUBDIR,
  address?: ManagedHookTransactionAddress,
  deleteOnlyBundles?: ReadonlyMap<string, string>,
  verifyCurrent?: () => void,
  updateRetryFingerprint?: (id: string, fingerprint: string) => void,
  deleteGuard?: BundleCleanupDeleteGuard
): Array<BundleDistributionResult<HookPlatform>> {
  const parentDir = resolveHooksBundleParentDir(scope, subdir, address);
  const results: Array<BundleDistributionResult<HookPlatform>> = [];
  const parentError = getOrphanBundleParentError(scope, subdir, address);

  if (parentError) {
    results.push(parentError);
    return results;
  }
  return cleanBundleDirectories({
    platform: 'claude-code',
    parentDir,
    activeIds,
    deleteOnlyBundles,
    dryRun,
    verifyCurrent,
    updateRetryFingerprint,
    deleteGuard,
  });
}

function getOrphanBundleParentError(
  scope?: ConfigScope,
  subdir = MANAGED_HOOKS_SUBDIR,
  address?: ManagedHookTransactionAddress
): BundleDistributionResult<HookPlatform> | undefined {
  const parentDir = resolveHooksBundleParentDir(scope, subdir, address);
  try {
    const safetyRoot = resolveHooksBundleSafetyRoot(scope, address);
    const projectRoot = address ? address.projectRoot : scope?.project?.trim();
    assertUsableBundleRoot(safetyRoot);
    assertNoSymlinkAncestor(safetyRoot, parentDir, {
      trustedRoots: projectRoot ? undefined : [resolvedHomeDir()],
    });
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
  removeBundleTree(targetPath);
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
  const target = getTargetById(platform);
  if (target?.isInstalled?.() === false && !ctx.assumeInstalled?.has(platform)) {
    return [];
  }

  const settingsPath = resolveSettingsPath(ctx.scope);

  try {
    if (ctx.dryRun) {
      const address = resolveManagedHookTransactionAddress(
        platform,
        settingsPath,
        ctx.scope?.project ?? undefined
      );
      return distributeClaudeLocked(ctx, settingsPath, address);
    }
    return withManagedHookLock(
      platform,
      settingsPath,
      (address) => distributeClaudeLocked(ctx, settingsPath, address),
      ctx.scope?.project ?? undefined
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ platform, filePath: settingsPath, status: 'error', error: msg }];
  }
}

function distributeClaudeLocked(
  ctx: TargetDistributeContext,
  settingsPath: string,
  address: ManagedHookTransactionAddress
): HookDistributionOutcome['results'] {
  const platform: HookPlatform = 'claude-code';
  const results: HookDistributionOutcome['results'] = [];

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

  const managedState = loadManagedHookGroups(
    platform,
    settingsPath,
    ctx.scope?.project ?? undefined,
    address,
    !ctx.dryRun
  );
  if (!managedState.ok) {
    results.push({
      platform,
      filePath: managedState.filePath,
      status: 'error',
      error: `Cannot read managed hook state, aborting hooks merge: ${managedState.error}`,
    });
    return results;
  }
  const settingsResult = readSettingsJson(address.writePath);
  if (!settingsResult.ok) {
    results.push({
      platform,
      filePath: settingsPath,
      status: 'error',
      error: `Cannot read settings.json, aborting hooks merge: ${settingsResult.error}`,
    });
    return results;
  }
  const existingHookFile = hookFileSchema.safeParse({
    hooks: settingsResult.data.hooks === undefined ? {} : settingsResult.data.hooks,
  });
  if (!existingHookFile.success) {
    results.push({
      platform,
      filePath: settingsPath,
      status: 'error',
      error: 'settings.json has invalid hook configuration',
    });
    return results;
  }

  if (managedState.pending && !ctx.dryRun) {
    try {
      assertManagedHookConfigSnapshot(
        address,
        settingsResult.raw,
        settingsResult.mode,
        settingsResult.identity
      );
      saveManagedHookGroups(
        platform,
        settingsPath,
        managedState.hooks,
        managedState.prefixLengths,
        ctx.scope?.project ?? undefined,
        address
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform, filePath: managedState.filePath, status: 'error', error: msg });
      return results;
    }
  }

  const bundleEntries = selected.filter((e) => e.isBundle);
  const bundleHashes = new Map<string, string>();
  const bundleSnapshots = new Map<string, CapturedHookBundle>();
  for (const entry of bundleEntries) {
    try {
      const snapshot = captureHookBundle(entry);
      bundleSnapshots.set(entry.id, snapshot);
      bundleHashes.set(entry.id, snapshot.hash);
    } catch (error) {
      results.push({
        platform,
        filePath: settingsPath,
        status: 'error',
        error: `Failed to capture bundle ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        entryId: entry.id,
      });
      return results;
    }
  }
  const effectiveSelected = selected.map((entry) => {
    const snapshot = bundleSnapshots.get(entry.id);
    return snapshot ? { ...entry, hooks: snapshot.hooks } : entry;
  });
  const activeBundleIds = new Set(
    bundleEntries.map((entry) =>
      hookBundleDeploymentKey(entry, requireHookBundleHash(bundleHashes, entry))
    )
  );
  const cleanupParentError = getOrphanBundleParentError(ctx.scope, MANAGED_HOOKS_SUBDIR, address);
  if (cleanupParentError) {
    results.push(cleanupParentError);
    return results;
  }

  const settings = settingsResult.data;
  const hadLegacyManagedKey =
    Object.getOwnPropertyDescriptor(settings, LEGACY_ASB_MANAGED_KEY) !== undefined;
  const previouslyManaged = managedState.hooks;
  const managed = buildManagedClaudeHooks(effectiveSelected, bundleHashes, ctx.scope, address);
  const existingHooks = existingHookFile.data.hooks;
  const removal = removeManagedClaudeHookGroups(
    existingHooks,
    previouslyManaged,
    managedState.prefixLengths,
    ctx.scope,
    address
  );
  if (hasManagedHookGroups(removal.unmatched)) {
    results.push({
      platform,
      filePath: managedState.filePath,
      status: 'conflict',
      reason: 'managed hook state does not match the application config; resolve hook drift',
    });
    return results;
  }
  const hasLegacyAsb = Object.values(existingHooks).some((groups) =>
    (groups as Array<Record<string, unknown>>).some((g) => isLegacyAsbGroup(g, ctx.scope, address))
  );
  const activeLegacyBundleIds = new Set(collectLegacyBundleIds({}, managed, ctx.scope, address));
  const legacyBundleIds = collectLegacyBundleIds(
    settings,
    existingHooks,
    ctx.scope,
    address
  ).filter((id) => !activeLegacyBundleIds.has(id));
  let pendingLegacyBundles: LegacyHookBundleCleanupEntry[];
  let capturedLegacyBundles: Array<{ id: string; fingerprint: string }> = [];
  try {
    pendingLegacyBundles = readPendingLegacyHookBundleCleanup(address);
    if ((hadLegacyManagedKey || hasLegacyAsb) && legacyBundleIds.length > 0) {
      const parentError = getOrphanBundleParentError(ctx.scope, LEGACY_ASB_HOOKS_SUBDIR, address);
      if (parentError) {
        results.push(parentError);
        return results;
      }
      capturedLegacyBundles = captureBundleCleanupEntries(
        resolveHooksBundleParentDir(ctx.scope, LEGACY_ASB_HOOKS_SUBDIR, address),
        legacyBundleIds
      );
    }
  } catch (error) {
    results.push({
      platform,
      filePath: managedState.filePath,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return results;
  }
  const initialConfigHash = managedHookConfigHash(settingsResult.raw);
  if (bundleEntries.length > 0) {
    let snapshotRoot: string | undefined;
    try {
      const materialized = materializeHookBundleSnapshots(bundleEntries, bundleSnapshots);
      snapshotRoot = materialized.root;
      const bundleOutcome = distributeBundle<HookEntry, HookPlatform>({
        section: 'hooks',
        selected: bundleEntries,
        platforms: [platform],
        resolveTargetDir: (_p, entry) =>
          resolveHookBundleTargetDir(
            _p,
            entry,
            requireHookBundleHash(bundleHashes, entry),
            ctx.scope,
            address
          ),
        resolveBundleRootDir: (_p) => resolveHooksBundleSafetyRoot(ctx.scope, address),
        listFiles: (entry) => {
          const files = materialized.files.get(entry.id);
          if (!files) throw new Error(`Missing bundle snapshot files for ${entry.id}`);
          return files;
        },
        getId: (entry) => entry.id,
        scope: address.projectRoot ? { project: address.projectRoot } : undefined,
        dryRun: ctx.dryRun,
        validateTarget: ctx.dryRun
          ? undefined
          : () =>
              assertManagedHookConfigSnapshot(
                address,
                settingsResult.raw,
                settingsResult.mode,
                settingsResult.identity
              ),
      });
      results.push(...bundleOutcome.results);
      if (
        bundleOutcome.results.some(
          (result) => result.status === 'error' || result.status === 'conflict'
        )
      ) {
        return results;
      }
    } catch (error) {
      results.push({
        platform,
        filePath: settingsPath,
        status: 'error',
        error: `Failed to materialize bundle snapshot: ${error instanceof Error ? error.message : String(error)}`,
      });
      return results;
    } finally {
      if (snapshotRoot) removeHookBundlePath(snapshotRoot);
    }
  }

  const appendCleanupResults = (
    expectedConfig: string | undefined,
    expectedMode?: number,
    expectedIdentity?: string
  ): void => {
    const verifyCurrent = ctx.dryRun
      ? undefined
      : () =>
          assertManagedHookConfigSnapshot(address, expectedConfig, expectedMode, expectedIdentity);
    try {
      verifyCurrent?.();
    } catch (error) {
      results.push({
        platform,
        filePath: settingsPath,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const deleteGuard: BundleCleanupDeleteGuard | undefined = ctx.dryRun
      ? undefined
      : {
          configAliasPath: address.configPath,
          configPath: address.writePath,
          configHash: managedHookConfigHash(expectedConfig),
          ...(expectedMode !== undefined ? { configMode: expectedMode } : {}),
          ...(expectedIdentity !== undefined ? { configIdentity: expectedIdentity } : {}),
        };
    results.push(
      ...cleanOrphanBundleDirs(
        activeBundleIds,
        ctx.scope,
        ctx.dryRun,
        MANAGED_HOOKS_SUBDIR,
        address,
        undefined,
        verifyCurrent,
        undefined,
        deleteGuard
      )
    );
    try {
      verifyCurrent?.();
      const configHash = managedHookConfigHash(expectedConfig);
      const candidates = new Map<string, { id: string; fingerprint: string }>();
      for (const value of pendingLegacyBundles) {
        if (value.configHash === initialConfigHash) {
          candidates.set(value.id, { id: value.id, fingerprint: value.fingerprint });
        }
      }
      for (const value of capturedLegacyBundles) {
        if (!candidates.has(value.id)) candidates.set(value.id, value);
      }
      if (ctx.dryRun) {
        pendingLegacyBundles = [...candidates.values()].map((value) => ({
          ...value,
          configHash,
        }));
      } else {
        const existing = readPendingLegacyHookBundleCleanup(address);
        if (existing.some((value) => value.configHash !== configHash)) {
          clearLegacyHookBundleCleanup(address);
        }
        if (candidates.size > 0) {
          markLegacyHookBundleCleanup(address, [...candidates.values()], expectedConfig);
        }
        pendingLegacyBundles = readPendingLegacyHookBundleCleanup(address).filter(
          (value) => value.configHash === configHash
        );
      }
    } catch (error) {
      results.push({
        platform,
        filePath: managedState.filePath,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (pendingLegacyBundles.length === 0) return;
    const pendingLegacyBundleMap = new Map(
      pendingLegacyBundles.map((value) => [value.id, value.fingerprint])
    );
    const legacyResults = cleanOrphanBundleDirs(
      new Set(),
      ctx.scope,
      ctx.dryRun,
      LEGACY_ASB_HOOKS_SUBDIR,
      address,
      pendingLegacyBundleMap,
      verifyCurrent,
      (id, fingerprint) => refreshLegacyHookBundleCleanup(address, id, fingerprint),
      deleteGuard
    );
    results.push(...legacyResults);
    if (!ctx.dryRun && !legacyResults.some((result) => result.status === 'error')) {
      try {
        clearLegacyHookBundleCleanup(address);
      } catch (error) {
        results.push({
          platform,
          filePath: managedState.filePath,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  if (
    selected.length === 0 &&
    !hadLegacyManagedKey &&
    !hasManagedHookGroups(previouslyManaged) &&
    !hasLegacyAsb
  ) {
    appendCleanupResults(settingsResult.raw, settingsResult.mode, settingsResult.identity);
    return results;
  }

  const before = JSON.stringify(settings);
  const managedPrefixLengths = getManagedHookPrefixLengths(removal.hooks, managed);
  mergeHooksIntoSettings(settings, managed, removal.hooks);
  const after = JSON.stringify(settings);

  if (before === after) {
    try {
      if (!ctx.dryRun) {
        assertManagedHookConfigSnapshot(
          address,
          settingsResult.raw,
          settingsResult.mode,
          settingsResult.identity
        );
        saveManagedHookGroups(
          platform,
          settingsPath,
          managed,
          managedPrefixLengths,
          ctx.scope?.project ?? undefined,
          address
        );
      }
      results.push({ platform, filePath: settingsPath, status: 'skipped', reason: 'up-to-date' });
      appendCleanupResults(settingsResult.raw, settingsResult.mode, settingsResult.identity);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform, filePath: managedState.filePath, status: 'error', error: msg });
    }
  } else if (ctx.dryRun) {
    const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
    results.push({ platform, filePath: settingsPath, status: 'written', reason });
    appendCleanupResults(settingsResult.raw, settingsResult.mode, settingsResult.identity);
  } else {
    try {
      const desiredConfig = `${JSON.stringify(settings, null, 2)}\n`;
      const committedIdentity = commitManagedHookUpdate(
        platform,
        settingsPath,
        previouslyManaged,
        managedState.prefixLengths,
        managed,
        managedPrefixLengths,
        desiredConfig,
        settingsResult.raw,
        ctx.scope?.project ?? undefined,
        address,
        settingsResult.mode,
        settingsResult.identity
      );
      const reason = selected.length === 0 ? 'hooks cleared' : `${selected.length} hook(s) merged`;
      results.push({ platform, filePath: settingsPath, status: 'written', reason });
      appendCleanupResults(desiredConfig, settingsResult.mode, committedIdentity);
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
