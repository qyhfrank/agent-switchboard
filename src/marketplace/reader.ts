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
  withMarketplaceSourceReadLease,
} from './cache.js';
import { normalizeMarketplaceGitRef } from './git-ref.js';
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

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    );
  }
  return value;
}

function marketplaceEntryFingerprint(
  manifest: MarketplaceManifest,
  nativeTarget: NativePluginTarget,
  entry: PluginEntry
): string {
  return stableJson({
    name: manifest.name,
    owner: manifest.owner,
    metadata: manifest.metadata,
    nativeTarget,
    entry,
  });
}

function currentMarketplaceEntryFingerprint(localPath: string, pluginName: string): string | null {
  try {
    const manifestInfo = getMarketplaceManifestInfo(localPath);
    if (!manifestInfo) return null;
    const raw = JSON.parse(fs.readFileSync(manifestInfo.manifestPath, 'utf-8'));
    const manifest = marketplaceManifestSchema.parse(raw);
    const entries = manifest.plugins.filter((entry) => entry.name === pluginName);
    if (entries.length !== 1) return null;
    return marketplaceEntryFingerprint(manifest, manifestInfo.nativeTarget, entries[0]);
  } catch {
    return null;
  }
}

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
    };
    const entryFingerprint = marketplaceEntryFingerprint(
      manifest,
      manifestInfo.nativeTarget,
      entry
    );
    resolution.ownerIsCurrent = () =>
      (!ownerIsCurrent || ownerIsCurrent()) &&
      currentMarketplaceEntryFingerprint(localPath, entry.name) === entryFingerprint;
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
      return resolveSourceCheckoutPath(resolution, path.join(pluginRoot, source));
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
    return resolveSourceCheckoutPath(resolution, path.join(pluginRoot, source.path));
  }

  const gitSource = getGitSource(resolution);
  if (gitSource) {
    const reused = withMarketplaceSourceReadLease(
      resolution.sourceName,
      resolution.marketplaceRoot,
      resolution.ownerIsCurrent,
      () => {
        if (!canReuseMarketplaceCheckout(resolution, gitSource.url, materializeRemote)) return null;
        const checkoutRoot = getGitCheckoutRoot(marketplaceRoot);
        if (!checkoutRoot) return null;
        const pluginPath = gitSource.subdir
          ? resolveInside(checkoutRoot, gitSource.subdir)
          : checkoutRoot;
        return pluginPath && reusablePathsAreClean(resolution, checkoutRoot, pluginPath)
          ? pluginPath
          : null;
      }
    );
    if (reused) return reused;
    if (!materializeRemote) return undefined;
    return materializeMarketplaceEntry(toCacheRequest(resolution, gitSource), {
      ownerIsCurrent: resolution.ownerIsCurrent,
    }).pluginPath;
  }

  // Keep native-only and currently unsupported source kinds in the catalog.
  // ASB reports a materialization failure only if portable expansion selects one.
  return materializeRemote ? null : undefined;
}

function resolveSourceCheckoutPath(
  resolution: MarketplacePluginResolution,
  subpath: string
): string | null | undefined {
  return withMarketplaceSourceReadLease(
    resolution.sourceName,
    resolution.marketplaceRoot,
    resolution.ownerIsCurrent,
    () => resolveInside(resolution.marketplaceRoot, subpath)
  );
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
    /^(https?|ssh|git):\/\//.test(value) || isScpGitUrl(value)
      ? value
      : `https://github.com/${value}`;
  return url.endsWith('.git') ? url : `${url}.git`;
}

