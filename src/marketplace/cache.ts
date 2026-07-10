import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfigDir, getMarketplacePluginCacheDir } from '../config/paths.js';

export interface MarketplaceEntryCacheRequest {
  sourceName: string;
  marketplacePath: string;
  pluginName: string;
  url: string;
  ref?: string;
  sha?: string;
  subdir?: string;
}

export interface MarketplaceEntryMaterialization {
  identity: string;
  entryPath: string;
  repoPath: string;
  pluginPath: string;
  commit: string;
}

export interface MarketplaceEntryCacheRefreshResult {
  refreshed: number;
  removed: number;
}

interface MarketplaceEntryCacheMetadata {
  version: 1;
  identity: string;
  sourceName: string;
  marketplacePath: string;
  pluginName: string;
  ref?: string;
  sha?: string;
  subdir?: string;
  commit: string;
}

const METADATA_FILE = 'entry.json';
const temporaryCacheRoot = new AsyncLocalStorage<string>();

function configuredCacheRoot(): string {
  return temporaryCacheRoot.getStore() ?? getMarketplacePluginCacheDir();
}

function runGit(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
  } catch (error) {
    const execError = error as { stderr?: Buffer | string };
    const stderr =
      typeof execError.stderr === 'string'
        ? execError.stderr.trim()
        : (execError.stderr?.toString().trim() ?? '');
    throw new Error(
      `git ${args[0]} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`
    );
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: string): string {
  return (value.replace(/[^a-zA-Z0-9_-]/g, '-') || 'entry').slice(0, 48);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSubdir(value: string | undefined): string | undefined {
  const trimmed = optionalTrimmed(value)?.replaceAll('\\', '/');
  if (!trimmed || trimmed === '.') return undefined;
  if (
    path.posix.isAbsolute(trimmed) ||
    trimmed.startsWith('//') ||
    /^[a-zA-Z]:\//.test(trimmed) ||
    trimmed.includes('\0')
  ) {
    throw new Error(`Marketplace plugin subdirectory must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Marketplace plugin subdirectory escapes the repository: ${value}`);
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeRequest(request: MarketplaceEntryCacheRequest): MarketplaceEntryCacheRequest {
  const sourceName = request.sourceName.trim();
  const marketplacePath = canonicalPath(request.marketplacePath);
  const pluginName = request.pluginName.trim();
  const url = request.url.trim();
  if (!sourceName || !marketplacePath || !pluginName || !url) {
    throw new Error(
      'Marketplace cache source name, marketplace path, plugin name, and URL must be non-empty.'
    );
  }
  const ref = optionalTrimmed(request.ref);
  const sha = optionalTrimmed(request.sha)?.toLowerCase();
  if (ref) {
    if (ref.startsWith('-')) throw new Error(`Invalid marketplace plugin ref: ${ref}`);
    try {
      runGit(['check-ref-format', '--allow-onelevel', ref]);
    } catch {
      throw new Error(`Invalid marketplace plugin ref: ${ref}`);
    }
  }
  if (sha && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`Marketplace plugin SHA must be a full 40- or 64-character object ID: ${sha}`);
  }
  return {
    sourceName,
    marketplacePath,
    pluginName,
    url,
    ref,
    sha,
    subdir: normalizeSubdir(request.subdir),
  };
}

function requestIdentity(request: MarketplaceEntryCacheRequest): string {
  return digest(
    JSON.stringify({
      sourceName: request.sourceName,
      marketplacePath: request.marketplacePath,
      pluginName: request.pluginName,
      url: request.url,
      ref: request.ref ?? null,
      sha: request.sha ?? null,
      subdir: request.subdir ?? null,
    })
  );
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sourceCachePath(sourceName: string, marketplacePath: string): string {
  const normalized = sourceName.trim();
  const ownerIdentity = digest(
    JSON.stringify({ sourceName: normalized, marketplacePath: canonicalPath(marketplacePath) })
  );
  return path.join(
    configuredCacheRoot(),
    `${safeSegment(normalized)}-${ownerIdentity.slice(0, 10)}`
  );
}

function entryCachePath(request: MarketplaceEntryCacheRequest, identity: string): string {
  return path.join(
    sourceCachePath(request.sourceName, request.marketplacePath),
    `${safeSegment(request.pluginName)}-${identity.slice(0, 16)}`
  );
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Marketplace cache path escapes its root: ${target}`);
  }
}

function assertNoCacheSymlinks(root: string, target: string): void {
  assertInside(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Marketplace cache path contains a symbolic link: ${current}`);
    }
  }
}

