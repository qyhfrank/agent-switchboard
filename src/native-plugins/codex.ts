import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveScopedNativePluginConfig } from '../config/application-config.js';
import { getConfigDir } from '../config/paths.js';
import type { ConfigScope } from '../config/scope.js';
import {
  buildPluginIndex,
  type NativePluginMeta,
  type PluginDescriptor,
} from '../plugins/index.js';
import { getTargetById } from '../targets/registry.js';

export interface CodexNativePluginDistributionResult {
  platform: 'codex';
  pluginRef: string;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export interface CodexPluginCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CodexPluginCommandRunner = (
  args: string[],
  options: { cwd?: string }
) => CodexPluginCommandResult;

export interface DistributeCodexNativePluginsOptions {
  scope?: ConfigScope;
  activeAppIds: string[];
  assumeInstalled?: ReadonlySet<string>;
  dryRun?: boolean;
  genericPluginRefs?: string[];
  projectMode?: 'managed' | 'exclusive' | 'none';
  runner?: CodexPluginCommandRunner;
}

interface CodexNativePluginMeta extends NativePluginMeta {
  target: 'codex';
}

function defaultCodexRunner(
  args: string[],
  options: { cwd?: string } = {}
): CodexPluginCommandResult {
  const result = spawnSync('codex', args, {
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

function isCodexAvailable(activeAppIds: string[], assumeInstalled?: ReadonlySet<string>): boolean {
  if (!activeAppIds.includes('codex')) return false;
  const target = getTargetById('codex');
  return target?.isInstalled?.() !== false || assumeInstalled?.has('codex') === true;
}

function resultError(
  pluginRef: string,
  filePath: string,
  error: string
): CodexNativePluginDistributionResult {
  return {
    platform: 'codex',
    pluginRef,
    filePath,
    status: 'error',
    error,
  };
}

function runRequired(
  runner: CodexPluginCommandRunner,
  args: string[],
  cwd?: string
): CodexPluginCommandResult {
  const result = runner(args, { cwd });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`codex ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function readJson(runner: CodexPluginCommandRunner, args: string[], cwd?: string): unknown {
  const result = runRequired(runner, args, cwd);
  const text = result.stdout.trim();
  if (!text) throw new Error(`codex ${args.join(' ')} returned invalid JSON: empty stdout`);
  try {
    return JSON.parse(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`codex ${args.join(' ')} returned invalid JSON: ${msg}`);
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

function normalizePathForCompare(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function candidateMarketplacePaths(entry: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const key of ['root', 'installedRoot', 'path']) {
    const value = entry[key];
    if (typeof value === 'string') candidates.push(value);
  }

  const source = entry.marketplaceSource;
  if (source && typeof source === 'object') {
    const value = (source as Record<string, unknown>).source;
    if (typeof value === 'string') candidates.push(value);
  }

  return candidates;
}

function verifyMarketplacePath(
  entry: Record<string, unknown>,
  meta: CodexNativePluginMeta
): string | undefined {
  const expected = normalizePathForCompare(meta.marketplacePath);
  const candidates = candidateMarketplacePaths(entry);
  if (candidates.length === 0) {
    return `Codex marketplace "${meta.marketplaceName}" is already registered, but its path could not be verified`;
  }

  if (candidates.some((candidate) => normalizePathForCompare(candidate) === expected)) {
    return undefined;
  }

  return `Codex marketplace "${meta.marketplaceName}" is already registered from a different source; remove it from Codex before syncing ${meta.installRef}`;
}

function pluginMatches(entry: Record<string, unknown>, meta: CodexNativePluginMeta): boolean {
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

function findInstalledPlugin(
  value: unknown,
  meta: CodexNativePluginMeta
): Record<string, unknown> | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { installed?: unknown }).installed)
  ) {
    return collectObjects((value as { installed: unknown[] }).installed).find((entry) =>
      pluginMatches(entry, meta)
    );
  }

  return collectObjects(value).find(
    (entry) => entry.installed !== false && pluginMatches(entry, meta)
  );
}

function pluginIsDisabled(entry: Record<string, unknown>): boolean {
  if (entry.enabled === false || entry.disabled === true) return true;
  if (typeof entry.status === 'string' && entry.status.toLowerCase() === 'disabled') return true;
  return false;
}

function pluginNeedsUpdate(entry: Record<string, unknown>, meta: CodexNativePluginMeta): boolean {
  if (!meta.version) return false;
  return entry.version !== meta.version;
}

function resolveNativeMeta(
  pluginRef: string,
  plugin: PluginDescriptor | undefined
): CodexNativePluginMeta | string {
  if (!plugin) return `Unknown native plugin ref: ${pluginRef}`;
  if (!plugin.meta.native || plugin.meta.native.target !== 'codex') {
    return `Plugin "${pluginRef}" is not a Codex native marketplace plugin`;
  }
  return plugin.meta.native as CodexNativePluginMeta;
}

function shouldSkipProjectModeNone(
  scope?: ConfigScope,
  projectMode?: 'managed' | 'exclusive' | 'none'
): boolean {
  return scope?.project !== undefined && projectMode === 'none';
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'plugin';
}

function assertAsbStatePath(wrapperRoot: string): void {
  const stateRoot = path.resolve(getConfigDir(), 'state', 'native-plugins', 'codex');
  const resolved = path.resolve(wrapperRoot);
  const relative = path.relative(stateRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write Codex native marketplace outside ASB state: ${wrapperRoot}`);
  }
}

function materializeMarketplace(meta: CodexNativePluginMeta, dryRun: boolean): void {
  if (!meta.sourcePath || dryRun) return;

  const wrapperRoot = meta.marketplacePath;
  assertAsbStatePath(wrapperRoot);

  const pluginDirName = safePathSegment(meta.pluginName);
  const manifestDir = path.join(wrapperRoot, '.agents', 'plugins');
  const pluginsDir = path.join(wrapperRoot, 'plugins');
  const pluginPath = path.join(pluginsDir, pluginDirName);

  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  fs.rmSync(pluginPath, { recursive: true, force: true });
  fs.symlinkSync(meta.sourcePath, pluginPath, process.platform === 'win32' ? 'junction' : 'dir');

  // Codex requires marketplace-local plugin paths, so ASB wraps a bare
  // .codex-plugin source in an ASB-owned local marketplace.
  const manifest = {
    name: meta.marketplaceName,
    plugins: [
      {
        name: meta.pluginName,
        source: `./plugins/${pluginDirName}`,
      },
    ],
  };

  fs.writeFileSync(
    path.join(manifestDir, 'marketplace.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8'
  );
}

export function validateCodexNativePlugins({
  scope,
  activeAppIds,
  genericPluginRefs = [],
  projectMode,
}: DistributeCodexNativePluginsOptions): { results: CodexNativePluginDistributionResult[] } {
  if (shouldSkipProjectModeNone(scope, projectMode)) return { results: [] };
  if (!activeAppIds.includes('codex')) return { results: [] };

  const index = buildPluginIndex(scope);
  const results: CodexNativePluginDistributionResult[] = [];

  for (const pluginRef of genericPluginRefs) {
    const plugin = index.get(pluginRef);
    if (plugin?.meta.native?.target !== 'codex') continue;
    results.push(
      resultError(
        plugin.meta.native.installRef,
        plugin.meta.native.marketplacePath,
        `Codex native plugin "${plugin.id}" is enabled through [plugins].enabled; use [applications.codex.native_plugins] instead`
      )
    );
  }

  const nativeConfig = resolveScopedNativePluginConfig('codex', scope);
  if (nativeConfig.enabled.length === 0) return { results };

  for (const pluginRef of nativeConfig.enabled) {
    const plugin = index.getNative(pluginRef, 'codex');
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

export function distributeCodexNativePlugins({
  scope,
  activeAppIds,
  assumeInstalled,
  dryRun = false,
  genericPluginRefs = [],
  projectMode,
  runner = defaultCodexRunner,
}: DistributeCodexNativePluginsOptions): { results: CodexNativePluginDistributionResult[] } {
  const validation = validateCodexNativePlugins({
    scope,
    activeAppIds,
    assumeInstalled,
    genericPluginRefs,
    projectMode,
  });
  if (validation.results.some((result) => result.status === 'error')) return validation;
  if (shouldSkipProjectModeNone(scope, projectMode)) return { results: [] };
  if (!isCodexAvailable(activeAppIds, assumeInstalled)) return { results: [] };

  const nativeConfig = resolveScopedNativePluginConfig('codex', scope);
  if (nativeConfig.enabled.length === 0) return { results: [] };

  const index = buildPluginIndex(scope);
  const results: CodexNativePluginDistributionResult[] = [];

  for (const pluginRef of nativeConfig.enabled) {
    const plugin = index.getNative(pluginRef, 'codex');
    const nativeMeta = resolveNativeMeta(pluginRef, plugin);
    if (typeof nativeMeta === 'string') {
      results.push(resultError(pluginRef, pluginRef, nativeMeta));
      continue;
    }

    if (dryRun) {
      results.push({
        platform: 'codex',
        pluginRef: nativeMeta.installRef,
        filePath: nativeMeta.marketplacePath,
        status: 'written',
        reason: `would sync native plugin (${nativeConfig.scope})`,
      });
      continue;
    }

    try {
      materializeMarketplace(nativeMeta, dryRun);

      const actions: string[] = [];
      const marketplaces = readJson(runner, ['plugin', 'marketplace', 'list', '--json']);
      const marketplace = findMarketplace(marketplaces, nativeMeta.marketplaceName);
      if (!marketplace) {
        runRequired(runner, ['plugin', 'marketplace', 'add', nativeMeta.marketplacePath, '--json']);
        actions.push('marketplace added');
      } else {
        const marketplacePathError = verifyMarketplacePath(marketplace, nativeMeta);
        if (marketplacePathError) throw new Error(marketplacePathError);
      }

      const installed = readJson(runner, [
        'plugin',
        'list',
        '--marketplace',
        nativeMeta.marketplaceName,
        '--json',
      ]);
      const installedPlugin = findInstalledPlugin(installed, nativeMeta);
      if (!installedPlugin) {
        runRequired(runner, ['plugin', 'add', nativeMeta.installRef, '--json']);
        actions.push('installed');
      } else if (pluginIsDisabled(installedPlugin)) {
        runRequired(runner, ['plugin', 'add', nativeMeta.installRef, '--json']);
        actions.push('enabled');
      } else if (pluginNeedsUpdate(installedPlugin, nativeMeta)) {
        runRequired(runner, ['plugin', 'add', nativeMeta.installRef, '--json']);
        actions.push('updated');
      }

      results.push({
        platform: 'codex',
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
