/**
 * Codex hook distribution: writes hooks.json and copies bundle files.
 *
 * Codex reads hooks from ~/.codex/hooks.json (global) and
 * <project>/.codex/hooks.json (project scope). Unlike Claude Code which
 * embeds hooks inside settings.json, Codex uses a dedicated file.
 *
 * Codex only supports: command handlers, 5 event types, no ${HOOK_DIR}
 * runtime expansion. ASB must filter unsupported entries and rewrite
 * bundle paths to absolute paths before writing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getCodexDir,
  getCodexHooksJsonPath,
  getProjectCodexDir,
  getProjectCodexHooksJsonPath,
} from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import type { DistributionResult } from '../library/distribute.js';
import type { BundleDistributionResult } from '../library/distribute-bundle.js';
import { distributeBundle } from '../library/distribute-bundle.js';
import { ensureParentDir, rmDirRecursive } from '../library/fs.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles } from './library.js';
import { HOOK_DIR_PLACEHOLDER } from './schema.js';

type CodexPlatform = 'codex';

const CODEX_SUPPORTED_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
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

function filterForCodex(entries: readonly HookEntry[]): FilteredHookEntry[] {
  const result: FilteredHookEntry[] = [];

  for (const entry of entries) {
    const filteredHooks: Record<string, unknown[]> = {};

    for (const [event, groups] of Object.entries(entry.hooks)) {
      if (!CODEX_SUPPORTED_EVENTS.has(event)) continue;

      const filteredGroups: unknown[] = [];
      for (const group of groups as Array<{ hooks?: Array<{ type?: string }> }>) {
        const filteredHandlers = (group.hooks ?? []).filter((h) =>
          CODEX_SUPPORTED_HANDLER_TYPES.has(h.type ?? '')
        );
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
  }

  return result;
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
        data: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>,
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, data: {} };
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
  distributedDir: string
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
            handler.command
              .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
              .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
              .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
          ),
        };
      }),
    }));
  }

  return result;
}

function mergeHooksIntoFile(
  fileData: Record<string, unknown>,
  filteredEntries: FilteredHookEntry[],
  scope?: ConfigScope
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
      ? rewriteHookDir(hooks, resolveHookBundleTargetDir(entry, scope))
      : hooks;

    for (const [event, groups] of Object.entries(resolvedHooks)) {
      if (!cleanedHooks[event]) cleanedHooks[event] = [];
      for (const group of groups) {
        cleanedHooks[event].push({ ...(group as Record<string, unknown>), _asb_source: true });
      }
    }
  }

  fileData.hooks = cleanedHooks;
  fileData[ASB_MANAGED_KEY] = filteredEntries.map((f) => f.entry.id);
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

  if (!fs.existsSync(parentDir)) return results;

  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (activeIds.has(entry.name)) continue;

      const dirPath = path.join(parentDir, entry.name);
      try {
        if (!dryRun) rmDirRecursive(dirPath);
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
  } catch {
    // Ignore directory read errors
  }

  return results;
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

  // Filter entries for Codex compatibility
  const filteredEntries = filterForCodex(selected);

  // Pre-validate hooks.json before making any filesystem changes
  const hooksJsonPath = resolveHooksJsonPath(scope);
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

  // Phase 1: Copy bundle files (only after validation passes)
  const bundleEntries = filteredEntries.filter((f) => f.entry.isBundle).map((f) => f.entry);
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, CodexPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: ['codex'],
      resolveTargetDir: (_p, entry) => resolveHookBundleTargetDir(entry, scope),
      listFiles: listHookBundleFiles,
      getId: (entry) => entry.id,
      scope,
      dryRun,
    });
    results.push(...bundleOutcome.results);
  }

  // Clean up orphan bundle directories
  const activeBundleIds = new Set(bundleEntries.map((e) => e.id));
  results.push(...cleanOrphanBundleDirs(activeBundleIds, scope, dryRun));

  // Phase 2: Merge hook configs into hooks.json
  const previouslyManaged = (fileData[ASB_MANAGED_KEY] ?? []) as string[];

  // Check for existing ASB groups
  const existingHooks = (fileData.hooks ?? {}) as Record<string, unknown[]>;
  const hasAsbGroups = Object.values(existingHooks).some((groups) =>
    (groups as Array<Record<string, unknown>>).some((g) => g._asb_source === true)
  );

  if (filteredEntries.length === 0 && previouslyManaged.length === 0 && !hasAsbGroups) {
    return { results };
  }

  const before = JSON.stringify(fileData);
  mergeHooksIntoFile(fileData, filteredEntries, scope);

  // Clean up empty state: if no hooks remain, remove the file entirely
  const mergedHooks = fileData.hooks as Record<string, unknown[]>;
  const totalGroups = Object.values(mergedHooks).reduce((sum, groups) => sum + groups.length, 0);
  const hasNoHooks = totalGroups === 0;

  if (hasNoHooks && filteredEntries.length === 0) {
    // Remove ASB tracking keys
    delete fileData[ASB_MANAGED_KEY];
    // If file has only hooks (now empty) and ASB keys, consider deleting
    const remainingKeys = Object.keys(fileData).filter((k) => k !== 'hooks');
    if (remainingKeys.length === 0 && fs.existsSync(hooksJsonPath) && !dryRun) {
      fs.unlinkSync(hooksJsonPath);
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'deleted',
        reason: 'no hooks remain',
      });
      return { results };
    }
  }

  const after = JSON.stringify(fileData);

  if (before === after) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'skipped',
      reason: 'up-to-date',
    });
  } else if (dryRun) {
    const reason =
      filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
  } else {
    try {
      writeHooksJson(hooksJsonPath, fileData);
      const reason =
        filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
    }
  }

  return { results };
}
