/**
 * Marketplace reader: detects and parses native plugin marketplace repositories.
 *
 * A marketplace is a repository containing a supported marketplace manifest.
 * Each plugin is either a relative path within the same repo or a standalone
 * directory with a supported native plugin manifest.
 *
 * PhaseB additions:
 *   - `github` / `git` URL source types resolve via shallow clone + cache
 *   - `strict` mode semantics (true => marketplace entry is authoritative)
 *   - `npm` / `pip` sources emit warnings (not yet implemented)
 *   - `ref` / `sha` pin support for reproducible builds
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandHome } from '../config/paths.js';
import {
  type MarketplaceEntryCacheRefreshResult,
  type MarketplaceEntryCacheRequest,
  materializeMarketplaceEntry,
  refreshMarketplaceEntryCache,
} from './cache.js';
import {
  type MarketplaceManifest,
  marketplaceManifestSchema,
  type PluginEntry,
  type PluginManifest,
  pluginManifestSchema,
} from './schemas.js';

export type NativePluginTarget = 'claude-code' | 'codex';

interface MarketplacePluginBase {
  name: string;
  description?: string;
  version?: string;
  /** Plugin manifest if a supported native plugin manifest exists */
  manifest?: PluginManifest;
  /** Whether plugin is in strict mode */
  strict: boolean;
  /**
   * Custom component paths from the marketplace entry (strict mode) or
   * plugin.json (non-strict). Used by the plugin loader to override
   * default directory scanning.
   */
  customPaths?: {
    commands?: string[];
    agents?: string[];
    skills?: string[];
  };
  /** MCP servers declared in the marketplace entry or plugin.json */
  mcpServers?: Record<string, unknown>;
  resolution: MarketplacePluginResolution;
}

export interface ResolvedPlugin extends MarketplacePluginBase {
  /** Absolute path to the plugin root directory */
  localPath: string;
}

export interface DeferredPlugin extends MarketplacePluginBase {
  localPath?: undefined;
}

export type MarketplacePlugin = ResolvedPlugin | DeferredPlugin;

export interface MarketplacePluginResolution {
  entry: PluginEntry;
  marketplaceRoot: string;
  pluginRoot: string;
  pluginName: string;
  source: string | Record<string, unknown>;
  marketplaceNamespace: string;
  sourceName: string;
  ref?: string;
  sha?: string;
  ownerIsCurrent?: () => boolean;
}

export interface MarketplaceReadResult {
  name: string;
  owner: { name: string; email?: string };
  nativeTarget: NativePluginTarget;
  plugins: MarketplacePlugin[];
  warnings: string[];
}

const MARKETPLACE_MANIFESTS: Array<{ relativePath: string; nativeTarget: NativePluginTarget }> = [
  { relativePath: '.claude-plugin/marketplace.json', nativeTarget: 'claude-code' },
  { relativePath: '.agents/plugins/marketplace.json', nativeTarget: 'codex' },
  { relativePath: '.agents/plugins/api_marketplace.json', nativeTarget: 'codex' },
];

const PLUGIN_MANIFESTS: Array<{ relativePath: string; nativeTarget: NativePluginTarget }> = [
  { relativePath: '.claude-plugin/plugin.json', nativeTarget: 'claude-code' },
  { relativePath: '.codex-plugin/plugin.json', nativeTarget: 'codex' },
];

export interface NativeManifestInfo {
  manifestPath: string;
  nativeTarget: NativePluginTarget;
}

function resolveContainedManifest(localPath: string, relativePath: string): string | undefined {
  const root = path.resolve(localPath);
  const manifestPath = path.resolve(root, relativePath);
  const relative = path.relative(root, manifestPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const rootReal = fs.realpathSync.native(root);
    const manifestReal = fs.realpathSync.native(manifestPath);
    const realRelative = path.relative(rootReal, manifestReal);
    if (
      realRelative.startsWith('..') ||
      path.isAbsolute(realRelative) ||
      !fs.statSync(manifestReal).isFile()
    ) {
      return undefined;
    }
    return manifestPath;
  } catch {
    return undefined;
  }
}

