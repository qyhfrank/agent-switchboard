import { spawnSync } from 'node:child_process';
import type { NativePluginScope } from '../config/application-config.js';
import { resolveScopedNativePluginConfig } from '../config/application-config.js';
import type { ConfigScope } from '../config/scope.js';
import { buildPluginIndex, type PluginDescriptor } from '../plugins/index.js';
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
  runner?: ClaudePluginCommandRunner;
}

interface ClaudeNativePluginMeta {
  marketplaceName: string;
  marketplacePath: string;
  pluginName: string;
  installRef: string;
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

function commandCwd(nativeScope: NativePluginScope, scope?: ConfigScope): string | undefined {
  if ((nativeScope === 'project' || nativeScope === 'local') && scope?.project) {
    return scope.project;
  }
  return undefined;
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
  if (!text) return null;
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

function hasMarketplace(value: unknown, marketplaceName: string): boolean {
  return collectObjects(value).some((entry) => {
    return entry.name === marketplaceName || entry.marketplaceName === marketplaceName;
  });
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

function resolveNativeMeta(
  pluginRef: string,
  plugin: PluginDescriptor | undefined
): ClaudeNativePluginMeta | string {
  if (!plugin) return `Unknown native plugin ref: ${pluginRef}`;
  if (!plugin.meta.native || plugin.meta.native.target !== 'claude-code') {
    return `Plugin "${pluginRef}" is not a Claude Code native marketplace plugin`;
  }
  return plugin.meta.native;
}

export function distributeClaudeNativePlugins({
  scope,
  activeAppIds,
  assumeInstalled,
  dryRun = false,
  genericPluginRefs = [],
  runner = defaultClaudeRunner,
}: DistributeClaudeNativePluginsOptions): { results: ClaudeNativePluginDistributionResult[] } {
  if (!isClaudeCodeAvailable(activeAppIds, assumeInstalled)) return { results: [] };

  const nativeConfig = resolveScopedNativePluginConfig('claude-code', scope);
  if (nativeConfig.enabled.length === 0) return { results: [] };

  const index = buildPluginIndex(scope);
  const cwd = commandCwd(nativeConfig.scope, scope);
  const results: ClaudeNativePluginDistributionResult[] = [];

  for (const pluginRef of nativeConfig.enabled) {
    const plugin = index.get(pluginRef);
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
      continue;
    }

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
      runRequired(runner, ['plugin', 'validate', nativeMeta.marketplacePath], cwd);

      const actions: string[] = [];
      const marketplaces = readJson(runner, ['plugin', 'marketplace', 'list', '--json'], cwd);
      if (!hasMarketplace(marketplaces, nativeMeta.marketplaceName)) {
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
        actions.push('marketplace added');
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
