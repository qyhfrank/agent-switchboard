import fs from 'node:fs';
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
import { distributeBundle, resolvedHomeDir } from '../library/distribute-bundle.js';
import {
  type BundleCleanupOptions,
  cleanLegacyAsbDir,
  cleanManagedBundleDirs,
  isSafeBundleDirName,
  removeV0428BundleDirs,
} from './bundle-dirs.js';
import type { HookEntry } from './library.js';
import { listHookBundleFiles } from './library.js';
import {
  collectV0428BundleDirs,
  filterRecognizedDesiredGroups,
  removeOwnedHookGroups,
  stripLegacyMarkerLines,
} from './ownership.js';
import { HOOK_DIR_PLACEHOLDER } from './schema.js';
import {
  allHookGroupsAppended,
  consumeLegacyManagedState,
  loadHookState,
  loadSharedHookState,
  retainedCleanupIds,
  saveHookState,
} from './state.js';
import {
  deleteJsonConfig,
  expandPortablePath,
  findTransactionArtifacts,
  preferHomeVar,
  publishJsonConfig,
  readJsonConfig,
} from './target-config.js';

type CodexPlatform = 'codex';

const CODEX_SUPPORTED_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'Stop',
]);

const CODEX_SUPPORTED_HANDLER_TYPES = new Set(['command']);

const MANAGED_HOOKS_SUBDIR = 'managed';
const LEGACY_ASB_HOOKS_SUBDIR = 'asb';
const LEGACY_ASB_MANAGED_KEY = '_asb_managed_hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS = '${CLAUDE_PLUGIN_ROOT}\\hooks';
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL = '$env:CLAUDE_PLUGIN_ROOT\\hooks';

function resolveHooksJsonPath(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) {
    return getProjectCodexHooksJsonPath(projectRoot);
  }
  return getCodexHooksJsonPath();
}

function codexRoot(scope?: ConfigScope): string {
  const projectRoot = scope?.project?.trim();
  if (projectRoot && projectRoot.length > 0) return getProjectCodexDir(projectRoot);
  return getCodexDir();
}

function managedBundleParentDir(scope?: ConfigScope): string {
  return path.join(codexRoot(scope), 'hooks', MANAGED_HOOKS_SUBDIR);
}

function legacyAsbParentDir(scope?: ConfigScope): string {
  return path.join(codexRoot(scope), 'hooks', LEGACY_ASB_HOOKS_SUBDIR);
}

function resolveHookBundleTargetDir(entry: HookEntry, scope?: ConfigScope): string {
  return path.join(managedBundleParentDir(scope), entry.id);
}

interface FilteredHookEntry {
  entry: HookEntry;
  hooks: Record<string, unknown[]>;
}

