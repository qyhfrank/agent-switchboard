import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveScopedNativePluginConfig } from '../config/application-config.js';
import { getClaudeDir, getProjectClaudeDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  buildPluginIndex,
  type NativePluginMeta,
  type PluginDescriptor,
} from '../plugins/index.js';
import { getTargetById } from '../targets/registry.js';

export interface ClaudeNativePluginDistributionResult {
  platform: 'claude-code';
  pluginRef: string;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export interface ClaudePluginCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ClaudePluginCommandRunner = (
  args: string[],
  options: { cwd?: string }
) => ClaudePluginCommandResult;

export interface DistributeClaudeNativePluginsOptions {
  scope?: ConfigScope;
  activeAppIds: string[];
  assumeInstalled?: ReadonlySet<string>;
  dryRun?: boolean;
  genericPluginRefs?: string[];
  projectMode?: 'managed' | 'exclusive' | 'none';
  runner?: ClaudePluginCommandRunner;
}

type ClaudeNativePluginMeta = NativePluginMeta & { target: 'claude-code' };
type ClaudePluginScope = 'user' | 'project' | 'local';

type ClaudeMarketplaceSource =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'directory'; path: string };

interface ClaudeMarketplaceRegistration {
  argument: string;
  source: ClaudeMarketplaceSource;
  portable: boolean;
}