export function getMarketplaceManifestInfo(localPath: string): NativeManifestInfo | undefined {
  for (const manifest of MARKETPLACE_MANIFESTS) {
    const manifestPath = resolveContainedManifest(localPath, manifest.relativePath);
    if (manifestPath) {
      return { manifestPath, nativeTarget: manifest.nativeTarget };
    }
  }
  return undefined;
}

export function getPluginManifestInfo(
  localPath: string,
  nativeTarget?: NativePluginTarget
): NativeManifestInfo | undefined {
  for (const manifest of PLUGIN_MANIFESTS) {
    if (nativeTarget && manifest.nativeTarget !== nativeTarget) continue;
    const manifestPath = resolveContainedManifest(localPath, manifest.relativePath);
    if (manifestPath) {
      return { manifestPath, nativeTarget: manifest.nativeTarget };
    }
  }
  return undefined;
}

/**
 * Check whether a local path is a supported native marketplace.
 */
export function isMarketplace(localPath: string): boolean {
  return getMarketplaceManifestInfo(localPath) !== undefined;
}

/**
 * Check whether a local path is a formal single plugin but NOT marketplace.json.
 */
export function isFormalPlugin(localPath: string): boolean {
  if (isMarketplace(localPath)) return false;
  return getPluginManifestInfo(localPath) !== undefined;
}

/**
 * Read and resolve a marketplace, returning all resolvable plugins with metadata.
 */
export function readMarketplace(
  localPath: string,
  sourceName?: string,
  ownerIsCurrent?: () => boolean
): MarketplaceReadResult {
  const manifestInfo = getMarketplaceManifestInfo(localPath);
  if (!manifestInfo) {
    throw new Error(`No supported marketplace manifest found in ${localPath}`);
  }
  const manifestPath = manifestInfo.manifestPath;
  const warnings: string[] = [];

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const manifest: MarketplaceManifest = marketplaceManifestSchema.parse(raw);

  const pluginRoot = manifest.metadata?.pluginRoot ?? '';
  const plugins: MarketplacePlugin[] = [];
  const marketplaceNamespace = manifest.name.replace(/[^a-zA-Z0-9_-]/g, '-');

  for (const entry of manifest.plugins) {
    const resolution: MarketplacePluginResolution = {
      entry,
      marketplaceRoot: localPath,
      pluginRoot,
      pluginName: entry.name,
      source: entry.source,
      marketplaceNamespace,
      sourceName: sourceName ?? marketplaceNamespace,
      ref: entry.ref ?? sourceString(entry.source, 'ref'),
      sha: entry.sha ?? sourceString(entry.source, 'sha'),
      ownerIsCurrent,
    };
    const resolved = resolvePluginDir(resolution, false);
    if (resolved === null) {
      warnings.push(`Plugin "${entry.name}": unsupported source type, skipped`);
      continue;
    }

    if (resolved !== undefined && !fs.existsSync(resolved)) {
      warnings.push(`Plugin "${entry.name}": directory not found at ${resolved}`);
      continue;
    }

    const pluginManifest = resolved ? readPluginManifest(resolved) : null;
    const plugin = applyStrictMode(entry, pluginManifest, resolved, resolution);

    plugins.push(plugin);
  }

  return {
    name: manifest.name,
    owner: manifest.owner ?? { name: manifest.name },
    nativeTarget: manifestInfo.nativeTarget,
    plugins,
    warnings,
  };
}

export function isResolvedPlugin(plugin: MarketplacePlugin): plugin is ResolvedPlugin {
  return plugin.localPath !== undefined;
}