interface FilterDiagnostic {
  entryId: string;
  unsupportedEvents: string[];
  unsupportedHandlerTypes: string[];
  unsupportedOptions: string[];
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
  if (diagnostic.unsupportedOptions.length > 0) {
    parts.push(`unsupported options: ${diagnostic.unsupportedOptions.join(', ')}`);
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
    const filteredHooks: Record<string, unknown[]> = Object.create(null);
    const unsupportedEvents = new Set<string>();
    const unsupportedHandlerTypes = new Set<string>();
    const unsupportedOptions = new Set<string>();

    for (const [event, groups] of Object.entries(entry.hooks)) {
      if (!CODEX_SUPPORTED_EVENTS.has(event)) {
        unsupportedEvents.add(event);
        continue;
      }

      const filteredGroups: unknown[] = [];
      for (const group of groups) {
        const filteredHandlers = (group.hooks ?? []).flatMap((handler) => {
          const h = handler as Record<string, unknown>;
          const type = typeof h.type === 'string' ? h.type : 'unknown';
          if (!CODEX_SUPPORTED_HANDLER_TYPES.has(type)) {
            unsupportedHandlerTypes.add(type);
            return [];
          }
          if (typeof h.command !== 'string') {
            unsupportedOptions.add('command handler without a string command');
            return [];
          }
          const commandWindows = h.commandWindows ?? h.command_windows;
          if (commandWindows !== undefined && typeof commandWindows !== 'string') {
            unsupportedOptions.add('invalid Windows command');
            return [];
          }
          if (
            h.timeout !== undefined &&
            !(typeof h.timeout === 'number' && Number.isSafeInteger(h.timeout) && h.timeout >= 0)
          ) {
            unsupportedOptions.add('invalid command timeout');
            return [];
          }
          if (h.async === true) {
            unsupportedOptions.add('async command handlers');
            return [];
          }
          if (h.async !== undefined && typeof h.async !== 'boolean') {
            unsupportedOptions.add('invalid async option');
            return [];
          }
          if (h.statusMessage !== undefined && typeof h.statusMessage !== 'string') {
            unsupportedOptions.add('invalid status message');
            return [];
          }
          const allowedKeys = new Set([
            'type',
            'command',
            'commandWindows',
            'command_windows',
            'timeout',
            'async',
            'statusMessage',
          ]);
          const unknownKeys = Object.keys(h).filter((key) => !allowedKeys.has(key));
          if (unknownKeys.length > 0) {
            for (const key of unknownKeys) unsupportedOptions.add(key);
            return [];
          }
          return [
            {
              type: 'command',
              command: h.command,
              ...(commandWindows !== undefined ? { commandWindows } : {}),
              ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
              ...(h.async !== undefined ? { async: h.async } : {}),
              ...(h.statusMessage !== undefined ? { statusMessage: h.statusMessage } : {}),
            },
          ];
        });
        if (filteredHandlers.length > 0) {
          filteredGroups.push({
            ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
            hooks: filteredHandlers,
          });
        }
      }

      if (filteredGroups.length > 0) {
        filteredHooks[event] = filteredGroups;
      }
    }

    if (Object.keys(filteredHooks).length > 0) {
      result.push({ entry, hooks: filteredHooks });
    }
    if (
      unsupportedEvents.size > 0 ||
      unsupportedHandlerTypes.size > 0 ||
      unsupportedOptions.size > 0
    ) {
      diagnostics.push({
        entryId: entry.id,
        unsupportedEvents: [...unsupportedEvents].sort(),
        unsupportedHandlerTypes: [...unsupportedHandlerTypes].sort(),
        unsupportedOptions: [...unsupportedOptions].sort(),
        fullyFiltered: Object.keys(filteredHooks).length === 0,
      });
    }
  }

  return { entries: result, diagnostics };
}