function safeCacheRoot(create: boolean): string {
  const override = temporaryCacheRoot.getStore();
  const trustedRoot = path.resolve(override ? path.dirname(override) : getConfigDir());
  const cacheRoot = path.resolve(configuredCacheRoot());
  assertInside(trustedRoot, cacheRoot);
  let current = trustedRoot;
  for (const segment of path.relative(trustedRoot, cacheRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Marketplace cache root contains a symbolic link: ${current}`);
    }
  }
  if (create) fs.mkdirSync(cacheRoot, { recursive: true });
  return cacheRoot;
}

function resolveInside(root: string, subdir: string | undefined): string {
  if (!subdir) return root;
  const resolved = path.resolve(root, subdir);
  assertInside(root, resolved);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Marketplace plugin subdirectory was not found after checkout: ${subdir}`);
  }
  const rootReal = fs.realpathSync.native(root);
  const resolvedReal = fs.realpathSync.native(resolved);
  assertInside(rootReal, resolvedReal);
  return resolved;
}

function credentialFreeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

function checkoutRequest(
  request: MarketplaceEntryCacheRequest,
  repoPath: string
): { commit: string; pluginPath: string } {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(['init'], repoPath);
  runGit(['remote', 'add', 'origin', request.url], repoPath);

  const target = request.ref ?? request.sha ?? 'HEAD';
  const fetchArgs = ['fetch', '--depth', '1'];
  if (request.subdir) fetchArgs.push('--filter=blob:none');
  fetchArgs.push('origin', target);
  runGit(fetchArgs, repoPath);
  const commit = runGit(['rev-parse', 'FETCH_HEAD^{commit}'], repoPath);
  if (request.sha && commit !== request.sha) {
    throw new Error(
      `Marketplace plugin pin mismatch: ${request.ref ?? 'fetched commit'} resolved to ${commit}, expected ${request.sha}.`
    );
  }

  if (request.subdir) {
    runGit(['sparse-checkout', 'init', '--cone'], repoPath);
    runGit(['sparse-checkout', 'set', '--', request.subdir], repoPath);
  }
  runGit(['checkout', '--detach', commit], repoPath);
  runGit(['remote', 'set-url', 'origin', credentialFreeUrl(request.url)], repoPath);

  return { commit, pluginPath: resolveInside(repoPath, request.subdir) };
}

function readMetadata(entryPath: string): MarketplaceEntryCacheMetadata | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(entryPath, METADATA_FILE), 'utf-8'));
    if (
      value?.version !== 1 ||
      typeof value.identity !== 'string' ||
      typeof value.sourceName !== 'string' ||
      typeof value.marketplacePath !== 'string' ||
      typeof value.pluginName !== 'string' ||
      typeof value.commit !== 'string'
    ) {
      return null;
    }
    return value as MarketplaceEntryCacheMetadata;
  } catch {
    return null;
  }
}

function cachedMaterialization(
  request: MarketplaceEntryCacheRequest,
  identity: string,
  entryPath: string
): MarketplaceEntryMaterialization | null {
  const metadata = readMetadata(entryPath);
  const repoPath = path.join(entryPath, 'repo');
  if (
    metadata?.identity !== identity ||
    metadata.sourceName !== request.sourceName ||
    metadata.marketplacePath !== request.marketplacePath ||
    metadata.pluginName !== request.pluginName ||
    !fs.existsSync(path.join(repoPath, '.git'))
  ) {
    return null;
  }
  try {
    assertNoCacheSymlinks(configuredCacheRoot(), path.join(repoPath, '.git'));
    if (runGit(['rev-parse', 'HEAD'], repoPath) !== metadata.commit) return null;
    if (runGit(['remote', 'get-url', 'origin'], repoPath) !== credentialFreeUrl(request.url)) {
      return null;
    }
    return {
      identity,
      entryPath,
      repoPath,
      pluginPath: resolveInside(repoPath, request.subdir),
      commit: metadata.commit,
    };
  } catch {
    return null;
  }
}

function replaceEntry(tempPath: string, entryPath: string): void {
  const backupPath = path.join(path.dirname(entryPath), `.backup-${randomUUID()}`);
  const hadEntry = fs.existsSync(entryPath);
  if (hadEntry) fs.renameSync(entryPath, backupPath);
  try {
    fs.renameSync(tempPath, entryPath);
    if (hadEntry) fs.rmSync(backupPath, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(entryPath)) fs.rmSync(entryPath, { recursive: true, force: true });
    if (hadEntry && fs.existsSync(backupPath)) fs.renameSync(backupPath, entryPath);
    throw error;
  }
}