export function resolveMarketplacePlugin(plugin: MarketplacePlugin): ResolvedPlugin | null {
  if (isResolvedPlugin(plugin)) return plugin;

  const resolved = resolvePluginDir(plugin.resolution, true);
  if (!resolved || !fs.existsSync(resolved)) return null;

  const pluginManifest = readPluginManifest(resolved);
  return applyStrictMode(
    plugin.resolution.entry,
    pluginManifest,
    resolved,
    plugin.resolution
  ) as ResolvedPlugin;
}

export function refreshMarketplacePluginCache(
  localPath: string,
  sourceName: string,
  ownerIsCurrent?: () => boolean
): MarketplaceEntryCacheRefreshResult {
  const marketplace = readMarketplace(localPath, sourceName, ownerIsCurrent);
  const requests: MarketplaceEntryCacheRequest[] = [];
  for (const plugin of marketplace.plugins) {
    const gitSource = getGitSource(plugin.resolution);
    if (!gitSource || isResolvedPlugin(plugin)) continue;
    requests.push(toCacheRequest(plugin.resolution, gitSource));
  }
  return refreshMarketplaceEntryCache(sourceName, localPath, requests);
}

// ── Strict mode ────────────────────────────────────────────────────

/**
 * Apply strict mode semantics to produce the final ResolvedPlugin.
 *
 * When `strict: true` (default): the marketplace entry is authoritative.
 *   - `commands`, `agents`, `mcpServers` from the entry take precedence.
 *   - `plugin.json` values are only used as fallback.
 *
 * When `strict: false`: `plugin.json` is authoritative.
 *   - The marketplace entry provides the source/name/version only.
 *   - Component paths and mcpServers come from `plugin.json`.
 */
function applyStrictMode(
  entry: PluginEntry,
  pluginManifest: PluginManifest | null,
  localPath: string | undefined,
  resolution: MarketplacePluginResolution
): MarketplacePlugin {
  const isStrict = entry.strict;

  const primary = isStrict ? entry : (pluginManifest ?? entry);
  const fallback = isStrict ? (pluginManifest ?? entry) : entry;

  const customCommands =
    normalizeStringArray(primary.commands) ?? normalizeStringArray(fallback.commands);
  const customAgents =
    normalizeStringArray(primary.agents) ?? normalizeStringArray(fallback.agents);
  const customSkills =
    normalizeStringArray(primary.skills) ?? normalizeStringArray(fallback.skills);
  const mcpServers =
    (primary.mcpServers as Record<string, unknown> | undefined) ??
    (fallback.mcpServers as Record<string, unknown> | undefined);

  const plugin: MarketplacePluginBase = {
    name: entry.name,
    description: entry.description ?? pluginManifest?.description,
    version: entry.version ?? pluginManifest?.version,
    manifest: pluginManifest ?? undefined,
    strict: isStrict,
    resolution: { ...resolution, entry },
  };

  if (customCommands || customAgents || customSkills) {
    plugin.customPaths = {};
    if (customCommands) plugin.customPaths.commands = customCommands;
    if (customAgents) plugin.customPaths.agents = customAgents;
    if (customSkills) plugin.customPaths.skills = customSkills;
  }

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    plugin.mcpServers = mcpServers;
  }

  return localPath ? { ...plugin, localPath } : plugin;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
    return value;
  }
  return undefined;
}

// ── Source resolution ──────────────────────────────────────────────