function rewriteHookCommands(
  hooks: Record<string, unknown[]>,
  entry: HookEntry,
  scope?: ConfigScope
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = Object.create(null);
  const distributedDir = entry.isBundle ? resolveHookBundleTargetDir(entry, scope) : undefined;

  for (const [event, groups] of Object.entries(hooks)) {
    result[event] = (groups as Array<{ hooks?: Array<Record<string, unknown>> }>).map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).map((handler) => {
        const rewritten = { ...handler };
        for (const field of ['command', 'commandWindows'] as const) {
          const original = rewritten[field];
          if (typeof original !== 'string') continue;
          const command = distributedDir
            ? original
                .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL, distributedDir)
            : original;
          rewritten[field] = preferHomeVar(stripLegacyMarkerLines(command));
        }
        return rewritten;
      }),
    }));
  }

  return result;
}

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

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function getHooksFeatureValue(features: Record<string, unknown> | undefined): boolean | undefined {
  return asBoolean(features?.hooks) ?? asBoolean(features?.codex_hooks);
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
  if (!getEffectiveHooksEnabled(config.data)) {
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

export interface CodexHookDistributeOptions {
  scope?: ConfigScope;
  selected: readonly HookEntry[];
  dryRun?: boolean;
  projectMode?: 'managed' | 'exclusive' | 'none';
}

export function distributeCodexHooks(options: CodexHookDistributeOptions): {
  results: CodexDistributionResult[];
} {
  const { scope, selected, dryRun = false, projectMode } = options;
  if (scope?.project && projectMode === 'none') {
    return { results: [] };
  }

  const results: CodexDistributionResult[] = [];

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

  // v0.4.28 transaction leftovers may hold the only copy of the user's
  // config; never distribute over them.
  const artifacts = findTransactionArtifacts(hooksJsonPath);
  if (artifacts.length > 0) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'error',
      error:
        `config has unresolved transaction artifacts from an earlier version: ${artifacts.join(', ')}; ` +
        'restore or delete them, then re-run sync',
    });
    return { results };
  }

  const fileResult = readJsonConfig(hooksJsonPath);
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
      results.push({
        platform: 'codex',
        filePath: config.filePath,
        status: 'conflict',
        reason: `Cannot parse config.toml to verify Codex hook prerequisites: ${config.error}`,
      });
    } else {
      addCodexHooksFeatureResult(config, results);
      if (scope?.project) addProjectTrustResult(config, scope.project, results);
    }
  }

  const ownState = loadHookState('codex', scope);
  const sharedState = loadSharedHookState('codex', scope);
  const legacy = consumeLegacyManagedState('codex', scope);

  // Phase 1: copy bundle files
  let bundleChanged = false;
  const bundleEntries = filteredEntries.filter((f) => f.entry.isBundle).map((f) => f.entry);
  for (const entry of bundleEntries) {
    if (!isSafeBundleDirName(entry.id)) {
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'error',
        error: `hook id is not usable as a directory name: ${JSON.stringify(entry.id)}`,
        entryId: entry.id,
      });
      return { results };
    }
  }
  const activeBundleIds = new Set(bundleEntries.map((entry) => entry.id));
  if (bundleEntries.length > 0) {
    const bundleOutcome = distributeBundle<HookEntry, CodexPlatform>({
      section: 'hooks',
      selected: bundleEntries,
      platforms: ['codex'],
      resolveTargetDir: (_platform, entry) => resolveHookBundleTargetDir(entry, scope),
      resolveBundleRootDir: () => codexRoot(scope),
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
    bundleChanged = bundleOutcome.results.some((result) => result.status === 'written');
  }

  // Phase 2: merge hook configs into hooks.json
  const before = JSON.stringify(fileData);
  const existingHooks = (fileData.hooks ?? {}) as Record<string, unknown[]>;

  const managedParent = managedBundleParentDir(scope);
  const legacyParent = legacyAsbParentDir(scope);
  const removal = removeOwnedHookGroups(existingHooks, {
    legacyAsbRoots: [legacyParent, preferHomeVar(legacyParent)],
    managedRoots: [managedParent, preferHomeVar(managedParent)],
    knownManagedIds: new Set(ownState.bundles),
    stateGroups: [ownState.events],
  });

  const hadLegacyManagedKey = Object.hasOwn(fileData, LEGACY_ASB_MANAGED_KEY);
  delete fileData[LEGACY_ASB_MANAGED_KEY];

  let retainedManagedBundles: string[] = [];
  let retainedLegacyBundles: string[] = [];
  const appendCleanupResults = (): void => {
    const cleanupOpts: BundleCleanupOptions<CodexPlatform> = {
      platform: 'codex',
      parentDir: managedParent,
      safetyRoot: codexRoot(scope),
      dryRun,
    };
    const managedCandidates = new Set(ownState.bundles.filter((id) => !activeBundleIds.has(id)));
    const managedCleanup = cleanManagedBundleDirs(cleanupOpts, activeBundleIds, managedCandidates);
    retainedManagedBundles = retainedCleanupIds(managedCandidates, managedCleanup);
    results.push(...managedCleanup);
    const legacyCandidates = new Set([...ownState.legacyBundles, ...removal.removedLegacyAsbIds]);
    const legacyCleanup = cleanLegacyAsbDir(
      { ...cleanupOpts, parentDir: legacyParent },
      legacyCandidates
    );
    retainedLegacyBundles = retainedCleanupIds(legacyCandidates, legacyCleanup);
    results.push(...legacyCleanup);
    let realCodexRoot: string;
    try {
      realCodexRoot = fs.realpathSync(codexRoot(scope));
    } catch {
      realCodexRoot = codexRoot(scope);
    }
    const projectRoot = scope?.project?.trim();
    const containRoots = projectRoot ? [realCodexRoot] : [resolvedHomeDir(), realCodexRoot];
    if (projectRoot) {
      try {
        containRoots.push(fs.realpathSync(path.resolve(projectRoot)));
      } catch {
        containRoots.push(path.resolve(projectRoot));
      }
    }
    results.push(
      ...removeV0428BundleDirs(
        'codex',
        new Set([...collectV0428BundleDirs(removal.v0428Commands)].map(expandPortablePath)),
        dryRun,
        containRoots
      )
    );
  };

  const stateHasContent =
    Object.keys(ownState.events).length > 0 ||
    ownState.bundles.length > 0 ||
    ownState.legacyBundles.length > 0;
  const nothingToDo =
    filteredEntries.length === 0 && !removal.removed && !hadLegacyManagedKey && !stateHasContent;
  if (nothingToDo) {
    appendCleanupResults();
    return { results };
  }

  const mergedHooks: Record<string, unknown[]> = Object.create(null);
  for (const [event, groups] of Object.entries(removal.hooks)) {
    mergedHooks[event] = [...groups];
  }
  const managedEvents: Record<string, unknown[]> = {};
  for (const { entry, hooks } of filteredEntries) {
    for (const [event, groups] of Object.entries(rewriteHookCommands(hooks, entry, scope))) {
      if (!Object.hasOwn(managedEvents, event)) managedEvents[event] = [];
      managedEvents[event].push(...groups);
    }
  }
  const toAppend = filterRecognizedDesiredGroups(removal.hooks, managedEvents, [
    sharedState.events,
    ...legacy.groups,
  ]);
  const ownedBundleIds = filteredEntries
    .filter(
      ({ entry, hooks }) =>
        entry.isBundle &&
        allHookGroupsAppended(rewriteHookCommands(hooks, entry, scope), managedEvents, toAppend)
    )
    .map(({ entry }) => entry.id);
  for (const [event, groups] of Object.entries(toAppend)) {
    if (!mergedHooks[event]) mergedHooks[event] = [];
    mergedHooks[event].push(...groups);
  }
  if (Object.keys(mergedHooks).length === 0) {
    delete fileData.hooks;
  } else {
    fileData.hooks = { ...mergedHooks };
  }

  const persistState = (): void => {
    if (dryRun) return;
    saveHookState(
      'codex',
      {
        version: 1,
        events: toAppend,
        bundles: [...ownedBundleIds, ...retainedManagedBundles],
        legacyBundles: retainedLegacyBundles,
      },
      scope
    );
  };

  // No hooks remain and the file holds nothing else: remove it entirely.
  const totalGroups = Object.values(mergedHooks).reduce((sum, groups) => sum + groups.length, 0);
  if (totalGroups === 0 && filteredEntries.length === 0) {
    const remainingKeys = Object.keys(fileData).filter((key) => key !== 'hooks');
    if (remainingKeys.length === 0 && fs.existsSync(hooksJsonPath)) {
      if (!dryRun) {
        try {
          deleteJsonConfig(hooksJsonPath);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
          return { results };
        }
      }
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'deleted',
        reason: 'no hooks remain',
      });
      appendCleanupResults();
      persistState();
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
    // Changed bundle scripts need re-review even when hooks.json is unchanged.
    if (bundleChanged) addReviewResult(hooksJsonPath, results);
    appendCleanupResults();
    persistState();
    return { results };
  }

  const reason =
    filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
  if (dryRun) {
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
    if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
    appendCleanupResults();
    return { results };
  }

  try {
    publishJsonConfig(hooksJsonPath, fileData);
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
    if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
    appendCleanupResults();
    persistState();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
  }

  return { results };
}