function removeSupersededPluginEntries(
  request: MarketplaceEntryCacheRequest,
  keepIdentity: string
): void {
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath);
  if (!fs.existsSync(sourcePath)) return;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    const metadata = readMetadata(entryPath);
    if (metadata?.pluginName !== request.pluginName || metadata.identity === keepIdentity) continue;
    assertNoCacheSymlinks(configuredCacheRoot(), entryPath);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
}

export function materializeMarketplaceEntry(
  input: MarketplaceEntryCacheRequest,
  options: { refresh?: boolean } = {}
): MarketplaceEntryMaterialization {
  const request = normalizeRequest(input);
  const identity = requestIdentity(request);
  const cacheRoot = safeCacheRoot(true);
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath);
  const entryPath = entryCachePath(request, identity);
  assertNoCacheSymlinks(cacheRoot, sourcePath);
  fs.mkdirSync(sourcePath, { recursive: true });
  assertNoCacheSymlinks(cacheRoot, entryPath);

  const cached = cachedMaterialization(request, identity, entryPath);
  if (cached && (!options.refresh || request.sha)) return cached;

  const tempPath = fs.mkdtempSync(path.join(sourcePath, '.tmp-'));
  try {
    const repoPath = path.join(tempPath, 'repo');
    const checkout = checkoutRequest(request, repoPath);
    const metadata: MarketplaceEntryCacheMetadata = {
      version: 1,
      identity,
      sourceName: request.sourceName,
      marketplacePath: request.marketplacePath,
      pluginName: request.pluginName,
      ref: request.ref,
      sha: request.sha,
      subdir: request.subdir,
      commit: checkout.commit,
    };
    fs.writeFileSync(path.join(tempPath, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    replaceEntry(tempPath, entryPath);
    removeSupersededPluginEntries(request, identity);

    const materialized = cachedMaterialization(request, identity, entryPath);
    if (!materialized) throw new Error(`Marketplace cache verification failed: ${entryPath}`);
    return materialized;
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true });
  }
}

export function removeMarketplaceEntryCache(sourceName: string, marketplacePath: string): void {
  const cacheRoot = safeCacheRoot(false);
  const sourcePath = sourceCachePath(sourceName, marketplacePath);
  if (!fs.existsSync(sourcePath)) return;
  assertNoCacheSymlinks(cacheRoot, sourcePath);
  fs.rmSync(sourcePath, { recursive: true, force: true });
}

export function refreshMarketplaceEntryCache(
  sourceName: string,
  marketplacePath: string,
  currentRequests: MarketplaceEntryCacheRequest[]
): MarketplaceEntryCacheRefreshResult {
  const cacheRoot = safeCacheRoot(false);
  const canonicalMarketplacePath = canonicalPath(marketplacePath);
  const sourcePath = sourceCachePath(sourceName, canonicalMarketplacePath);
  if (!fs.existsSync(sourcePath)) return { refreshed: 0, removed: 0 };
  assertNoCacheSymlinks(cacheRoot, sourcePath);

  const requests = new Map<string, MarketplaceEntryCacheRequest>();
  for (const input of currentRequests) {
    const request = normalizeRequest(input);
    if (
      request.sourceName !== sourceName.trim() ||
      request.marketplacePath !== canonicalMarketplacePath
    ) {
      throw new Error('Marketplace cache refresh request does not match its source owner.');
    }
    requests.set(request.pluginName, request);
  }

  let refreshed = 0;
  let removed = 0;
  const refreshedPlugins = new Set<string>();
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    if (!fs.existsSync(entryPath)) continue;
    assertNoCacheSymlinks(cacheRoot, entryPath);
    const metadata = readMetadata(entryPath);
    const request = metadata ? requests.get(metadata.pluginName) : undefined;
    if (!request) {
      fs.rmSync(entryPath, { recursive: true, force: true });
      removed++;
      continue;
    }
    if (refreshedPlugins.has(request.pluginName)) continue;
    materializeMarketplaceEntry(request, { refresh: true });
    refreshedPlugins.add(request.pluginName);
    refreshed++;
  }

  return { refreshed, removed };
}

export async function withTemporaryMarketplaceEntryCache<T>(action: () => Promise<T>): Promise<T> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-marketplace-cache-'));
  try {
    return await temporaryCacheRoot.run(path.join(tempRoot, 'marketplace-plugins'), action);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
