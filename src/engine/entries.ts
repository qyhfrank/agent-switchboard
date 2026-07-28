import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Homes } from './config.js';
import { authenticatedGitEnv, credentialFreeGitUrl, runGit } from './git.js';

/**
 * Derived cache for external marketplace entries: a plugin a marketplace
 * declares but does not carry, living in its own repository. Entries are
 * rebuildable machine-local state, so they live under the cache root asb owns
 * exclusively and never in the synchronized home.
 *
 * Layout (frozen 0.4.35):
 *   <cacheHome>/.entries/<source>-<10 hex>/<plugin>-<16 hex>/{entry.json, repo/}
 * The hashes are identities, not shortenings: the source hash covers the
 * source name and the canonical marketplace path, the entry hash additionally
 * covers the credential-free URL, ref, sha and subdir. A pin that changes
 * lands in a different directory, so a stale generation is never reused.
 */

export interface EntryRequest {
  sourceName: string;
  marketplacePath: string;
  pluginName: string;
  url: string;
  ref?: string;
  sha?: string;
  subdir?: string;
}

export interface EntryMaterialization {
  identity: string;
  entryPath: string;
  repoPath: string;
  pluginPath: string;
  commit: string;
}

interface EntryMetadata {
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

/** The reserved dot-prefixed subtree; a managed source namespace can never collide with it. */
export function entriesRoot(homes: Homes): string {
  return path.join(homes.cacheHome, '.entries');
}

/**
 * Ownership is a symlink check on the cache root itself and nothing above it:
 * asb creates, replaces and recursively deletes whole subtrees under this
 * root, while its ancestors belong to the platform or the user.
 */
export function isCacheRootOwned(homes: Homes): boolean {
  return !fs.lstatSync(homes.cacheHome, { throwIfNoEntry: false })?.isSymbolicLink();
}

export function assertCacheRootOwned(homes: Homes): void {
  if (!isCacheRootOwned(homes)) {
    throw new Error(`ASB cache root contains a symbolic link: ${homes.cacheHome}`);
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

export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Canonical form of a path whose leaf may no longer exist. */
export function canonicalMissingPath(value: string): string {
  const resolved = path.resolve(value);
  const missing: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
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

function normalizeRequest(request: EntryRequest): EntryRequest {
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
    // A leading dash would be read as an option and a remote-tracking ref is
    // not a thing a manifest may pin.
    if (ref.startsWith('-') || ref.startsWith('refs/remotes/')) {
      throw new Error(`Invalid marketplace plugin ref: ${ref}`);
    }
    try {
      runGit(['check-ref-format', ref.startsWith('refs/') ? ref : `refs/heads/${ref}`]);
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

function requestIdentity(request: EntryRequest): string {
  return digest(
    JSON.stringify({
      sourceName: request.sourceName,
      marketplacePath: request.marketplacePath,
      pluginName: request.pluginName,
      url: credentialFreeGitUrl(request.url),
      ref: request.ref ?? null,
      sha: request.sha ?? null,
      subdir: request.subdir ?? null,
    })
  );
}

function sourceCachePath(sourceName: string, marketplacePath: string, cacheRoot: string): string {
  const normalized = sourceName.trim();
  const ownerIdentity = digest(
    JSON.stringify({ sourceName: normalized, marketplacePath: canonicalPath(marketplacePath) })
  );
  return path.join(cacheRoot, `${safeSegment(normalized)}-${ownerIdentity.slice(0, 10)}`);
}

function entryCachePath(request: EntryRequest, identity: string, cacheRoot: string): string {
  return path.join(
    sourceCachePath(request.sourceName, request.marketplacePath, cacheRoot),
    `${safeSegment(request.pluginName)}-${identity.slice(0, 16)}`
  );
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Marketplace cache path escapes its root: ${target}`);
  }
}

/** Every segment from the root down, so no delete follows a link out of the tree. */
function assertNoCacheSymlinks(root: string, target: string): void {
  assertInside(root, target);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Marketplace cache path contains a symbolic link: ${current}`);
    }
  }
}

function safeCacheRoot(homes: Homes, create: boolean): string {
  // The cache home carries the entry root, so a link at either one would
  // redirect every write and every recursive delete outside asb's tree.
  assertCacheRootOwned(homes);
  const cacheRoot = entriesRoot(homes);
  if (fs.lstatSync(cacheRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Marketplace cache root contains a symbolic link: ${cacheRoot}`);
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
  assertInside(fs.realpathSync.native(root), fs.realpathSync.native(resolved));
  return resolved;
}

/** No ref pins HEAD (or the sha itself); a short ref prefers a branch, then a tag. */
function fetchTargets(ref: string | undefined, sha: string | undefined): string[] {
  if (!ref) return [sha ?? 'HEAD'];
  if (ref === 'HEAD' || ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`];
}

function checkoutRequest(
  request: EntryRequest,
  repoPath: string
): { commit: string; pluginPath: string } {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(['init'], { cwd: repoPath });
  const persistedUrl = credentialFreeGitUrl(request.url);
  const env = authenticatedGitEnv(request.url, persistedUrl);
  runGit(['remote', 'add', 'origin', persistedUrl], { cwd: repoPath });

  let fetchError: unknown;
  for (const target of fetchTargets(request.ref, request.sha)) {
    const fetchArgs = ['fetch', '--depth', '1'];
    if (request.subdir) fetchArgs.push('--filter=blob:none');
    fetchArgs.push('origin', target);
    try {
      runGit(fetchArgs, { cwd: repoPath, env, sensitiveUrls: [request.url] });
      fetchError = undefined;
      break;
    } catch (error) {
      fetchError = error;
    }
  }
  if (fetchError) throw fetchError;

  const commit = runGit(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: repoPath });
  fs.rmSync(path.join(repoPath, '.git', 'FETCH_HEAD'), { force: true });
  if (request.sha && commit !== request.sha) {
    throw new Error(
      `Marketplace plugin pin mismatch: ${request.ref ?? 'fetched commit'} resolved to ${commit}, expected ${request.sha}.`
    );
  }

  if (request.subdir) {
    runGit(['sparse-checkout', 'init', '--cone'], { cwd: repoPath });
    runGit(['sparse-checkout', 'set', '--', request.subdir], { cwd: repoPath });
  }
  runGit(['checkout', '--detach', commit], { cwd: repoPath });

  return { commit, pluginPath: resolveInside(repoPath, request.subdir) };
}

function readMetadata(entryPath: string): EntryMetadata | null {
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
    return value as EntryMetadata;
  } catch {
    return null;
  }
}

/** A cached entry counts only if its metadata, checkout, commit and origin all still agree. */
function cachedMaterialization(
  request: EntryRequest,
  identity: string,
  entryPath: string,
  cacheRoot: string
): EntryMaterialization | null {
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
    assertNoCacheSymlinks(cacheRoot, path.join(repoPath, '.git'));
    if (runGit(['rev-parse', 'HEAD'], { cwd: repoPath }) !== metadata.commit) return null;
    if (
      runGit(['remote', 'get-url', 'origin'], { cwd: repoPath }) !==
      credentialFreeGitUrl(request.url)
    ) {
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

/** Rename the old generation aside, swap the new one in, and restore it if that fails. */
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
  request: EntryRequest,
  keepIdentity: string,
  cacheRoot: string
): void {
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath, cacheRoot);
  if (!fs.existsSync(sourcePath)) return;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const entryPath = path.join(sourcePath, entry.name);
    const metadata = readMetadata(entryPath);
    if (metadata?.pluginName !== request.pluginName || metadata.identity === keepIdentity) continue;
    assertNoCacheSymlinks(cacheRoot, entryPath);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
}

/**
 * The predecessor cache inside the synchronized home. asb 0.5 never writes
 * here; it consumes what a 0.4 peer left, and only once the replacement is
 * verified usable, so a mid-migration user does not keep a stale tree forever.
 */
function legacyCacheRoot(homes: Homes): string {
  return path.join(homes.asbHome, 'state', 'marketplace-plugins');
}

/** The marketplace paths a legacy entry could have been recorded under. */
function legacyOwnerPaths(homes: Homes, request: EntryRequest): string[] {
  const owners = [request.marketplacePath];
  const managedDir = canonicalMissingPath(path.join(homes.cacheHome, request.sourceName));
  const relative = path.relative(managedDir, request.marketplacePath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    owners.push(
      canonicalMissingPath(path.join(homes.asbHome, 'plugins', request.sourceName, relative))
    );
  }
  return owners;
}

function retireLegacyEntries(homes: Homes, request: EntryRequest): void {
  const cacheRoot = legacyCacheRoot(homes);
  const rootStat = fs.lstatSync(cacheRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return;

  for (const owner of new Set(legacyOwnerPaths(homes, request))) {
    const sourcePath = sourceCachePath(request.sourceName, owner, cacheRoot);
    const sourceStat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) continue;
    assertNoCacheSymlinks(cacheRoot, sourcePath);

    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const entryPath = path.join(sourcePath, entry.name);
      const metadata = readMetadata(entryPath);
      if (
        metadata?.sourceName !== request.sourceName ||
        metadata.pluginName !== request.pluginName ||
        metadata.marketplacePath !== owner
      ) {
        continue;
      }
      // Retire only a predecessor that still verifies as itself: an
      // unverifiable one may hold something asb did not put there.
      const legacyRequest: EntryRequest = {
        ...request,
        marketplacePath: metadata.marketplacePath,
        ref: metadata.ref,
        sha: metadata.sha,
        subdir: metadata.subdir,
      };
      const identity = requestIdentity(legacyRequest);
      if (cachedMaterialization(legacyRequest, identity, entryPath, cacheRoot) === null) continue;
      fs.rmSync(entryPath, { recursive: true, force: true });
    }

    if (fs.readdirSync(sourcePath).length === 0) fs.rmdirSync(sourcePath);
  }
}

export function materializeEntry(
  homes: Homes,
  input: EntryRequest,
  options: { refresh?: boolean } = {}
): EntryMaterialization {
  const request = normalizeRequest(input);
  const identity = requestIdentity(request);
  const cacheRoot = safeCacheRoot(homes, true);
  const sourcePath = sourceCachePath(request.sourceName, request.marketplacePath, cacheRoot);
  const entryPath = entryCachePath(request, identity, cacheRoot);
  assertNoCacheSymlinks(cacheRoot, sourcePath);
  fs.mkdirSync(sourcePath, { recursive: true });
  assertNoCacheSymlinks(cacheRoot, entryPath);

  // A sha pin names one immutable commit, so a cached generation under that
  // identity is reused even when the caller asked for a refresh.
  const cached = cachedMaterialization(request, identity, entryPath, cacheRoot);
  if (cached && (!options.refresh || request.sha)) {
    retireLegacyEntries(homes, request);
    return cached;
  }

  const tempPath = fs.mkdtempSync(path.join(sourcePath, '.tmp-'));
  try {
    const checkout = checkoutRequest(request, path.join(tempPath, 'repo'));
    const metadata: EntryMetadata = {
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
    removeSupersededPluginEntries(request, identity, cacheRoot);

    // Verify what actually landed, not what was intended.
    const materialized = cachedMaterialization(request, identity, entryPath, cacheRoot);
    if (!materialized) throw new Error(`Marketplace cache verification failed: ${entryPath}`);
    retireLegacyEntries(homes, request);
    return materialized;
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true });
  }
}

