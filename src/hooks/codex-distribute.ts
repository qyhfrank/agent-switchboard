/**
 * Codex hook distribution: writes hooks.json and copies bundle files.
 *
 * Codex reads hooks from ~/.codex/hooks.json (global) and
 * <project>/.codex/hooks.json (project scope). Unlike Claude Code which
 * embeds hooks inside settings.json, Codex uses a dedicated file.
 *
 * ASB currently distributes command handlers to Codex and Codex has no
 * ${HOOK_DIR} runtime expansion. ASB must filter unsupported entries and rewrite
 * bundle paths to absolute paths before writing.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import {
  getCodexConfigPath,
  getCodexDir,
  getCodexHooksJsonPath,
  getProjectCodexDir,
  getProjectCodexHooksJsonPath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import {
  assertNoSymlinkAncestor,
  assertUsableBundleRoot,
  distributeBundle,
} from '../library/distribute-bundle.js';
import { ensureParentDir } from '../library/fs.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles } from './library.js';
import { HOOK_DIR_PLACEHOLDER } from './schema.js';

type CodexPlatform = 'codex';

const CODEX_SUPPORTED_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
]);

const CODEX_SUPPORTED_HANDLER_TYPES = new Set(['command']);

// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS = '${CLAUDE_PLUGIN_ROOT}\\hooks';

const ASB_MANAGED_KEY = '_asb_managed_hooks';
const ASB_HOOKS_SUBDIR = 'asb';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveHooksJsonPath(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return getProjectCodexHooksJsonPath(projectRoot);
  }
  return getCodexHooksJsonPath();
}

function resolveHooksBundleParentDir(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return path.join(getProjectCodexDir(projectRoot), 'hooks', ASB_HOOKS_SUBDIR);
  }
  return path.join(getCodexDir(), 'hooks', ASB_HOOKS_SUBDIR);
}

function resolveHooksBundleSafetyRoot(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return getProjectCodexDir(projectRoot);
  }
  return getCodexDir();
}

function resolveHookBundleTargetDir(entry: HookEntry, scope?: ConfigScope): string {
  return path.join(resolveHooksBundleParentDir(scope), entry.id);
}

// ---------------------------------------------------------------------------
// Portable path helpers
// ---------------------------------------------------------------------------

function preferHomeVar(command: string): string {
  const home = os.homedir();
  if (!command.includes(home)) return command;
  return command.replaceAll(home, '$HOME');
}

// ---------------------------------------------------------------------------
// Filtering for Codex compatibility
// ---------------------------------------------------------------------------

interface FilteredHookEntry {
  entry: HookEntry;
  hooks: Record<string, unknown[]>;
}

interface FilterDiagnostic {
  entryId: string;
  unsupportedEvents: string[];
  unsupportedHandlerTypes: string[];
  fullyFiltered: boolean;
}

function formatUnsupportedReason(diagnostic: FilterDiagnostic): string {
  const parts: string[] = [];
  if (diagnostic.unsupportedEvents.length > 0) {
    parts.push(`unsupported events: ${diagnostic.unsupportedEvents.join(', ')}`);
  }
  if (diagnostic.unsupportedHandlerTypes.length > 0) {
    parts.push(`unsupported handler types: ${diagnostic.unsupportedHandlerTypes.join(', ')}`);
  }
  const prefix = diagnostic.fullyFiltered
    ? 'hook has no Codex-compatible command handlers after filtering'
    : 'hook was partially filtered for Codex compatibility';
  return `${prefix} (${parts.join('; ')})`;
}

function filterForCodex(entries: readonly HookEntry[]): {
  entries: FilteredHookEntry[];
  diagnostics: FilterDiagnostic[];
} {
  const result: FilteredHookEntry[] = [];
  const diagnostics: FilterDiagnostic[] = [];

  for (const entry of entries) {
    const filteredHooks: Record<string, unknown[]> = {};
    const unsupportedEvents = new Set<string>();
    const unsupportedHandlerTypes = new Set<string>();

    for (const [event, groups] of Object.entries(entry.hooks)) {
      if (!CODEX_SUPPORTED_EVENTS.has(event)) {
        unsupportedEvents.add(event);
        continue;
      }

      const filteredGroups: unknown[] = [];
      for (const group of groups as Array<{ hooks?: Array<{ type?: string }> }>) {
        const filteredHandlers = (group.hooks ?? []).filter((h) => {
          const type = h.type ?? 'unknown';
          const supported = CODEX_SUPPORTED_HANDLER_TYPES.has(type);
          if (!supported) unsupportedHandlerTypes.add(type);
          return supported;
        });
        if (filteredHandlers.length > 0) {
          filteredGroups.push({ ...group, hooks: filteredHandlers });
        }
      }

      if (filteredGroups.length > 0) {
        filteredHooks[event] = filteredGroups;
      }
    }

    if (Object.keys(filteredHooks).length > 0) {
      result.push({ entry, hooks: filteredHooks });
    }
    if (unsupportedEvents.size > 0 || unsupportedHandlerTypes.size > 0) {
      diagnostics.push({
        entryId: entry.id,
        unsupportedEvents: [...unsupportedEvents].sort(),
        unsupportedHandlerTypes: [...unsupportedHandlerTypes].sort(),
        fullyFiltered: Object.keys(filteredHooks).length === 0,
      });
    }
  }

  return { entries: result, diagnostics };
}

// ---------------------------------------------------------------------------
// hooks.json I/O
// ---------------------------------------------------------------------------

function readHooksJson(
  filePath: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  try {
    if (fs.existsSync(filePath)) {
      return {
        ok: true,
        data: parseHooksJsonRoot(JSON.parse(fs.readFileSync(filePath, 'utf-8'))),
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, data: {} };
}

function parseHooksJsonRoot(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hooks.json has invalid shape: root must be an object');
  }
  return value as Record<string, unknown>;
}

function writeHooksJson(filePath: string, data: Record<string, unknown>): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

function rewriteHookDir(
  hooks: Record<string, unknown[]>,
  distributedDir: string,
  bundleHash?: string
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};

  for (const [event, groups] of Object.entries(hooks)) {
    result[event] = (groups as Array<{ hooks?: Array<{ command?: string }> }>).map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).map((handler) => {
        if (typeof handler.command !== 'string') return handler;
        return {
          ...handler,
          command: preferHomeVar(
            annotateBundleCommand(
              handler.command
                .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir),
              bundleHash
            )
          ),
        };
      }),
    }));
  }

  return result;
}

function annotateBundleCommand(command: string, bundleHash?: string): string {
  if (!bundleHash) return command;
  return `${command}\n# asb-bundle-sha256=${bundleHash}`;
}

function computeBundleHash(entry: HookEntry): string {
  const hash = createHash('sha256');
  const files = listHookBundleFiles(entry).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(file.sourcePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function mergeHooksIntoFile(
  fileData: Record<string, unknown>,
  filteredEntries: FilteredHookEntry[],
  scope?: ConfigScope,
  bundleHashes?: ReadonlyMap<string, string>
): void {
  const existingHooks = (fileData.hooks ?? {}) as Record<string, unknown[]>;

  // Remove previously ASB-managed matcher groups
  const cleanedHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(existingHooks)) {
    const kept = (groups as Array<Record<string, unknown>>).filter((g) => g._asb_source !== true);
    if (kept.length > 0) cleanedHooks[event] = kept;
  }

  // Merge filtered entries
  for (const { entry, hooks } of filteredEntries) {
    const resolvedHooks = entry.isBundle
      ? rewriteHookDir(hooks, resolveHookBundleTargetDir(entry, scope), bundleHashes?.get(entry.id))
      : hooks;

    for (const [event, groups] of Object.entries(resolvedHooks)) {
      if (!cleanedHooks[event]) cleanedHooks[event] = [];
      for (const group of groups) {
        cleanedHooks[event].push({ ...(group as Record<string, unknown>), _asb_source: true });
      }
    }
  }

  fileData.hooks = cleanedHooks;
  if (filteredEntries.length > 0) {
    fileData[ASB_MANAGED_KEY] = filteredEntries.map((f) => f.entry.id);
  } else {
    delete fileData[ASB_MANAGED_KEY];
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup for bundles
// ---------------------------------------------------------------------------

function cleanOrphanBundleDirs(
  activeIds: Set<string>,
  scope?: ConfigScope,
  dryRun?: boolean
): Array<BundleDistributionResult<CodexPlatform>> {
  const parentDir = resolveHooksBundleParentDir(scope);
  const results: Array<BundleDistributionResult<CodexPlatform>> = [];
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
          platform: 'codex',
          targetDir: dirPath,
          status: 'deleted',
          reason: 'orphan',
          entryId: entry.name,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: 'codex',
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
      platform: 'codex',
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: ${msg}`,
    });
  }

  return results;
}

function getOrphanBundleParentError(
  scope?: ConfigScope
): BundleDistributionResult<CodexPlatform> | undefined {
  const parentDir = resolveHooksBundleParentDir(scope);
  try {
    const safetyRoot = resolveHooksBundleSafetyRoot(scope);
    assertUsableBundleRoot(safetyRoot);
    assertNoSymlinkAncestor(safetyRoot, parentDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      platform: 'codex',
      targetDir: parentDir,
      status: 'error',
      error: `Failed to scan orphan parent: ${msg}`,
    };
  }

  const stat = lstatIfExists(parentDir);
  if (!stat) return undefined;
  if (!stat.isDirectory()) {
    return {
      platform: 'codex',
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
// Codex prerequisites: feature flag + project trust
// ---------------------------------------------------------------------------

type CodexDistributionResult =
  | DistributionResult<CodexPlatform>
  | BundleDistributionResult<CodexPlatform>;

function readCodexConfigToml():
  | { ok: true; filePath: string; data: Record<string, unknown> }
  | { ok: false; filePath: string; error: string } {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return { ok: true, filePath: configPath, data: {} };

  try {
    const data = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    return { ok: true, filePath: configPath, data };
  } catch (error) {
    return {
      ok: false,
      filePath: configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function getHooksFeatureValue(features: Record<string, unknown> | undefined): boolean | undefined {
  return asBoolean(features?.hooks) ?? asBoolean(features?.codex_hooks);
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function getEffectiveHooksEnabled(config: Record<string, unknown>): boolean {
  const baseValue = getHooksFeatureValue(getObject(config.features));
  const profileName = typeof config.profile === 'string' ? config.profile : undefined;
  const profiles = getObject(config.profiles);
  const profileConfig = profileName ? getObject(profiles?.[profileName]) : undefined;
  const profileValue = getHooksFeatureValue(getObject(profileConfig?.features));
  return profileValue ?? baseValue ?? true;
}

function addCodexHooksFeatureResult(
  config: { filePath: string; data: Record<string, unknown> },
  results: CodexDistributionResult[]
): void {
  const effectiveHooksEnabled = getEffectiveHooksEnabled(config.data);

  if (!effectiveHooksEnabled) {
    results.push({
      platform: 'codex',
      filePath: config.filePath,
      status: 'conflict',
      reason: 'features.hooks is disabled; enable it before Codex hooks can run',
    });
  }
}

function addProjectTrustResult(
  config: { filePath: string; data: Record<string, unknown> },
  projectRoot: string,
  results: CodexDistributionResult[]
): void {
  const projects = getObject(config.data.projects);
  const project = getObject(projects?.[path.resolve(projectRoot)]);
  const trustLevel = project?.trust_level;
  if (trustLevel === 'trusted') return;

  const reason =
    typeof trustLevel === 'string'
      ? `project is not trusted (trust_level="${trustLevel}"); Codex will ignore project hooks`
      : 'project is not trusted; Codex will ignore project hooks until trust_level = "trusted" is configured';
  results.push({ platform: 'codex', filePath: config.filePath, status: 'conflict', reason });
}

function addReviewResult(hooksJsonPath: string, results: CodexDistributionResult[]): void {
  results.push({
    platform: 'codex',
    filePath: hooksJsonPath,
    status: 'conflict',
    reason: 'open /hooks in Codex to review new or modified hooks before they can run',
  });
}

function addConfigParseResult(
  config: { ok: false; filePath: string; error: string },
  results: CodexDistributionResult[]
): void {
  results.push({
    platform: 'codex',
    filePath: config.filePath,
    status: 'conflict',
    reason: `Cannot parse config.toml to verify Codex hook prerequisites: ${config.error}`,
  });
}

// ---------------------------------------------------------------------------
// Main distribution entry point
// ---------------------------------------------------------------------------

export interface CodexHookDistributeOptions {
  scope?: ConfigScope;
  selected: readonly HookEntry[];
  dryRun?: boolean;
  projectMode?: 'managed' | 'exclusive' | 'none';
}

export function distributeCodexHooks(options: CodexHookDistributeOptions): {
  results: Array<DistributionResult<CodexPlatform> | BundleDistributionResult<CodexPlatform>>;
} {
  const { scope, selected, dryRun = false, projectMode } = options;

  if (scope?.project && projectMode === 'none') {
    return { results: [] };
  }

  const results: Array<
    DistributionResult<CodexPlatform> | BundleDistributionResult<CodexPlatform>
  > = [];

  // Pre-validate hooks.json before making any filesystem changes
  const hooksJsonPath = resolveHooksJsonPath(scope);
  const filterResult = filterForCodex(selected);
  const filteredEntries = filterResult.entries;
  for (const diagnostic of filterResult.diagnostics) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'skipped',
      reason: formatUnsupportedReason(diagnostic),
      entryId: diagnostic.entryId,
    });
  }

  const fileResult = readHooksJson(hooksJsonPath);

  if (!fileResult.ok) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'error',
      error: `Cannot read hooks.json, aborting merge: ${fileResult.error}`,
    });
    return { results };
  }

  const fileData = fileResult.data;

  // Validate hooks field shape: must be a Record<string, array> or absent
  if (fileData.hooks !== undefined) {
    if (
      typeof fileData.hooks !== 'object' ||
      fileData.hooks === null ||
      Array.isArray(fileData.hooks)
    ) {
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'error',
        error: 'hooks.json has invalid shape: "hooks" must be an object',
      });
      return { results };
    }
    for (const [event, groups] of Object.entries(fileData.hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) {
        results.push({
          platform: 'codex',
          filePath: hooksJsonPath,
          status: 'error',
          error: `hooks.json has invalid shape: "hooks.${event}" must be an array`,
        });
        return { results };
      }
    }
  }

  if (filteredEntries.length > 0) {
    const config = readCodexConfigToml();
    if (!config.ok) {
      addConfigParseResult(config, results);
    } else {
      addCodexHooksFeatureResult(config, results);
      if (scope?.project) addProjectTrustResult(config, scope.project, results);
    }
  }

  // Phase 1: Copy bundle files (only after validation passes)
  const bundleEntries = filteredEntries.filter((f) => f.entry.isBundle).map((f) => f.entry);
  const activeBundleIds = new Set(bundleEntries.map((e) => e.id));
  const bundleHashes = new Map<string, string>();
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, CodexPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: ['codex'],
      resolveTargetDir: (_p, entry) => resolveHookBundleTargetDir(entry, scope),
      resolveBundleRootDir: () => resolveHooksBundleSafetyRoot(scope),
      listFiles: listHookBundleFiles,
      getId: (entry) => entry.id,
      scope,
      dryRun,
    });
    results.push(...bundleOutcome.results);
    if (
      bundleOutcome.results.some(
        (result) => result.status === 'error' || result.status === 'conflict'
      )
    ) {
      return { results };
    }
    for (const entry of bundleEntries) {
      try {
        bundleHashes.set(entry.id, computeBundleHash(entry));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          platform: 'codex',
          filePath: hooksJsonPath,
          status: 'error',
          error: `Failed to hash bundle ${entry.id}: ${msg}`,
          entryId: entry.id,
        });
        return { results };
      }
    }
  }

  const cleanupParentError = getOrphanBundleParentError(scope);
  if (cleanupParentError) {
    results.push(cleanupParentError);
    return { results };
  }
  const appendCleanupResults = (): boolean => {
    const cleanupResults = cleanOrphanBundleDirs(activeBundleIds, scope, dryRun);
    results.push(...cleanupResults);
    return cleanupResults.some((result) => result.status === 'error');
  };

  // Phase 2: Merge hook configs into hooks.json
  const previouslyManaged = (fileData[ASB_MANAGED_KEY] ?? []) as string[];

  // Check for existing ASB groups
  const existingHooks = (fileData.hooks ?? {}) as Record<string, unknown[]>;
  const hasAsbGroups = Object.values(existingHooks).some((groups) =>
    (groups as Array<Record<string, unknown>>).some((g) => g._asb_source === true)
  );

  if (filteredEntries.length === 0 && previouslyManaged.length === 0 && !hasAsbGroups) {
    appendCleanupResults();
    return { results };
  }

  const before = JSON.stringify(fileData);
  mergeHooksIntoFile(fileData, filteredEntries, scope, bundleHashes);
  const preserveCleanupMarker = filteredEntries.length === 0 && previouslyManaged.length > 0;
  if (preserveCleanupMarker) {
    fileData[ASB_MANAGED_KEY] = previouslyManaged;
  }

  // Clean up empty state: if no hooks remain, remove the file entirely
  const mergedHooks = fileData.hooks as Record<string, unknown[]>;
  const totalGroups = Object.values(mergedHooks).reduce((sum, groups) => sum + groups.length, 0);
  const hasNoHooks = totalGroups === 0;

  if (hasNoHooks && filteredEntries.length === 0) {
    if (!preserveCleanupMarker) {
      delete fileData[ASB_MANAGED_KEY];
    }
    // If file has only hooks (now empty) and ASB keys, consider deleting
    const remainingKeys = Object.keys(fileData).filter((k) => k !== 'hooks');
    if (remainingKeys.length === 0 && fs.existsSync(hooksJsonPath) && !dryRun) {
      try {
        fs.unlinkSync(hooksJsonPath);
        results.push({
          platform: 'codex',
          filePath: hooksJsonPath,
          status: 'deleted',
          reason: 'no hooks remain',
        });
        appendCleanupResults();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
      }
      return { results };
    }
  }

  const after = JSON.stringify(fileData);
  const finalizeCleanupMarker = (): void => {
    if (!preserveCleanupMarker || dryRun) return;
    delete fileData[ASB_MANAGED_KEY];
    const finalHooks = fileData.hooks as Record<string, unknown[]>;
    const finalTotalGroups = Object.values(finalHooks).reduce(
      (sum, groups) => sum + groups.length,
      0
    );
    const finalRemainingKeys = Object.keys(fileData).filter((k) => k !== 'hooks');
    try {
      if (
        finalTotalGroups === 0 &&
        finalRemainingKeys.length === 0 &&
        fs.existsSync(hooksJsonPath)
      ) {
        fs.unlinkSync(hooksJsonPath);
        results.push({
          platform: 'codex',
          filePath: hooksJsonPath,
          status: 'deleted',
          reason: 'no hooks remain',
        });
      } else {
        writeHooksJson(hooksJsonPath, fileData);
        results.push({
          platform: 'codex',
          filePath: hooksJsonPath,
          status: 'written',
          reason: 'cleanup finalized',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
    }
  };

  if (before === after) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'skipped',
      reason: 'up-to-date',
    });
    if (!appendCleanupResults()) finalizeCleanupMarker();
  } else if (dryRun) {
    const reason =
      filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
    if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
    appendCleanupResults();
  } else {
    try {
      writeHooksJson(hooksJsonPath, fileData);
      const reason =
        filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
      if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
      if (!appendCleanupResults()) finalizeCleanupMarker();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
    }
  }

  return { results };
}