function resolvePluginDir(
  resolution: MarketplacePluginResolution,
  materializeRemote: boolean
): string | null | undefined {
  const { marketplaceRoot, pluginRoot, source } = resolution;
  if (typeof source === 'string') {
    if (source.startsWith('./') || source.startsWith('../') || !source.includes(':')) {
      return resolveInside(marketplaceRoot, path.join(pluginRoot, source));
    }
    return null;
  }

  // Local path source
  if (
    source.path &&
    typeof source.path === 'string' &&
    (source.source === 'local' ||
      (!source.source && !source.url && !source.git && !source.github && !source.repo))
  ) {
    return resolveInside(marketplaceRoot, path.join(pluginRoot, source.path));
  }

  const gitSource = getGitSource(resolution);
  if (gitSource) {
    if (canReuseMarketplaceCheckout(resolution, gitSource.url)) {
      const checkoutRoot = getGitCheckoutRoot(marketplaceRoot);
      if (checkoutRoot) {
        const reused = gitSource.subdir
          ? resolveInside(checkoutRoot, gitSource.subdir)
          : checkoutRoot;
        if (reused && reusablePathsAreClean(resolution, checkoutRoot, reused)) return reused;
      }
    }
    if (!materializeRemote) return undefined;
    return materializeMarketplaceEntry(toCacheRequest(resolution, gitSource), {
      ownerIsCurrent: resolution.ownerIsCurrent,
    }).pluginPath;
  }

  // Keep native-only and currently unsupported source kinds in the catalog.
  // ASB reports a materialization failure only if portable expansion selects one.
  return materializeRemote ? null : undefined;
}

function toCacheRequest(
  resolution: MarketplacePluginResolution,
  gitSource: { url: string; subdir?: string }
): MarketplaceEntryCacheRequest {
  return {
    sourceName: resolution.sourceName,
    marketplacePath: resolution.marketplaceRoot,
    pluginName: resolution.pluginName,
    url: gitSource.url,
    ref: resolution.ref,
    sha: resolution.sha,
    subdir: gitSource.subdir,
    ownerIsCurrent: resolution.ownerIsCurrent,
  };
}

function getGitSource(
  resolution: MarketplacePluginResolution
): { url: string; subdir?: string } | null {
  const source = resolution.source;
  if (typeof source === 'string') return null;

  let url: string | undefined;
  if (typeof source.url === 'string') {
    url = source.url;
  } else if (typeof source.git === 'string') {
    url = source.git;
  } else if (typeof source.github === 'string') {
    url = githubCloneUrl(source.github);
  } else if (source.source === 'github' && typeof source.repo === 'string') {
    url = githubCloneUrl(source.repo);
  }
  if (!url) return null;

  return {
    url: normalizeCloneUrl(url, resolution.marketplaceRoot),
    subdir: typeof source.path === 'string' ? source.path : undefined,
  };
}

function githubCloneUrl(value: string): string | undefined {
  if (!value.includes('/')) return undefined;
  const url =
    /^(https?|ssh|git):\/\//.test(value) || /^[^@/\s]+@[^:\s]+:.+/.test(value)
      ? value
      : `https://github.com/${value}`;
  return url.endsWith('.git') ? url : `${url}.git`;
}

function normalizeCloneUrl(value: string, marketplaceRoot: string): string {
  const expanded = expandHome(value.trim());
  if (/^(https?|ssh|git):\/\//.test(expanded) || /^[^@/\s]+@[^:\s]+:.+/.test(expanded)) {
    return expanded;
  }
  if (expanded.startsWith('file://')) return fileURLToPath(expanded);
  if (path.isAbsolute(expanded)) return expanded;
  if (expanded.startsWith('./') || expanded.startsWith('../') || expanded.endsWith('.git')) {
    return path.resolve(marketplaceRoot, expanded);
  }
  return expanded;
}

function sourceString(source: string | Record<string, unknown>, key: string): string | undefined {
  if (typeof source === 'string') return undefined;
  return typeof source[key] === 'string' ? source[key] : undefined;
}