/** Read a cached entry without any network work; `null` when it is not materialized. */
export function cachedEntry(homes: Homes, input: EntryRequest): EntryMaterialization | null {
  if (!isCacheRootOwned(homes)) return null;
  let request: EntryRequest;
  try {
    request = normalizeRequest(input);
  } catch {
    return null;
  }
  const cacheRoot = entriesRoot(homes);
  const identity = requestIdentity(request);
  return cachedMaterialization(
    request,
    identity,
    entryCachePath(request, identity, cacheRoot),
    cacheRoot
  );
}

export function removeEntryCache(homes: Homes, sourceName: string, marketplacePath: string): void {
  if (!isCacheRootOwned(homes)) return;
  const cacheRoot = safeCacheRoot(homes, false);
  const sourcePath = sourceCachePath(sourceName, marketplacePath, cacheRoot);
  if (!fs.existsSync(sourcePath)) return;
  assertNoCacheSymlinks(cacheRoot, sourcePath);
  fs.rmSync(sourcePath, { recursive: true, force: true });
}

export function removeEntryCachesForSource(homes: Homes, sourceName: string): void {
  if (!isCacheRootOwned(homes)) return;
  const cacheRoot = safeCacheRoot(homes, false);
  if (!fs.existsSync(cacheRoot)) return;
  const normalizedSourceName = sourceName.trim();

  for (const sourceEntry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    const sourcePath = path.join(cacheRoot, sourceEntry.name);
    if (sourceEntry.isSymbolicLink()) {
      throw new Error(`Marketplace cache path contains a symbolic link: ${sourcePath}`);
    }
    if (!sourceEntry.isDirectory()) continue;
    assertNoCacheSymlinks(cacheRoot, sourcePath);

    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(sourcePath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Marketplace cache path contains a symbolic link: ${entryPath}`);
      }
      if (!entry.isDirectory()) continue;
      assertNoCacheSymlinks(cacheRoot, entryPath);
      if (readMetadata(entryPath)?.sourceName !== normalizedSourceName) continue;
      fs.rmSync(entryPath, { recursive: true, force: true });
    }

    if (fs.readdirSync(sourcePath).length === 0) fs.rmdirSync(sourcePath);
  }
}

/**
 * Refresh the entries a source still declares and drop the ones it no longer
 * does. Only already-materialized plugins are touched: refreshing is
 * maintenance of what is cached, never a reason to fetch something new.
 */
export function refreshEntryCache(
  homes: Homes,
  sourceName: string,
  marketplacePath: string,
  currentRequests: readonly EntryRequest[]
): { refreshed: number; removed: number } {
  if (!isCacheRootOwned(homes)) return { refreshed: 0, removed: 0 };
  const cacheRoot = safeCacheRoot(homes, false);
  const canonicalMarketplacePath = canonicalPath(marketplacePath);
  const sourcePath = sourceCachePath(sourceName, canonicalMarketplacePath, cacheRoot);
  if (!fs.existsSync(sourcePath)) return { refreshed: 0, removed: 0 };
  assertNoCacheSymlinks(cacheRoot, sourcePath);

  const requests = new Map<string, EntryRequest>();
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
    materializeEntry(homes, request, { refresh: true });
    refreshedPlugins.add(request.pluginName);
    refreshed++;
  }

  return { refreshed, removed };
}
