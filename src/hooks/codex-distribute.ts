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
import {
  assertNoSymlinkAncestor,
  assertUsableBundleRoot,
  type BundleDistributionResult,
  distributeBundle,
  resolvedHomeDir,
} from '../library/distribute-bundle.js';
import {
  type BundleCleanupDeleteGuard,
  captureBundleCleanupEntries,
  cleanBundleDirectories,
  removeBundleTree,
} from './bundle-cleanup.js';
import {
  type CapturedHookBundle,
  captureHookBundle,
  captureHookDefinition,
  hookBundleDeploymentKey,
  materializeHookBundleSnapshots,
  requireHookBundleHash,
} from './bundle-snapshot.js';
import { commandContainsPathToken } from './legacy-command.js';
import type { HookEntry } from './library.js';
import {
  assertManagedHookConfigSnapshot,
  clearLegacyHookBundleCleanup,
  commitManagedHookUpdate,
  getManagedHookPrefixLengths,
  hasManagedHookGroups,
  type LegacyHookBundleCleanupEntry,
  loadManagedHookGroups,
  type ManagedHookGroups,
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
import { HOOK_DIR_PLACEHOLDER } from './schema.js';

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

// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX = '${CLAUDE_PLUGIN_ROOT}/hooks';
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS = '${CLAUDE_PLUGIN_ROOT}\\hooks';
const CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL = '$env:CLAUDE_PLUGIN_ROOT\\hooks';

const LEGACY_ASB_MANAGED_KEY = '_asb_managed_hooks';
const MANAGED_HOOKS_SUBDIR = 'managed';
const LEGACY_ASB_HOOKS_SUBDIR = 'asb';
const MANAGED_BUNDLE_NAMESPACE_SEED = 'agent-switchboard\0codex\0hooks';
const LEGACY_ASB_COMMAND_MARKER = '# asb-managed-by=agent-switchboard';
const LEGACY_ASB_HOOK_ID_MARKER_PREFIX = '# asb-hook-id=';
const LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX = '# asb-bundle-sha256=';

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
    return path.join(getProjectCodexDir(projectRoot), ...parts);
  }
  return path.join(getCodexDir(), ...parts);
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
    return getProjectCodexDir(projectRoot);
  }
  return getCodexDir();
}