function canReuseMarketplaceCheckout(
  resolution: MarketplacePluginResolution,
  sourceUrl: string
): boolean {
  const origin = getGitOrigin(resolution.marketplaceRoot);
  if (!origin) return false;
  if (
    normalizeGitIdentity(origin, resolution.marketplaceRoot) !==
    normalizeGitIdentity(sourceUrl, resolution.marketplaceRoot)
  ) {
    return false;
  }

  const head = tryRunGit(['rev-parse', 'HEAD'], resolution.marketplaceRoot);
  if (!head) return false;
  if (
    resolution.sha &&
    (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(resolution.sha) ||
      head.toLowerCase() !== resolution.sha.toLowerCase())
  ) {
    return false;
  }
  if (!resolution.ref) return true;
  if (!isValidGitRef(resolution.ref)) return false;

  const remoteRef = remoteTrackingRef(resolution.ref);
  const refCommit =
    (remoteRef
      ? tryRunGit(['rev-parse', `${remoteRef}^{commit}`], resolution.marketplaceRoot)
      : null) ?? tryRunGit(['rev-parse', `${resolution.ref}^{commit}`], resolution.marketplaceRoot);
  return refCommit === head;
}

function remoteTrackingRef(ref: string): string | null {
  if (ref.startsWith('refs/remotes/origin/')) return ref;
  if (ref.startsWith('refs/heads/')) {
    return `refs/remotes/origin/${ref.slice('refs/heads/'.length)}`;
  }
  if (ref.startsWith('refs/')) return null;
  return `refs/remotes/origin/${ref}`;
}

function reusablePathsAreClean(
  resolution: MarketplacePluginResolution,
  checkoutRoot: string,
  pluginPath: string
): boolean {
  if (!resolution.ref && !resolution.sha) return true;
  const pathspecs = new Set<string>();
  for (const candidate of [resolution.marketplaceRoot, pluginPath]) {
    const relative = path.relative(checkoutRoot, normalizeLocalGitPath(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    pathspecs.add(relative || '.');
  }
  const status = tryRunGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--', ...pathspecs],
    checkoutRoot
  );
  if (status !== '') return false;
  const indexState = tryRunGit(['ls-files', '-v', '-z', '--', ...pathspecs], checkoutRoot);
  return (
    indexState !== null &&
    !indexState.split('\0').some((entry) => entry !== '' && /^[a-zS] /.test(entry))
  );
}

function isValidGitRef(ref: string): boolean {
  if (ref.startsWith('-')) return false;
  try {
    runGit(['check-ref-format', '--allow-onelevel', ref]);
    return true;
  } catch {
    return false;
  }
}

function getGitOrigin(repoDir: string): string | null {
  return tryRunGit(['config', '--get', 'remote.origin.url'], repoDir);
}

function getGitCheckoutRoot(repoDir: string): string | null {
  const root = tryRunGit(['rev-parse', '--show-toplevel'], repoDir);
  return root ? normalizeLocalGitPath(root) : null;
}

function tryRunGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, { cwd });
  } catch {
    return null;
  }
}

function normalizeGitIdentity(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('file://')) {
    return normalizeLocalGitPath(fileURLToPath(trimmed));
  }
  if (path.isAbsolute(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return normalizeLocalGitPath(path.resolve(cwd, trimmed));
  }

  const scp = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2])}`;

  try {
    const url = new URL(trimmed);
    const authority = url.port
      ? `${url.hostname.toLowerCase()}:${url.port}`
      : url.hostname.toLowerCase();
    return `${authority}/${stripGitSuffix(url.pathname)}`;
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function normalizeLocalGitPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

function resolveInside(root: string, subpath: string): string | null {
  const resolved = path.resolve(root, subpath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  try {
    const rootReal = fs.realpathSync(root);
    const resolvedReal = fs.realpathSync(resolved);
    const realRelative = path.relative(rootReal, resolvedReal);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function runGit(args: string[], options?: { cwd?: string }): string {
  return execFileSync('git', args, {
    ...options,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 120_000,
  }).trim();
}

// ── Plugin manifest ────────────────────────────────────────────────

export function readPluginManifest(
  pluginDir: string,
  nativeTarget?: NativePluginTarget
): PluginManifest | null {
  const manifestInfo = getPluginManifestInfo(pluginDir, nativeTarget);
  if (!manifestInfo) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, 'utf-8'));
    return pluginManifestSchema.parse(raw);
  } catch {
    return null;
  }
}