function normalizeCloneUrl(value: string, marketplaceRoot: string): string {
  const expanded = expandHome(value.trim());
  if (/^(https?|ssh|git):\/\//.test(expanded) || isScpGitUrl(expanded)) {
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
  sourceUrl: string,
  materializeRemote: boolean
): boolean {
  const checkoutRoot = getGitCheckoutRoot(resolution.marketplaceRoot);
  if (!checkoutRoot) return false;
  const origin = getGitOrigin(resolution.marketplaceRoot);
  if (!origin) return false;
  if (
    normalizeGitIdentity(origin, checkoutRoot) !==
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
  if (!resolution.ref) {
    if (resolution.sha) return true;
    const remoteHead = liveRemoteCheckoutRef(resolution.marketplaceRoot, 'HEAD');
    return checkoutMatchesLiveRemote(checkoutRoot, head, remoteHead);
  }
  let normalizedRef: string;
  try {
    normalizedRef = normalizeMarketplaceGitRef(resolution.ref) as string;
  } catch {
    return false;
  }
  const remoteRef = liveRemoteCheckoutRef(resolution.marketplaceRoot, normalizedRef);
  if (checkoutMatchesLiveRemote(checkoutRoot, head, remoteRef)) return true;
  return (
    remoteRef === null &&
    !materializeRemote &&
    localGitSourceIsUnavailable(sourceUrl, resolution.marketplaceRoot) &&
    checkoutMatchesOfflineBranch(checkoutRoot, head, normalizedRef)
  );
}

interface LiveRemoteCheckoutRef {
  commit: string;
  branch?: string;
}

function liveRemoteCheckoutRef(repoDir: string, ref: string): LiveRemoteCheckoutRef | null {
  if (ref === 'HEAD') {
    const output = tryRunGit(['ls-remote', '--symref', 'origin', 'HEAD'], repoDir);
    if (output === null) return null;
    const branch = output
      .split('\n')
      .map((line) => /^ref:\s+(\S+)\s+HEAD$/.exec(line)?.[1])
      .find((value): value is string => value !== undefined);
    const commit = listedRemoteCommit(output, 'HEAD');
    return branch && commit ? { branch, commit } : null;
  }

  if (!ref.startsWith('refs/')) {
    const branch = `refs/heads/${ref}`;
    const tag = `refs/tags/${ref}`;
    const output = tryRunGit(['ls-remote', 'origin', branch, tag, `${tag}^{}`], repoDir);
    if (output === null) return null;
    const branchCommit = listedRemoteCommit(output, branch);
    if (branchCommit) return { branch, commit: branchCommit };
    const tagCommit = listedRemoteCommit(output, `${tag}^{}`) ?? listedRemoteCommit(output, tag);
    return tagCommit ? { commit: tagCommit } : null;
  }

  const targets = ref.startsWith('refs/tags/') ? [ref, `${ref}^{}`] : [ref];
  const output = tryRunGit(['ls-remote', 'origin', ...targets], repoDir);
  if (output === null) return null;
  const commit = listedRemoteCommit(output, `${ref}^{}`) ?? listedRemoteCommit(output, ref);
  if (!commit) return null;
  return ref.startsWith('refs/heads/') ? { branch: ref, commit } : { commit };
}

function listedRemoteCommit(output: string, ref: string): string | undefined {
  for (const line of output.split('\n')) {
    const [commit, listedRef] = line.trim().split(/\s+/, 2);
    if (listedRef === ref && /^[0-9a-fA-F]{40,64}$/.test(commit)) return commit.toLowerCase();
  }
  return undefined;
}

function checkoutMatchesLiveRemote(
  checkoutRoot: string,
  head: string,
  remoteRef: LiveRemoteCheckoutRef | null
): boolean {
  if (!remoteRef || head.toLowerCase() !== remoteRef.commit) return false;
  if (!remoteRef.branch) return true;
  return tryRunGit(['symbolic-ref', '-q', 'HEAD'], checkoutRoot) === remoteRef.branch;
}

function localGitSourceIsUnavailable(sourceUrl: string, cwd: string): boolean {
  const identity = normalizeGitIdentity(sourceUrl, cwd);
  return path.isAbsolute(identity) && !fs.existsSync(identity);
}

function checkoutMatchesOfflineBranch(checkoutRoot: string, head: string, ref: string): boolean {
  const branch = ref.startsWith('refs/heads/')
    ? ref
    : !ref.startsWith('refs/') && ref !== 'HEAD'
      ? `refs/heads/${ref}`
      : undefined;
  if (!branch || tryRunGit(['symbolic-ref', '-q', 'HEAD'], checkoutRoot) !== branch) return false;
  const trackingRef = `refs/remotes/origin/${branch.slice('refs/heads/'.length)}`;
  return tryRunGit(['rev-parse', `${trackingRef}^{commit}`], checkoutRoot) === head;
}

function reusablePathsAreClean(
  resolution: MarketplacePluginResolution,
  checkoutRoot: string,
  pluginPath: string
): boolean {
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

  const scp = isScpGitUrl(trimmed) ? trimmed.match(/^(?:([^@/:\\\s]+)@)?([^:]+):(.+)$/) : null;
  if (scp) {
    const principal = scp[1] ? `${scp[1]}@` : '';
    return `ssh-scp://${principal}${scp[2].toLowerCase()}:${stripScpGitSuffix(scp[3])}`;
  }

  try {
    const url = new URL(trimmed);
    const principal = url.username ? `${url.username}@` : '';
    const authority = url.port
      ? `${url.hostname.toLowerCase()}:${url.port}`
      : url.hostname.toLowerCase();
    return `${url.protocol.toLowerCase()}//${principal}${authority}/${stripGitSuffix(url.pathname)}`;
  } catch {
    return stripGitSuffix(trimmed);
  }
}

function normalizeLocalGitPath(value: string): string {
  let current = path.resolve(value);
  const missingSegments: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...missingSegments);
  } catch {
    return path.resolve(value);
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

function stripScpGitSuffix(value: string): string {
  return value.replace(/\/+$/g, '').replace(/\.git$/, '');
}

function isScpGitUrl(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^(?:[^@/:\\\s]+@)?[^@/:\\\s]+:.+$/.test(value);
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