function resolveHookBundleTargetDir(
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
    const filteredHooks: Record<string, unknown[]> = {};
    const unsupportedEvents = new Set<string>();
    const unsupportedHandlerTypes = new Set<string>();
    const unsupportedOptions = new Set<string>();

    for (const [event, groups] of Object.entries(entry.hooks)) {
      if (!CODEX_SUPPORTED_EVENTS.has(event)) {
        unsupportedEvents.add(event);
        continue;
      }

      const filteredGroups: unknown[] = [];
      for (const group of groups as Array<{
        matcher?: unknown;
        hooks?: Array<{
          type?: string;
          command?: unknown;
          commandWindows?: unknown;
          command_windows?: unknown;
          timeout?: unknown;
          async?: unknown;
          statusMessage?: unknown;
          [key: string]: unknown;
        }>;
      }>) {
        const filteredHandlers = (group.hooks ?? []).flatMap((h) => {
          const type = h.type ?? 'unknown';
          if (!CODEX_SUPPORTED_HANDLER_TYPES.has(type) || type !== 'command') {
            unsupportedHandlerTypes.add(type);
            return [];
          }
          if (typeof h.command !== 'string') {
            unsupportedOptions.add('command without a string command');
            return [];
          }
          const commandWindows = h.commandWindows ?? h.command_windows;
          if (commandWindows !== undefined && typeof commandWindows !== 'string') {
            unsupportedOptions.add('invalid Windows command');
            return [];
          }
          if (
            h.timeout !== undefined &&
            (!Number.isSafeInteger(h.timeout) || (h.timeout as number) < 0)
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
          for (const key of Object.keys(h)) {
            if (!allowedKeys.has(key)) unsupportedOptions.add(key);
          }
          return [
            {
              type: 'command',
              command: h.command,
              ...(commandWindows !== undefined ? { commandWindows } : {}),
              ...(h.timeout !== undefined ? { timeout: h.timeout as number } : {}),
              ...(h.async !== undefined ? { async: h.async as boolean } : {}),
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

function normalizeCodexWindowsCommandAliases(hooks: Record<string, unknown[]>): void {
  for (const groups of Object.values(hooks)) {
    for (const group of groups as Array<{
      hooks?: Array<{ commandWindows?: string; command_windows?: string }>;
    }>) {
      for (const handler of group.hooks ?? []) {
        const commandWindows = handler.commandWindows ?? handler.command_windows;
        if (commandWindows !== undefined) handler.commandWindows = commandWindows;
        delete handler.command_windows;
      }
    }
  }
}

function validateNativeCodexHooksFile(
  fileData: Record<string, unknown>
): Record<string, unknown[]> | undefined {
  const allowedRootKeys = new Set(['description', 'hooks', LEGACY_ASB_MANAGED_KEY]);
  if (Object.keys(fileData).some((key) => !allowedRootKeys.has(key))) return undefined;
  if (
    fileData.description !== undefined &&
    fileData.description !== null &&
    typeof fileData.description !== 'string'
  ) {
    return undefined;
  }
  const hooksValue = fileData.hooks;
  if (hooksValue === undefined) return {};
  if (typeof hooksValue !== 'object' || hooksValue === null || Array.isArray(hooksValue)) {
    return undefined;
  }
  const hooks = hooksValue as Record<string, unknown>;
  for (const groupsValue of Object.values(hooks)) {
    if (!Array.isArray(groupsValue)) return undefined;
    for (const groupValue of groupsValue) {
      if (typeof groupValue !== 'object' || groupValue === null || Array.isArray(groupValue)) {
        return undefined;
      }
      const group = groupValue as Record<string, unknown>;
      if (
        group.matcher !== undefined &&
        group.matcher !== null &&
        typeof group.matcher !== 'string'
      ) {
        return undefined;
      }
      if (group.hooks === undefined) continue;
      if (!Array.isArray(group.hooks)) return undefined;
      for (const handlerValue of group.hooks) {
        if (
          typeof handlerValue !== 'object' ||
          handlerValue === null ||
          Array.isArray(handlerValue)
        ) {
          return undefined;
        }
        const handler = handlerValue as Record<string, unknown>;
        if (
          Object.hasOwn(handler, 'commandWindows') &&
          Object.hasOwn(handler, 'command_windows') &&
          handler.commandWindows !== handler.command_windows
        ) {
          return undefined;
        }
        if (handler.type === 'prompt' || handler.type === 'agent') continue;
        if (handler.type !== 'command' || typeof handler.command !== 'string') return undefined;
        if (
          (handler.commandWindows !== undefined &&
            handler.commandWindows !== null &&
            typeof handler.commandWindows !== 'string') ||
          (handler.command_windows !== undefined &&
            handler.command_windows !== null &&
            typeof handler.command_windows !== 'string') ||
          (handler.timeout !== undefined &&
            handler.timeout !== null &&
            (!Number.isSafeInteger(handler.timeout) || (handler.timeout as number) < 0)) ||
          (handler.async !== undefined && typeof handler.async !== 'boolean') ||
          (handler.statusMessage !== undefined &&
            handler.statusMessage !== null &&
            typeof handler.statusMessage !== 'string')
        ) {
          return undefined;
        }
      }
    }
  }
  return hooks as Record<string, unknown[]>;
}

// ---------------------------------------------------------------------------
// hooks.json I/O
// ---------------------------------------------------------------------------

function readHooksJson(filePath: string):
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
      throw new Error(`hooks.json is not a regular file: ${filePath}`);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error('hooks.json changed while it was being read');
    }
    const raw = fs.readFileSync(fd, 'utf-8');
    return {
      ok: true,
      data: parseHooksJsonRoot(JSON.parse(raw)),
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

function parseHooksJsonRoot(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hooks.json has invalid shape: root must be an object');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config merge
// ---------------------------------------------------------------------------

function rewriteHookCommands(
  hooks: Record<string, unknown[]>,
  entry: HookEntry,
  scope?: ConfigScope,
  bundleHash?: string,
  address?: ManagedHookTransactionAddress
): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  const distributedDir =
    entry.isBundle && bundleHash && address
      ? resolveHookBundleTargetDir(entry, bundleHash, scope, address)
      : undefined;

  for (const [event, groups] of Object.entries(hooks)) {
    result[event] = (
      groups as Array<{
        hooks?: Array<{
          command?: string;
          commandWindows?: string;
          command_windows?: string;
        }>;
      }>
    ).map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).map((handler) => {
        const rewritten = { ...handler };
        const commands = {
          command: handler.command,
          commandWindows: handler.commandWindows ?? handler.command_windows,
        };
        delete rewritten.command_windows;
        for (const field of ['command', 'commandWindows'] as const) {
          const original = commands[field];
          if (typeof original !== 'string') continue;
          const command = distributedDir
            ? original
                .replaceAll(HOOK_DIR_PLACEHOLDER, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_WINDOWS, distributedDir)
                .replaceAll(CLAUDE_PLUGIN_ROOT_HOOKS_PREFIX_POWERSHELL, distributedDir)
            : original;
          rewritten[field] = preferHomeVar(stripHookCommandMetadata(command).trimEnd());
        }
        return rewritten;
      }),
    }));
  }

  return result;
}

function stripHookCommandMetadata(command: string): string {
  return command
    .split(/\r?\n/)
    .filter((line) => !isHookCommandMetadataLine(line.trim()))
    .join('\n');
}

function isHookCommandMetadataLine(line: string): boolean {
  return (
    line === LEGACY_ASB_COMMAND_MARKER ||
    line.startsWith(LEGACY_ASB_HOOK_ID_MARKER_PREFIX) ||
    line.startsWith(LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX)
  );
}

function mergeHooksIntoFile(
  fileData: Record<string, unknown>,
  filteredEntries: FilteredHookEntry[],
  cleanedHooks: ManagedHookGroups,
  scope?: ConfigScope,
  bundleHashes?: ReadonlyMap<string, string>,
  address?: ManagedHookTransactionAddress
): ManagedHookGroups {
  const managed: ManagedHookGroups = {};

  for (const { entry, hooks } of filteredEntries) {
    const resolvedHooks = rewriteHookCommands(
      hooks,
      entry,
      scope,
      bundleHashes?.get(entry.id),
      address
    );

    for (const [event, groups] of Object.entries(resolvedHooks)) {
      if (!cleanedHooks[event]) cleanedHooks[event] = [];
      for (const group of groups) {
        const cleanGroup = { ...(group as Record<string, unknown>) };
        delete cleanGroup._asb_source;
        cleanedHooks[event].push(cleanGroup);
        if (!managed[event]) managed[event] = [];
        managed[event].push(cleanGroup);
      }
    }
  }

  fileData.hooks = cleanedHooks;
  delete fileData[LEGACY_ASB_MANAGED_KEY];
  return managed;
}

function collectLegacyBundleIds(
  fileData: Record<string, unknown>,
  hooks: ManagedHookGroups,
  scope: ConfigScope | undefined,
  address: ManagedHookTransactionAddress
): string[] {
  const configuredIds = getLegacyManagedIds(fileData);
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
          const pathId = extractLegacyBundleId(normalized, '.codex');
          const markerId = extractLegacyMarkerBundleId(command);
          if (
            pathId &&
            (legacyParents.some((parent) => commandContainsPathToken(normalized, parent)) ||
              (group._asb_source === true && configuredIds.has(pathId)))
          ) {
            ids.add(pathId);
          }
          if (markerId) ids.add(markerId);
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
    ? [path.join(getProjectCodexDir(address.projectRootAlias), 'hooks', LEGACY_ASB_HOOKS_SUBDIR)]
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

function extractLegacyMarkerBundleId(command: string): string | undefined {
  const lines = command.split(/\r?\n/).map((line) => line.trim());
  const hasBundleHash = lines.some((line) => {
    if (!line.startsWith(LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX)) return false;
    return /^[0-9a-f]{64}$/i.test(line.slice(LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX.length));
  });
  if (!hasBundleHash) return undefined;
  for (const trimmed of lines) {
    if (!trimmed.startsWith(LEGACY_ASB_HOOK_ID_MARKER_PREFIX)) continue;
    let id: string;
    try {
      id = decodeURIComponent(trimmed.slice(LEGACY_ASB_HOOK_ID_MARKER_PREFIX.length));
    } catch {
      continue;
    }
    if (isSafeBundleId(id)) return id;
  }
  return undefined;
}

function isLegacyAsbCodexHandler(
  hook: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): boolean {
  const legacyParents = resolveLegacyBundleParents(scope, address);
  return ['command', 'commandWindows', 'command_windows'].some((field) => {
    const command = hook[field];
    if (typeof command !== 'string') return false;
    const normalized = command.replaceAll('\\', '/');
    return (
      commandHasLegacyAsbMarker(command) ||
      legacyParents.some((parent) => commandContainsPathToken(normalized, parent))
    );
  });
}

function isLegacyAsbManagedCodexGroup(
  group: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): boolean {
  if (group._asb_source === true) return true;
  const hooks = group.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => isLegacyAsbCodexHandler(hook as Record<string, unknown>, scope, address))
  );
}

function cleanLegacyAsbCodexGroup(
  group: Record<string, unknown>,
  scope?: ConfigScope,
  address?: ManagedHookTransactionAddress
): Record<string, unknown> | undefined {
  const hooks = Array.isArray(group.hooks) ? group.hooks : [];
  const keptHooks = hooks.filter(
    (hook) => !isLegacyAsbCodexHandler(hook as Record<string, unknown>, scope, address)
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

function commandHasLegacyAsbMarker(command: string): boolean {
  return command.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === LEGACY_ASB_COMMAND_MARKER ||
      trimmed.startsWith(LEGACY_ASB_HOOK_ID_MARKER_PREFIX) ||
      trimmed.startsWith(LEGACY_ASB_BUNDLE_HASH_MARKER_PREFIX)
    );
  });
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
): Array<BundleDistributionResult<CodexPlatform>> {
  const parentDir = resolveHooksBundleParentDir(scope, subdir, address);
  const results: Array<BundleDistributionResult<CodexPlatform>> = [];
  const parentError = getOrphanBundleParentError(scope, subdir, address);

  if (parentError) {
    results.push(parentError);
    return results;
  }
  return cleanBundleDirectories({
    platform: 'codex',
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
): BundleDistributionResult<CodexPlatform> | undefined {
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
  removeBundleTree(targetPath);
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
  const hooksJsonPath = resolveHooksJsonPath(options.scope);
  if (options.scope?.project && options.projectMode === 'none') return { results: [] };

  try {
    if (options.dryRun) {
      const address = resolveManagedHookTransactionAddress(
        'codex',
        hooksJsonPath,
        options.scope?.project ?? undefined
      );
      return distributeCodexHooksLocked(options, hooksJsonPath, address);
    }
    return withManagedHookLock(
      'codex',
      hooksJsonPath,
      (address) => distributeCodexHooksLocked(options, hooksJsonPath, address),
      options.scope?.project ?? undefined
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      results: [{ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg }],
    };
  }
}

function distributeCodexHooksLocked(
  options: CodexHookDistributeOptions,
  hooksJsonPath: string,
  address: ManagedHookTransactionAddress
): {
  results: Array<DistributionResult<CodexPlatform> | BundleDistributionResult<CodexPlatform>>;
} {
  const { scope, selected, dryRun = false, projectMode } = options;

  if (scope?.project && projectMode === 'none') {
    return { results: [] };
  }

  const results: Array<
    DistributionResult<CodexPlatform> | BundleDistributionResult<CodexPlatform>
  > = [];

  const managedState = loadManagedHookGroups(
    'codex',
    hooksJsonPath,
    scope?.project ?? undefined,
    address,
    !dryRun
  );
  if (!managedState.ok) {
    results.push({
      platform: 'codex',
      filePath: managedState.filePath,
      status: 'error',
      error: `Cannot read managed hook state, aborting hooks merge: ${managedState.error}`,
    });
    return { results };
  }

  const fileResult = readHooksJson(address.writePath);

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
  const before = JSON.stringify(fileData);

  const existingHooks = validateNativeCodexHooksFile(fileData);
  if (!existingHooks) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'error',
      error: 'hooks.json has invalid hook configuration',
    });
    return { results };
  }
  normalizeCodexWindowsCommandAliases(existingHooks);
  fileData.hooks = existingHooks;
  const normalizedInput = before !== JSON.stringify(fileData);

  if (managedState.pending && !dryRun) {
    try {
      assertManagedHookConfigSnapshot(
        address,
        fileResult.raw,
        fileResult.mode,
        fileResult.identity
      );
      saveManagedHookGroups(
        'codex',
        hooksJsonPath,
        managedState.hooks,
        managedState.prefixLengths,
        scope?.project ?? undefined,
        address
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        platform: 'codex',
        filePath: managedState.filePath,
        status: 'error',
        error: msg,
      });
      return { results };
    }
  }

  const definitionSelected: HookEntry[] = [];
  try {
    for (const entry of selected) {
      definitionSelected.push(
        entry.isBundle ? { ...entry, hooks: captureHookDefinition(entry) } : entry
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'error',
      error: `Failed to capture hook definition: ${msg}`,
    });
    return { results };
  }

  const definitionFilter = filterForCodex(definitionSelected);
  const supportedBundleIds = new Set(
    definitionFilter.entries.filter(({ entry }) => entry.isBundle).map(({ entry }) => entry.id)
  );
  const bundleSnapshots = new Map<string, CapturedHookBundle>();
  const bundleHashes = new Map<string, string>();
  try {
    for (const entry of selected) {
      if (!entry.isBundle || !supportedBundleIds.has(entry.id)) continue;
      const snapshot = captureHookBundle(entry);
      bundleSnapshots.set(entry.id, snapshot);
      bundleHashes.set(entry.id, snapshot.hash);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'error',
      error: `Failed to capture bundle: ${msg}`,
    });
    return { results };
  }
  const effectiveSelected = selected.flatMap((entry) => {
    if (!entry.isBundle) return [entry];
    const snapshot = bundleSnapshots.get(entry.id);
    return snapshot ? [{ ...entry, hooks: snapshot.hooks }] : [];
  });
  const filterResult = filterForCodex(effectiveSelected);
  const filteredEntries = filterResult.entries;
  const diagnostics = [
    ...definitionFilter.diagnostics.filter(
      (diagnostic) =>
        diagnostic.fullyFiltered &&
        definitionSelected.some((entry) => entry.isBundle && entry.id === diagnostic.entryId)
    ),
    ...filterResult.diagnostics,
  ];
  for (const diagnostic of diagnostics) {
    results.push({
      platform: 'codex',
      filePath: hooksJsonPath,
      status: 'skipped',
      reason: formatUnsupportedReason(diagnostic),
      entryId: diagnostic.entryId,
    });
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

  const bundleEntries = filteredEntries.filter((f) => f.entry.isBundle).map((f) => f.entry);

  const activeBundleDirs = new Set(
    bundleEntries.map((entry) =>
      hookBundleDeploymentKey(entry, requireHookBundleHash(bundleHashes, entry))
    )
  );

  const cleanupParentError = getOrphanBundleParentError(scope, MANAGED_HOOKS_SUBDIR, address);
  if (cleanupParentError) {
    results.push(cleanupParentError);
    return { results };
  }
  const hadLegacyManagedKey =
    Object.getOwnPropertyDescriptor(fileData, LEGACY_ASB_MANAGED_KEY) !== undefined;
  const activeLegacyBundleIds = new Set<string>();
  for (const { entry, hooks } of filteredEntries) {
    const resolvedHooks = rewriteHookCommands(
      hooks,
      entry,
      scope,
      bundleHashes.get(entry.id),
      address
    );
    for (const id of collectLegacyBundleIds({}, resolvedHooks, scope, address)) {
      activeLegacyBundleIds.add(id);
    }
  }
  const legacyBundleIds = collectLegacyBundleIds(fileData, existingHooks, scope, address).filter(
    (id) => !activeLegacyBundleIds.has(id)
  );
  delete fileData[LEGACY_ASB_MANAGED_KEY];

  const removal = removeManagedHookGroups(
    existingHooks,
    managedState.hooks,
    managedState.prefixLengths,
    (group) => cleanLegacyAsbCodexGroup(group, scope, address)
  );
  if (hasManagedHookGroups(removal.unmatched)) {
    results.push({
      platform: 'codex',
      filePath: managedState.filePath,
      status: 'conflict',
      reason: 'managed hook state does not match the application config; resolve hook drift',
    });
    return { results };
  }
  const hasAsbGroups = Object.values(existingHooks).some((groups) =>
    (groups as Array<Record<string, unknown>>).some((g) =>
      isLegacyAsbManagedCodexGroup(g, scope, address)
    )
  );
  let pendingLegacyBundles: LegacyHookBundleCleanupEntry[];
  let capturedLegacyBundles: Array<{ id: string; fingerprint: string }> = [];
  try {
    pendingLegacyBundles = readPendingLegacyHookBundleCleanup(address);
    if ((hadLegacyManagedKey || hasAsbGroups) && legacyBundleIds.length > 0) {
      const parentError = getOrphanBundleParentError(scope, LEGACY_ASB_HOOKS_SUBDIR, address);
      if (parentError) {
        results.push(parentError);
        return { results };
      }
      capturedLegacyBundles = captureBundleCleanupEntries(
        resolveHooksBundleParentDir(scope, LEGACY_ASB_HOOKS_SUBDIR, address),
        legacyBundleIds
      );
    }
  } catch (error) {
    results.push({
      platform: 'codex',
      filePath: managedState.filePath,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return { results };
  }
  const initialConfigHash = managedHookConfigHash(fileResult.raw);
  const appendCleanupResults = (
    expectedConfig: string | undefined,
    expectedMode?: number,
    expectedIdentity?: string
  ): boolean => {
    const verifyCurrent = dryRun
      ? undefined
      : () =>
          assertManagedHookConfigSnapshot(address, expectedConfig, expectedMode, expectedIdentity);
    try {
      verifyCurrent?.();
    } catch (error) {
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
    const deleteGuard: BundleCleanupDeleteGuard | undefined = dryRun
      ? undefined
      : {
          configAliasPath: address.configPath,
          configPath: address.writePath,
          configHash: managedHookConfigHash(expectedConfig),
          ...(expectedMode !== undefined ? { configMode: expectedMode } : {}),
          ...(expectedIdentity !== undefined ? { configIdentity: expectedIdentity } : {}),
        };
    const cleanupResults = cleanOrphanBundleDirs(
      activeBundleDirs,
      scope,
      dryRun,
      MANAGED_HOOKS_SUBDIR,
      address,
      undefined,
      verifyCurrent,
      undefined,
      deleteGuard
    );
    results.push(...cleanupResults);
    let hadError = cleanupResults.some((result) => result.status === 'error');
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
      if (dryRun) {
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
      hadError = true;
      results.push({
        platform: 'codex',
        filePath: managedState.filePath,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return hadError;
    }
    if (pendingLegacyBundles.length === 0) return hadError;
    const pendingLegacyBundleMap = new Map(
      pendingLegacyBundles.map((value) => [value.id, value.fingerprint])
    );
    const legacyResults = cleanOrphanBundleDirs(
      new Set(),
      scope,
      dryRun,
      LEGACY_ASB_HOOKS_SUBDIR,
      address,
      pendingLegacyBundleMap,
      verifyCurrent,
      (id, fingerprint) => refreshLegacyHookBundleCleanup(address, id, fingerprint),
      deleteGuard
    );
    results.push(...legacyResults);
    const legacyHadError = legacyResults.some((result) => result.status === 'error');
    hadError ||= legacyHadError;
    if (!dryRun && !legacyHadError) {
      try {
        clearLegacyHookBundleCleanup(address);
      } catch (error) {
        hadError = true;
        results.push({
          platform: 'codex',
          filePath: managedState.filePath,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return hadError;
  };

  if (bundleEntries.length > 0) {
    let snapshotRoot: string | undefined;
    try {
      const materialized = materializeHookBundleSnapshots(bundleEntries, bundleSnapshots);
      snapshotRoot = materialized.root;
      const bundleOutcome = distributeBundle<HookEntry, CodexPlatform>({
        section: 'hooks',
        selected: bundleEntries,
        platforms: ['codex'],
        resolveTargetDir: (_p, entry) =>
          resolveHookBundleTargetDir(
            entry,
            requireHookBundleHash(bundleHashes, entry),
            scope,
            address
          ),
        resolveBundleRootDir: () => resolveHooksBundleSafetyRoot(scope, address),
        listFiles: (entry) => {
          const files = materialized.files.get(entry.id);
          if (!files) throw new Error(`Missing bundle snapshot files for ${entry.id}`);
          return files;
        },
        getId: (entry) => entry.id,
        scope: address.projectRoot ? { project: address.projectRoot } : undefined,
        dryRun,
        validateTarget: dryRun
          ? undefined
          : () =>
              assertManagedHookConfigSnapshot(
                address,
                fileResult.raw,
                fileResult.mode,
                fileResult.identity
              ),
      });
      results.push(...bundleOutcome.results);
      if (
        bundleOutcome.results.some(
          (result) => result.status === 'error' || result.status === 'conflict'
        )
      ) {
        return { results };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'error',
        error: `Failed to materialize bundle snapshot: ${msg}`,
      });
      return { results };
    } finally {
      if (snapshotRoot) removeHookBundlePath(snapshotRoot);
    }
  }

  if (
    filteredEntries.length === 0 &&
    !normalizedInput &&
    !hadLegacyManagedKey &&
    !hasManagedHookGroups(managedState.hooks) &&
    !hasAsbGroups
  ) {
    appendCleanupResults(fileResult.raw, fileResult.mode, fileResult.identity);
    return { results };
  }

  const cleanedHooks = Object.fromEntries(
    Object.entries(removal.hooks).map(([event, groups]) => [event, [...groups]])
  );
  const managed = mergeHooksIntoFile(
    fileData,
    filteredEntries,
    cleanedHooks,
    scope,
    bundleHashes,
    address
  );
  const managedPrefixLengths = getManagedHookPrefixLengths(removal.hooks, managed);

  // Clean up empty state: if no hooks remain, remove the file entirely
  const mergedHooks = fileData.hooks as Record<string, unknown[]>;
  const totalGroups = Object.values(mergedHooks).reduce((sum, groups) => sum + groups.length, 0);
  const hasNoHooks = totalGroups === 0;

  if (hasNoHooks && filteredEntries.length === 0) {
    const remainingKeys = Object.keys(fileData).filter((k) => k !== 'hooks');
    if (remainingKeys.length === 0 && !dryRun) {
      try {
        const existed = fs.existsSync(hooksJsonPath);
        const linked = lstatIfExists(hooksJsonPath)?.isSymbolicLink() === true;
        const desiredConfig = linked
          ? `${JSON.stringify({ ...fileData, hooks: {} }, null, 2)}\n`
          : undefined;
        const committedIdentity = commitManagedHookUpdate(
          'codex',
          hooksJsonPath,
          managedState.hooks,
          managedState.prefixLengths,
          managed,
          managedPrefixLengths,
          desiredConfig,
          fileResult.raw,
          scope?.project ?? undefined,
          address,
          fileResult.mode,
          fileResult.identity
        );
        if (existed) {
          results.push({
            platform: 'codex',
            filePath: hooksJsonPath,
            status: linked ? 'written' : 'deleted',
            reason: linked ? 'hooks cleared' : 'no hooks remain',
          });
        }
        appendCleanupResults(
          desiredConfig,
          linked ? fileResult.mode : undefined,
          committedIdentity
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
      }
      return { results };
    }
  }

  const after = JSON.stringify(fileData);

  if (before === after) {
    try {
      if (!dryRun) {
        assertManagedHookConfigSnapshot(
          address,
          fileResult.raw,
          fileResult.mode,
          fileResult.identity
        );
        saveManagedHookGroups(
          'codex',
          hooksJsonPath,
          managed,
          managedPrefixLengths,
          scope?.project ?? undefined,
          address
        );
      }
      results.push({
        platform: 'codex',
        filePath: hooksJsonPath,
        status: 'skipped',
        reason: 'up-to-date',
      });
      appendCleanupResults(fileResult.raw, fileResult.mode, fileResult.identity);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        platform: 'codex',
        filePath: managedState.filePath,
        status: 'error',
        error: msg,
      });
    }
  } else if (dryRun) {
    const reason =
      filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
    results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
    if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
    appendCleanupResults(fileResult.raw, fileResult.mode, fileResult.identity);
  } else {
    try {
      const desiredConfig = `${JSON.stringify(fileData, null, 2)}\n`;
      const committedIdentity = commitManagedHookUpdate(
        'codex',
        hooksJsonPath,
        managedState.hooks,
        managedState.prefixLengths,
        managed,
        managedPrefixLengths,
        desiredConfig,
        fileResult.raw,
        scope?.project ?? undefined,
        address,
        fileResult.mode,
        fileResult.identity
      );
      const reason =
        filteredEntries.length === 0 ? 'hooks cleared' : `${filteredEntries.length} hook(s) merged`;
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'written', reason });
      if (filteredEntries.length > 0) addReviewResult(hooksJsonPath, results);
      appendCleanupResults(desiredConfig, fileResult.mode, committedIdentity);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ platform: 'codex', filePath: hooksJsonPath, status: 'error', error: msg });
    }
  }

  return { results };
}