function defaultClaudeRunner(
  args: string[],
  options: { cwd?: string } = {}
): ClaudePluginCommandResult {
  const result = spawnSync('claude', args, {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 120_000,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function isClaudeCodeAvailable(
  activeAppIds: string[],
  assumeInstalled?: ReadonlySet<string>
): boolean {
  if (!activeAppIds.includes('claude-code')) return false;
  const target = getTargetById('claude-code');
  return target?.isInstalled?.() !== false || assumeInstalled?.has('claude-code') === true;
}

function resultError(
  pluginRef: string,
  filePath: string,
  error: string
): ClaudeNativePluginDistributionResult {
  return {
    platform: 'claude-code',
    pluginRef,
    filePath,
    status: 'error',
    error,
  };
}

function runRequired(
  runner: ClaudePluginCommandRunner,
  args: string[],
  cwd?: string
): ClaudePluginCommandResult {
  const result = runner(args, { cwd });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`claude ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function readJson(runner: ClaudePluginCommandRunner, args: string[], cwd?: string): unknown {
  const result = runRequired(runner, args, cwd);
  const text = result.stdout.trim();
  if (!text) throw new Error(`claude ${args.join(' ')} returned invalid JSON: empty stdout`);
  try {
    return JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`claude ${args.join(' ')} returned invalid JSON: ${msg}`);
  }
}

function collectObjects(
  value: unknown,
  out: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    out.push(record);
    for (const child of Object.values(record)) {
      if (child !== null && typeof child === 'object') collectObjects(child, out);
    }
  }
  return out;
}

function findMarketplace(
  value: unknown,
  marketplaceName: string
): Record<string, unknown> | undefined {
  return collectObjects(value).find((entry) => {
    return entry.name === marketplaceName || entry.marketplaceName === marketplaceName;
  });
}

function githubRepo(url: string): string | undefined {
  const match = url.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#]+?)(?:\.git)?\/?$/
  );
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

function resolveMarketplaceRegistration(
  meta: ClaudeNativePluginMeta
): ClaudeMarketplaceRegistration {
  const remote = meta.remoteSource;
  if (remote && !remote.subdir && /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(remote.url)) {
    const repo = githubRepo(remote.url);
    if (repo) {
      return {
        argument: `${repo}${remote.ref ? `@${remote.ref}` : ''}`,
        source: {
          source: 'github',
          repo,
          ...(remote.ref ? { ref: remote.ref } : {}),
        },
        portable: true,
      };
    }

    return {
      argument: `${remote.url}${remote.ref ? `#${remote.ref}` : ''}`,
      source: {
        source: 'git',
        url: remote.url,
        ...(remote.ref ? { ref: remote.ref } : {}),
      },
      portable: true,
    };
  }

  return {
    argument: meta.marketplacePath,
    source: { source: 'directory', path: meta.marketplacePath },
    portable: false,
  };
}

function marketplaceSource(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.marketplaceSource && typeof entry.marketplaceSource === 'object') {
    return entry.marketplaceSource as Record<string, unknown>;
  }
  if (entry.source && typeof entry.source === 'object') {
    return entry.source as Record<string, unknown>;
  }
  if (typeof entry.source !== 'string') return undefined;

  const source: Record<string, unknown> = { source: entry.source };
  for (const key of ['repo', 'url', 'ref', 'path']) {
    if (typeof entry[key] === 'string') source[key] = entry[key];
  }
  return source;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sourceMatches(
  actual: Record<string, unknown> | undefined,
  expected: ClaudeMarketplaceSource
): boolean {
  if (!actual || actual.source !== expected.source) return false;
  switch (expected.source) {
    case 'github':
      return actual.repo === expected.repo && actual.ref === expected.ref;
    case 'git':
      return actual.url === expected.url && actual.ref === expected.ref;
    case 'directory':
      return (
        typeof actual.path === 'string' &&
        normalizedPath(actual.path) === normalizedPath(expected.path)
      );
  }
}

function isManagedLocalRegistration(
  actual: Record<string, unknown> | undefined,
  meta: ClaudeNativePluginMeta
): boolean {
  return sourceMatches(actual, { source: 'directory', path: meta.marketplacePath });
}

function pluginMatches(entry: Record<string, unknown>, meta: ClaudeNativePluginMeta): boolean {
  if (
    entry.pluginId === meta.installRef ||
    entry.id === meta.installRef ||
    entry.ref === meta.installRef
  ) {
    return true;
  }

  const marketplace =
    entry.marketplaceName ?? entry.marketplace ?? entry.marketplaceId ?? entry.sourceMarketplace;
  return entry.name === meta.pluginName && marketplace === meta.marketplaceName;
}

function findPlugin(
  value: unknown,
  meta: ClaudeNativePluginMeta
): Record<string, unknown> | undefined {
  return collectObjects(value).find((entry) => pluginMatches(entry, meta));
}

function pluginIsDisabled(entry: Record<string, unknown>): boolean {
  if (entry.enabled === false || entry.disabled === true) return true;
  if (typeof entry.status === 'string' && entry.status.toLowerCase() === 'disabled') return true;
  return false;
}

function projectRoot(scope?: ConfigScope): string {
  const root = scope?.project?.trim();
  if (!root) {
    throw new Error('Claude Code project/local native plugin scope requires --project <path>');
  }
  return path.resolve(root);
}

function resolveClaudeCwd(scope: ClaudePluginScope, configScope?: ConfigScope): string | undefined {
  return scope === 'user' ? undefined : projectRoot(configScope);
}

function resolveClaudeSettingsPath(scope: ClaudePluginScope, configScope?: ConfigScope): string {
  if (scope === 'user') return path.join(getClaudeDir(), 'settings.json');
  return path.join(
    getProjectClaudeDir(projectRoot(configScope)),
    scope === 'project' ? 'settings.json' : 'settings.local.json'
  );
}

function readSettings(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Claude Code settings must contain a JSON object: ${filePath}`);
  }
  return value as Record<string, unknown>;
}

function reconcileMarketplaceSetting(
  meta: ClaudeNativePluginMeta,
  registration: ClaudeMarketplaceRegistration,
  scope: ClaudePluginScope,
  configScope?: ConfigScope
): boolean {
  const filePath = resolveClaudeSettingsPath(scope, configScope);
  const settings = readSettings(filePath);
  const current = settings.extraKnownMarketplaces;
  const marketplaces =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  let changed = false;
  if (registration.portable) {
    const existing = marketplaces[meta.marketplaceName];
    const entry =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    if (JSON.stringify(entry.source) !== JSON.stringify(registration.source)) {
      entry.source = registration.source;
      marketplaces[meta.marketplaceName] = entry;
      changed = true;
    }
  } else if (meta.marketplaceName in marketplaces) {
    delete marketplaces[meta.marketplaceName];
    changed = true;
  }

  if (!changed) return false;
  if (Object.keys(marketplaces).length > 0) {
    settings.extraKnownMarketplaces = marketplaces;
  } else {
    delete settings.extraKnownMarketplaces;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  return true;
}

function resolveNativeMeta(
  pluginRef: string,
  plugin: PluginDescriptor | undefined
): ClaudeNativePluginMeta | string {
  if (!plugin) return `Unknown native plugin ref: ${pluginRef}`;
  if (!plugin.meta.native || plugin.meta.native.target !== 'claude-code') {
    return `Plugin "${pluginRef}" is not a Claude Code native marketplace plugin`;
  }
  return plugin.meta.native as ClaudeNativePluginMeta;
}

function shouldSkipProjectModeNone(
  scope?: ConfigScope,
  projectMode?: 'managed' | 'exclusive' | 'none'
): boolean {
  return scope?.project !== undefined && projectMode === 'none';
}

export function validateClaudeNativePlugins({
  scope,
  activeAppIds,
  genericPluginRefs = [],
  projectMode,
}: DistributeClaudeNativePluginsOptions): { results: ClaudeNativePluginDistributionResult[] } {
  if (shouldSkipProjectModeNone(scope, projectMode)) return { results: [] };
  if (!activeAppIds.includes('claude-code')) return { results: [] };

  const nativeConfig = resolveScopedNativePluginConfig('claude-code', scope);
  if (nativeConfig.enabled.length === 0) return { results: [] };
  if (nativeConfig.scope !== 'user' && !scope?.project?.trim()) {
    return {
      results: nativeConfig.enabled.map((pluginRef) =>
        resultError(
          pluginRef,
          pluginRef,
          'Claude Code project/local native plugin scope requires --project <path>'
        )
      ),
    };
  }

  const index = buildPluginIndex(scope);
  const results: ClaudeNativePluginDistributionResult[] = [];

  for (const pluginRef of nativeConfig.enabled) {
    const plugin = index.getNative(pluginRef);
    const nativeMeta = resolveNativeMeta(pluginRef, plugin);
    if (typeof nativeMeta === 'string') {
      results.push(resultError(pluginRef, pluginRef, nativeMeta));
      continue;
    }

    const genericConflict = genericPluginRefs.some((ref) => index.get(ref)?.id === plugin?.id);
    if (genericConflict) {
      results.push(
        resultError(
          nativeMeta.installRef,
          nativeMeta.marketplacePath,
          `Native plugin "${nativeMeta.installRef}" is also enabled through [plugins].enabled`
        )
      );
    }
  }

  return { results };
}

export function distributeClaudeNativePlugins({
  scope,
  activeAppIds,
  assumeInstalled,
  dryRun = false,
  genericPluginRefs = [],
  projectMode,
  runner = defaultClaudeRunner,
}: DistributeClaudeNativePluginsOptions): { results: ClaudeNativePluginDistributionResult[] } {
  const validation = validateClaudeNativePlugins({
    scope,
    activeAppIds,
    assumeInstalled,
    genericPluginRefs,
    projectMode,
  });
  if (validation.results.some((result) => result.status === 'error')) return validation;
  if (shouldSkipProjectModeNone(scope, projectMode)) return { results: [] };
  if (!isClaudeCodeAvailable(activeAppIds, assumeInstalled)) return { results: [] };

  const nativeConfig = resolveScopedNativePluginConfig('claude-code', scope);
  if (nativeConfig.enabled.length === 0) return { results: [] };

  const index = buildPluginIndex(scope);
  const results: ClaudeNativePluginDistributionResult[] = [];

  for (const pluginRef of nativeConfig.enabled) {
    const plugin = index.getNative(pluginRef);
    const nativeMeta = resolveNativeMeta(pluginRef, plugin);
    if (typeof nativeMeta === 'string') {
      results.push(resultError(pluginRef, pluginRef, nativeMeta));
      continue;
    }

    const registration = resolveMarketplaceRegistration(nativeMeta);

    if (dryRun) {
      results.push({
        platform: 'claude-code',
        pluginRef: nativeMeta.installRef,
        filePath: nativeMeta.marketplacePath,
        status: 'written',
        reason: `would sync native plugin (${nativeConfig.scope})`,
      });
      continue;
    }

    try {
      const cwd = resolveClaudeCwd(nativeConfig.scope, scope);
      runRequired(runner, ['plugin', 'validate', nativeMeta.marketplacePath], cwd);

      const actions: string[] = [];
      const marketplaces = readJson(runner, ['plugin', 'marketplace', 'list', '--json'], cwd);
      const marketplace = findMarketplace(marketplaces, nativeMeta.marketplaceName);
      if (!marketplace) {
        runRequired(
          runner,
          ['plugin', 'marketplace', 'add', '--scope', nativeConfig.scope, registration.argument],
          cwd
        );
        actions.push('marketplace added');
      } else {
        const actualSource = marketplaceSource(marketplace);
        if (!sourceMatches(actualSource, registration.source)) {
          if (registration.portable && isManagedLocalRegistration(actualSource, nativeMeta)) {
            const installedBeforeMigration = readJson(runner, ['plugin', 'list', '--json'], cwd);
            const previousPlugin = findPlugin(installedBeforeMigration, nativeMeta);
            runRequired(
              runner,
              [
                'plugin',
                'marketplace',
                'remove',
                '--scope',
                nativeConfig.scope,
                nativeMeta.marketplaceName,
              ],
              cwd
            );
            try {
              runRequired(
                runner,
                [
                  'plugin',
                  'marketplace',
                  'add',
                  '--scope',
                  nativeConfig.scope,
                  registration.argument,
                ],
                cwd
              );
            } catch (migrationError) {
              runner(
                [
                  'plugin',
                  'marketplace',
                  'remove',
                  '--scope',
                  nativeConfig.scope,
                  nativeMeta.marketplaceName,
                ],
                { cwd }
              );
              try {
                runRequired(
                  runner,
                  [
                    'plugin',
                    'marketplace',
                    'add',
                    '--scope',
                    nativeConfig.scope,
                    nativeMeta.marketplacePath,
                  ],
                  cwd
                );
                if (previousPlugin) {
                  runRequired(
                    runner,
                    ['plugin', 'install', '--scope', nativeConfig.scope, nativeMeta.installRef],
                    cwd
                  );
                  if (pluginIsDisabled(previousPlugin)) {
                    runRequired(
                      runner,
                      ['plugin', 'disable', '--scope', nativeConfig.scope, nativeMeta.installRef],
                      cwd
                    );
                  }
                }
              } catch (rollbackError) {
                const migrationDetail =
                  migrationError instanceof Error ? migrationError.message : String(migrationError);
                const rollbackDetail =
                  rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new Error(`${migrationDetail}; rollback failed: ${rollbackDetail}`);
              }
              throw migrationError;
            }
            actions.push('marketplace migrated');
          } else {
            throw new Error(
              `Claude marketplace "${nativeMeta.marketplaceName}" is registered from a different source`
            );
          }
        }
      }

      const installed = readJson(runner, ['plugin', 'list', '--json'], cwd);
      const installedPlugin = findPlugin(installed, nativeMeta);
      if (!installedPlugin) {
        runRequired(
          runner,
          ['plugin', 'install', '--scope', nativeConfig.scope, nativeMeta.installRef],
          cwd
        );
        actions.push('installed');
      } else if (pluginIsDisabled(installedPlugin)) {
        runRequired(
          runner,
          ['plugin', 'enable', '--scope', nativeConfig.scope, nativeMeta.installRef],
          cwd
        );
        actions.push('enabled');
      }

      if (reconcileMarketplaceSetting(nativeMeta, registration, nativeConfig.scope, scope)) {
        actions.push('settings reconciled');
      }

      results.push({
        platform: 'claude-code',
        pluginRef: nativeMeta.installRef,
        filePath: nativeMeta.marketplacePath,
        status: actions.length > 0 ? 'written' : 'skipped',
        reason: actions.length > 0 ? actions.join(', ') : 'up-to-date',
      });
    } catch (error) {
      results.push(
        resultError(
          nativeMeta.installRef,
          nativeMeta.marketplacePath,
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  return { results };
}
